import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, InvoiceItem, WaSentBy } from "@/lib/database.types";
import {
  isOpenAIConfigured,
  openaiChat,
  type ChatMessage,
  type ToolSchema,
} from "@/lib/ai/openai";
import { generateProposalContent } from "@/lib/ai/proposal";
import { runPageSpeed } from "@/lib/ai/pagespeed";
import {
  analyzeSeo,
  extractCopyrightYear,
  quickSiteVerdict,
} from "@/lib/ai/site-audit";
import { probeSite } from "@/lib/ai/site-probe";
import { appLink } from "@/lib/app-url";
import { enrollAutomationRun, fireAutomationTrigger } from "@/lib/automation";
import {
  buildPricing,
  defaultContent,
  defaultSelection,
  includedFeatures,
  money,
  selectionSummary,
  type ProposalSelection,
} from "@/lib/proposal";
import { sendPushToUser } from "@/lib/push";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone, SMS_MAX_LENGTH } from "@/lib/sms-utils";
import { checkEmail } from "@/lib/email-check";
import { queueLeadResearch } from "@/lib/research";
import { queueWaShowcase } from "@/lib/wa-showcase";
import { baseLanguage, isWaLanguage, WA_LANGUAGE_LABELS } from "@/lib/wa-lang";
import { WA_TOOL_CATALOG } from "@/lib/wa-tools-catalog";
import {
  formatWaPhone,
  markWhatsAppRead,
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type WaContact = Database["public"]["Tables"]["wa_contacts"]["Row"];
type WaConfig = Database["public"]["Tables"]["wa_agent_config"]["Row"];

/**
 * The WhatsApp sales agent — the brain behind the /whatsapp inbox.
 *
 * Flow for every inbound message (called by the webhook):
 *   1. keyword rules run first (instant replies, tags, handoff, automations)
 *   2. the `wa_message_received` automation trigger fires (CRM automations)
 *   3. unless a rule replied/handed off — and the agent is enabled both
 *      globally and for this contact — an agent run is QUEUED
 *      (wa_contacts.agent_due_at). The automation tick drains due runs, so
 *      a burst of messages collapses into ONE reply (each message pushes
 *      the timer) and long runs (site audits, tool rounds) can't be killed
 *      by the webhook's serverless budget. The agent answers 24/7; the
 *      instant blue-ticks + typing indicator bridge the short queue delay.
 *
 * Every tool invocation is written to wa_agent_logs so the team can audit
 * exactly what the agent did and when.
 */

const MAX_TOOL_ROUNDS = 5;
const HISTORY_MESSAGES = 30;

/** Debounce: each inbound message pushes the queued agent run this far out,
 * so a burst of texts gets ONE reply covering all of them. Kept short so the
 * agent feels responsive — the typing indicator covers the gap. */
const AGENT_DEBOUNCE_SECONDS = 8;
/** Lease: a claimed agent run that dies mid-flight (tick killed) retries
 * after this long instead of losing the reply. */
const AGENT_LEASE_MINUTES = 3;
/** Agent runs per tick — each can take ~20s+ (audit + tool rounds), so the
 * tick must stay inside its own serverless budget. */
const MAX_AGENT_RUNS_PER_TICK = 2;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getWaAgentConfig(supabase: DB): Promise<WaConfig> {
  const { data } = await supabase
    .from("wa_agent_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (data) return data;
  // Self-heal: the migration seeds this row, but never assume.
  const { data: created } = await supabase
    .from("wa_agent_config")
    .upsert({ id: 1 }, { onConflict: "id" })
    .select("*")
    .single();
  if (!created) throw new Error("wa_agent_config row is missing.");
  return created;
}

// ---------------------------------------------------------------------------
// Outbound helper — send + log in one place
// ---------------------------------------------------------------------------

/**
 * Send a WhatsApp text to a contact and record it in the inbox thread.
 * Used by the agent, keyword rules, manual team sends and automations.
 */
export async function sendAndLogWa(
  supabase: DB,
  opts: {
    contact: Pick<WaContact, "id" | "wa_id">;
    body: string;
    sentBy: WaSentBy;
    authorId?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const body = opts.body.trim();
  if (!body) return { ok: false, error: "Message is empty." };

  const sent = await sendWhatsAppText({ to: opts.contact.wa_id, body });

  await supabase.from("wa_messages").insert({
    contact_id: opts.contact.id,
    wa_message_id: sent.ok ? sent.waMessageId : null,
    direction: "out",
    body,
    status: sent.ok ? "sent" : "failed",
    error: sent.ok ? null : sent.error,
    sent_by: opts.sentBy,
    author_id: opts.authorId ?? null,
  });
  await supabase
    .from("wa_contacts")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: body.slice(0, 160),
      last_direction: "out",
    })
    .eq("id", opts.contact.id);

  // The agent's own outbound messages anchor the autonomous follow-up
  // cadence — the first unanswered agent message starts the clock. Team
  // manual sends never touch the schedule.
  if (sent.ok && opts.sentBy === "agent") {
    await scheduleNextFollowup(supabase, opts.contact.id);
  }

  // A human just replied from the inbox → hand the chat to the team: pause
  // the AI so it can't answer over them, and drop any reply already queued.
  // The AI stays off (also halting the autonomous follow-up/promise cadence,
  // which both skip when agent_enabled is false) until a teammate flips it
  // back on with the per-chat toggle. The inbox reflects this live via the
  // wa_contacts realtime sync.
  if (sent.ok && opts.sentBy === "team") {
    await supabase
      .from("wa_contacts")
      .update({ agent_enabled: false, agent_due_at: null })
      .eq("id", opts.contact.id);
  }

  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

// ---------------------------------------------------------------------------
// Inbound orchestration
// ---------------------------------------------------------------------------

/**
 * Handle one stored inbound message: keyword rules + automation triggers run
 * instantly, then an agent run is queued (debounced). Never throws — a
 * broken agent must not make the webhook fail (Meta would retry / disable it).
 */
export async function handleInboundWaMessage(
  supabase: DB,
  contact: WaContact,
  messageBody: string,
  waMessageId: string | null,
  opts?: { skipRules?: boolean },
): Promise<void> {
  try {
    // Opted-out contacts get total silence from every automated path —
    // only the team can message them (or lift the flag in the inbox).
    if (contact.do_not_contact) {
      await supabase
        .from("wa_contacts")
        .update({ needs_attention: true })
        .eq("id", contact.id);
      return;
    }

    const config = await getWaAgentConfig(supabase);

    // 1. Keyword rules — instant, deterministic, run before the AI.
    // (Skipped for media messages: an AI image description mentioning a
    // rule keyword must not fire a canned reply.)
    const suppressAgent = opts?.skipRules
      ? false
      : await runKeywordRules(supabase, contact, messageBody);

    // 2. CRM automations listening for WhatsApp messages.
    const lead = contact.lead_id
      ? (await supabase.from("leads").select("*").eq("id", contact.lead_id).maybeSingle()).data
      : null;
    await fireAutomationTrigger(supabase, {
      trigger: "wa_message_received",
      lead: lead ?? null,
      payload: {
        message: messageBody,
        phone: contact.wa_id,
        name: contact.display_name || contact.profile_name || "",
      },
      triggerKey: waMessageId ? `wa:${waMessageId}` : undefined,
    });

    // 3. The AI agent — queued, never run inside the webhook. Each message
    // pushes the timer, so a burst of texts collapses into ONE reply and a
    // long run (site audit + tool rounds) can't be cut off by the webhook's
    // serverless budget. processDueWaAgentRuns (the tick) drains the queue.
    if (suppressAgent) {
      // A rule already replied or handed off — cancel any queued run.
      await supabase
        .from("wa_contacts")
        .update({ agent_due_at: null })
        .eq("id", contact.id);
      return;
    }
    if (!config.enabled || !contact.agent_enabled) return;
    if (!isOpenAIConfigured()) return;

    await supabase
      .from("wa_contacts")
      .update({
        agent_due_at: new Date(
          Date.now() + AGENT_DEBOUNCE_SECONDS * 1000,
        ).toISOString(),
      })
      .eq("id", contact.id);
  } catch (e) {
    console.error("[wa-agent] inbound handling failed:", e);
  }
}

/** Returns true when a matched rule replied or handed off (agent should stay quiet). */
async function runKeywordRules(
  supabase: DB,
  contact: WaContact,
  messageBody: string,
): Promise<boolean> {
  const { data: rules } = await supabase
    .from("wa_keyword_rules")
    .select("*")
    .eq("is_active", true)
    .order("position")
    .order("created_at");
  if (!rules?.length) return false;

  const text = messageBody.trim().toLowerCase();
  let suppress = false;

  for (const rule of rules) {
    const kw = rule.keyword.trim().toLowerCase();
    if (!kw) continue;
    const matched =
      rule.match_type === "exact"
        ? text === kw
        : rule.match_type === "starts_with"
          ? text.startsWith(kw)
          : text.includes(kw);
    if (!matched) continue;

    await supabase
      .from("wa_keyword_rules")
      .update({ hits: (rule.hits ?? 0) + 1 })
      .eq("id", rule.id);

    if (rule.reply?.trim()) {
      const name =
        (contact.display_name || contact.profile_name || "").split(/\s+/)[0] || "there";
      const reply = rule.reply
        .replaceAll("{{name}}", name)
        .replaceAll("{{phone}}", formatWaPhone(contact.wa_id));
      await sendAndLogWa(supabase, { contact, body: reply, sentBy: "keyword" });
      suppress = true;
    }

    if (rule.add_tag?.trim() && contact.lead_id) {
      const { data: lead } = await supabase
        .from("leads")
        .select("id, tags")
        .eq("id", contact.lead_id)
        .maybeSingle();
      if (lead) {
        const tags = new Set(lead.tags ?? []);
        tags.add(rule.add_tag.trim());
        await supabase.from("leads").update({ tags: Array.from(tags) }).eq("id", lead.id);
      }
    }

    if (rule.handoff) {
      await supabase
        .from("wa_contacts")
        .update({ agent_enabled: false, needs_attention: true })
        .eq("id", contact.id);
      contact.agent_enabled = false;
      suppress = true;
    }

    if (rule.notify_team || rule.handoff) {
      const who =
        contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id);
      await notifyEveryone(supabase, {
        title: rule.handoff ? "WhatsApp — human takeover needed" : "WhatsApp keyword matched",
        body: `${who}: "${messageBody.slice(0, 120)}"`,
        link: "/whatsapp",
        // Only the human-takeover case texts the team — routine keyword
        // matches stay in-app to avoid SMS noise.
        sms: rule.handoff
          ? `ARCON: WhatsApp customer ${who} (${formatWaPhone(contact.wa_id)}) needs a human. AI is paused — open the inbox to take over.`
          : null,
      });
    }

    if (rule.automation_id) {
      const { data: automation } = await supabase
        .from("automations")
        .select("*")
        .eq("id", rule.automation_id)
        .maybeSingle();
      if (automation) {
        const { data: lead } = contact.lead_id
          ? await supabase.from("leads").select("*").eq("id", contact.lead_id).maybeSingle()
          : { data: null };
        await enrollAutomationRun(supabase, automation, {
          trigger: automation.trigger,
          lead: lead ?? null,
          payload: {
            message: messageBody,
            phone: contact.wa_id,
            name: contact.display_name || contact.profile_name || "",
          },
        });
      }
    }
  }

  return suppress;
}

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

async function runWaAgent(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  opts?: { voice?: boolean },
): Promise<void> {
  const { data: history } = await supabase
    .from("wa_messages")
    .select("direction, body, sent_by, created_at")
    .eq("contact_id", contact.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_MESSAGES);

  const thread: ChatMessage[] = (history ?? [])
    .reverse()
    .filter((m) => m.body.trim())
    .map((m) => ({
      role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));

  const allowed = new Set(config.allowed_tools ?? []);
  const tools = buildToolSchemas(allowed);

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt(supabase, contact, config) },
    ...thread,
  ];

  const model = process.env.OPENAI_WHATSAPP_MODEL?.trim() || undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let reply: ChatMessage;
    try {
      reply = await openaiChat(messages, tools, { model });
    } catch (e) {
      console.error("[wa-agent] OpenAI call failed:", e);
      return;
    }

    if (reply.tool_calls?.length) {
      messages.push(reply);
      for (const call of reply.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Malformed args — the tool will report what's missing.
        }
        const result = allowed.has(call.function.name)
          ? await executeWaTool(supabase, contact, config, call.function.name, args)
          : { ok: false, result: `Tool "${call.function.name}" is not enabled.` };

        await supabase.from("wa_agent_logs").insert({
          contact_id: contact.id,
          tool: call.function.name,
          args,
          ok: result.ok,
          result: result.result.slice(0, 2000),
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.result,
        });
      }
      continue;
    }

    const text = (reply.content ?? "").trim();
    if (text) {
      // Voice-first customers get a voice note back (config-gated); any
      // failure degrades to the plain text send.
      if (opts?.voice && config.voice_replies === "match") {
        const spoke = await sendVoiceReply(supabase, contact, text);
        if (spoke) return;
      }
      await sendAndLogWa(supabase, { contact, body: text, sentBy: "agent" });
    }
    return;
  }
}

/**
 * Whether a voice note may be TTS'd for this contact's language. English
 * (or unknown) is always fine; Sinhala/Tamil — native or romanized — only
 * when the team explicitly opted into a multilingual model by setting
 * OPENAI_TTS_MODEL (the default tts-1/alloy mangles them badly enough to
 * hurt the brand; the caller degrades to a plain text send instead).
 */
function voiceableLanguage(language: WaContact["language"]): boolean {
  if (!language || language === "en") return true;
  return Boolean(process.env.OPENAI_TTS_MODEL?.trim());
}

/** TTS the reply, upload it and send it as a WhatsApp voice note. */
async function sendVoiceReply(
  supabase: DB,
  contact: WaContact,
  text: string,
): Promise<boolean> {
  if (!voiceableLanguage(contact.language)) return false;
  try {
    const { openaiSpeech } = await import("@/lib/ai/openai");
    const { sendWhatsAppAudio } = await import("@/lib/whatsapp");
    const { STORAGE_BUCKETS } = await import("@/lib/constants");

    // Strip emoji/markup — they read terribly out loud.
    const spoken = text.replace(/[*_~]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
    if (!spoken) return false;

    // On a multilingual model, steer the accent; classic tts-1 ignores this.
    const lang = contact.language ? baseLanguage(contact.language) : "en";
    const audio = await openaiSpeech(
      spoken,
      lang === "si"
        ? { instructions: "Speak naturally in Sinhala with a Sri Lankan accent." }
        : lang === "ta"
          ? { instructions: "Speak naturally in Tamil with a Sri Lankan accent." }
          : undefined,
    );
    const path = `voice/${contact.id}/${Date.now()}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.waMedia)
      .upload(path, Buffer.from(audio), { contentType: "audio/mpeg", upsert: true });
    if (uploadError) return false;
    const { data: pub } = supabase.storage
      .from(STORAGE_BUCKETS.waMedia)
      .getPublicUrl(path);

    const sent = await sendWhatsAppAudio({ to: contact.wa_id, link: pub.publicUrl });
    if (!sent.ok) return false;

    await supabase.from("wa_messages").insert({
      contact_id: contact.id,
      wa_message_id: sent.waMessageId,
      direction: "out",
      message_type: "audio",
      body: `🎤 ${text}`,
      status: "sent",
      sent_by: "agent",
      meta: { voice: true, audio_url: pub.publicUrl },
    });
    await supabase
      .from("wa_contacts")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: `🎤 ${text.slice(0, 150)}`,
        last_direction: "out",
      })
      .eq("id", contact.id);
    return true;
  } catch (e) {
    console.error("[wa-agent] voice reply failed:", e);
    return false;
  }
}

async function buildSystemPrompt(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
): Promise<string> {
  const name = contact.display_name || null;
  const tz = config.timezone || "Asia/Colombo";
  const known: string[] = [];
  known.push(
    `Current date & time: ${formatInTimezone(new Date(), tz)} (${tz}) — resolve every relative time they mention ("Monday", "tomorrow", "the 25th", "next week") against this.`,
  );
  known.push(`Phone: ${formatWaPhone(contact.wa_id)}`);
  if (name) known.push(`Name: ${name}`);
  else if (contact.profile_name)
    known.push(`WhatsApp profile name (unconfirmed, don't assume it's their real name): ${contact.profile_name}`);
  known.push(contact.lead_id ? "CRM lead: linked" : "CRM lead: none yet");
  known.push(contact.client_id ? "Client profile: linked" : "Client profile: none yet");

  const parts: string[] = [
    `You are ${config.agent_name || "Arc"}, a sales consultant at ARC AI Agency — a Sri Lankan AI & digital agency that builds business websites, e-commerce stores, runs social media marketing and sets up AI automations. You're chatting with a potential customer on WhatsApp.`,
    `HOW YOU SOUND (this matters more than anything):
- Like a sharp, friendly human on WhatsApp — warm, confident, a little playful. Use contractions ("I'll", "that's"), natural fillers ("ah nice", "got it", "to be honest"), and the occasional emoji 👍 — but never more than one per message.
- SHORT messages. 1-3 sentences, like real texting. Never send walls of text or bullet lists longer than 3 items. ONE exception: when presenting a package (see PRICING PLAYBOOK) you may send one structured message of up to ~10 short lines with *bold* prices and line breaks.
- Mirror their energy — casual if they're casual, formal if they're formal.
- WhatsApp does NOT render markdown. NEVER write [text](url) links or # headers — paste the bare URL on its own line. Only *single asterisks* for bold and _underscores_ for italics work.
- BANNED: "As an AI", "I understand your concern", "Certainly!", "How may I assist you today", "I apologize for any inconvenience" — anything that smells like a call center or a bot. If someone directly asks if you're a bot, be honest and light: you're Arc, the agency's digital assistant, and a teammate can jump in anytime.
- NEVER invent prices, discounts or delivery dates. Quote ONLY what's in the knowledge base; anything else → "let me get the team to confirm that."`,
    `YOUR MISSION — learn everything, lead everything. You always hold the upper hand in the conversation: you ask the questions, you steer, and every message you send ends with exactly ONE question or a clear next step. Never leave a reply hanging with nothing to answer.

INFO CHECKLIST (collect in this order, one at a time, weaving it into natural chat — never interrogate):
1. Their NAME — always first. ${config.ask_name ? "Don't discuss anything substantial until you have it." : ""}
2. Their COMPANY / business name and what they do.
3. Their WEBSITE — always ask "do you have a website at the moment?" once you know the business.
4. What they need, their timeline, and a feel for budget.
5. Their email, and confirm this WhatsApp number is the best contact — slip these in naturally mid-conversation, e.g. when offering to send something.

THE MOMENT you have a plausibly-real name (and again when you learn company/email), call save_contact. Log every meaningful detail they share with update_lead (note). Buying signals — asking prices, timelines, "can you do X" — mark the lead hot with update_lead.`,
    `SANITY-CHECK WHAT THEY GIVE YOU (use common sense — you're a sharp human, not a form that swallows anything):
- NAMES: if the "name" is obviously not real — a fictional character (Batman, Superman), a celebrity, a placeholder ("test", "asdf", "N/A", "idk"), an insult, or clearly a joke — DON'T earnestly accept it or save it. Play along warmly for ONE beat, then ask for their real name: "haha Batman 😄 what's your actual name though, so I know who I'm chatting with?" Only call save_contact once the name is plausibly real.
- EMAILS: you actually send quotes and invoices to their email, so it has to work. If it's an obvious placeholder (test@test.com, a@a.com), matches a joke name (batman@…), or looks malformed/misspelled, don't save it — ask them to confirm it, framed around value: "I'll fire the quote over to that email — mind double-checking it's right?" The system also checks emails automatically; if save_contact tells you an email looks dead, ask them for a better one before moving on.
- PHONE NUMBERS: the WhatsApp number they're messaging from is already real, so just confirm it's the best contact. If they volunteer another number that's obviously fake (1234567890, all the same digit), double-check it.
- DON'T over-police: plenty of real names and emails look unusual, especially in Sinhala/Tamil. When you're genuinely unsure, accept it — and never derail the sale over a detail; if they insist or brush it off, keep the conversation moving.`,
    `IF THEY HAVE A WEBSITE:
- The moment they share the URL, call BOTH audit_website AND research_contact (same turn, before replying).
- Then reply like someone who literally just opened their site on their phone: compliment one genuine thing, then casually drop the 1-2 issues that hurt most — lead with the real Google PageSpeed number when it's bad ("ran your site through Google's speed test while we were chatting — 34/100 on mobile 😬, people are leaving before it even loads"). Sound like an expert who noticed, not a report.
- Deep research on their business runs SILENTLY in the background. NEVER say you're researching, "looking into", or "preparing a report" on them — the magic is that a few minutes later you just naturally KNOW things (their services, reputation, competitors) and drop them into conversation like you've known their industry for years.
- THE CLOSER: once the audit has run and they're engaged (asking questions, discussing problems), call send_showcase — a page with their scores AND a redesign concept of THEIR OWN site arrives in this chat automatically. Tease it, don't spoil it: "actually — give me a few minutes, I want to show you something 😄". One per contact; don't re-send.
- Then bridge to the fix: what we'd do, the package that fits (knowledge base), and a call — send_booking_link.

IF THEY DON'T HAVE A WEBSITE:
- Totally fine — "actually easier, we start clean 😄". Ask what kind of site they're picturing: business site or online store?
- Then gather: what the business does, must-have features, any sites they like, timeline.
- Give them the fitting package + price straight from the knowledge base, frame it around THEIR goals ("for a bakery doing deliveries, the Growth package makes sense because…").
- Still call research_contact with their business name — reviews and Facebook pages often exist without a website.

PRICING PLAYBOOK (follow this EXACTLY whenever budget or packages come up):
- Never name a package without immediately giving its full picture from the knowledge base: *price*, what's included (pages, design level, CRM/AI, SEO — whatever the knowledge base lists), and delivery time if listed. A package name alone is a wasted message.
- When they give a budget: recommend the package whose price is CLOSEST to it, presented in full. If their budget sits between two tiers, lead with the one just below and immediately show what the next one up adds.
- ALWAYS anchor upward: right after the fitting package, show the next tier up with its price and the 2-3 extra benefits that matter for THEIR business — "for 40k more you'd also get the lead dashboard and AI chat, honestly most shops your size go for that one." Make the upgrade feel like the popular, safe choice (social proof), never pushy.
- Frame everything around THEIR goals, not features ("the CRM means every inquiry from the site lands in one place — no lost customers").
- Never volunteer a cheaper tier. Only step down if they clearly push back on price — and when you do, mention exactly what they'd be giving up.
- Example shape (adapt, don't copy):
  "For that budget the *Launch* package fits perfectly — *Rs 90,000*:
  ✅ 8-page premium custom design
  ✅ Conversion-focused layout + strategic CTAs
  ✅ Full SEO setup
  Delivery in ~10 days.
  And for *Rs 130,000* the *Growth* adds a lead dashboard + 15 pages — that's what most growing businesses pick. Want me to put a proper plan together for you?"

CLOSING PLAYS:
- Momentum: offer something concrete and fast — "I can have the formal quote right here in this chat in a minute."
- When they're warm: send_booking_link for a quick call. When they're serious and you have requirements but no clear yes yet: create_proposal and tell them it's on the way.
- THE MONEY MOMENT: the instant they clearly agree on a package and price ("okay let's do it", "go ahead with Growth") → call send_quote immediately — strike while it's hot. It creates a real signable quotation and delivers the link into this chat by itself. Right after, send ONE short human message: they can open it and sign right on their phone, and the moment they sign we get started. NEVER paste the link again yourself.
- After they sign, everything is automatic — the invoice and payment details arrive in this chat on their own. Your job then: congratulate them warmly and set delivery expectations from the knowledge base.
- DISCOUNTS: you have ZERO discount authority unless the team granted a limit (send_quote enforces it). Use it at most once per deal, only on a genuine price objection, always framed as a "if you confirm this week" incentive. Never open with a discount.
- If they go quiet after pricing, DON'T chase with discounts — the follow-up system re-engages them automatically; use schedule_followup only when a HUMAN teammate needs to act.
- HUMAN WANTED = STOP SELLING: the moment they ask to reach a person in ANY form — "speak to someone", "talk to a real person / a human", "in person", "is there a human?", "can someone from your team call me", "I'd rather deal with a person" — that is NOT a send_booking_link or scheduling moment. Call handoff_human immediately (it pauses you and alerts the team), then send ONE short line saying a teammate will jump into this chat shortly — and STOP. Do not ask for a time, do not keep selling. Same for real frustration, complaints, refunds, legal/contract issues or anything sensitive.`,
    `PROMISES — never let a commitment slip:
- The moment the customer names a time or future event — "call me Monday", "I'll talk to my partner tonight", "salary comes on the 25th", "message me next week" — call schedule_promise in that SAME turn, then acknowledge it naturally in your reply ("perfect, I'll check in with you Monday 👍"). The system messages them for you at exactly that moment.
- Also schedule one when they promise to DO something ("I'll send the logo tomorrow") — so you can gently nudge if it doesn't arrive.
- Never schedule promises for things YOU are doing right now, and never tell them a "reminder" or "system" exists — you simply remember.
- When a promise resolves in the chat or plans change, call cancel_promise (and schedule the new time if they named one). schedule_followup is different — that one only reminds a HUMAN teammate.`,
    `IMAGES & PAYMENT SLIPS:
- Photos and files the customer sends appear in the chat as 📷/📄 lines with a short description — that's you seeing them. React to their content naturally; NEVER say you can't view images.
- Bank slip / payment receipt: thank them warmly, tell them accounts is confirming it and the confirmation will land right here in this chat — do NOT declare the payment verified yourself, and do NOT re-ask for a slip they already sent. If it's the deposit, remind them the project kicks off the moment it's confirmed.`,
    `What you already know about this contact:\n${known.join("\n")}`,
  ];

  if (config.language_matching) parts.push(languageDirective(contact.language));

  if (config.greeting.trim())
    parts.push(
      `When greeting a brand-new contact (no conversation history), base your opening message on this greeting:\n"${config.greeting.trim()}"`,
    );
  if (config.persona.trim()) parts.push(`Extra instructions from the team:\n${config.persona.trim()}`);
  if (config.knowledge.trim())
    parts.push(`KNOWLEDGE BASE (services, pricing, FAQs — your ground truth):\n${config.knowledge.trim()}`);

  // Give the model fresh CRM context up-front so it doesn't waste a round.
  if (contact.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("title, value, status, score, notes, tags, source, company, company_website")
      .eq("id", contact.lead_id)
      .maybeSingle();
    if (lead) {
      parts.push(
        `Linked CRM lead: ${JSON.stringify({
          title: lead.title,
          company: lead.company,
          website: lead.company_website,
          value: lead.value,
          status: lead.status,
          score: lead.score,
          tags: lead.tags,
          notes: (lead.notes ?? "").slice(0, 500),
        })}`,
      );
      if (lead.source === "prospecting") {
        parts.push(
          `COLD-OUTREACH CONTEXT: WE contacted THEM first — they're replying to our cold WhatsApp about their website. So: don't greet like an inbound stranger, don't ask what their business is (you already know — see the lead notes and research), and don't re-ask for basics. Acknowledge why we reached out, be effortlessly specific about their site's issues, and get to value in your first reply. Slightly warmer, zero pressure — they didn't ask for this conversation, earn it.`,
        );
      }
    }
  }

  // Promises already on the books — the model must manage them, not
  // duplicate them.
  const { data: promises } = await supabase
    .from("wa_promises")
    .select("id, summary, due_at")
    .eq("contact_id", contact.id)
    .eq("status", "pending")
    .order("due_at")
    .limit(5);
  if (promises?.length) {
    const lines = promises.map(
      (p) => `- [${p.id}] due ${formatInTimezone(p.due_at, tz)} — ${p.summary}`,
    );
    parts.push(
      `OPEN PROMISES (follow-ups you already scheduled — the system WILL message them at these moments; never schedule a duplicate, cancel_promise any that resolve or change):\n${lines.join("\n")}`,
    );
  }

  // Photos & files never age out of the agent's memory, even after the
  // 30-message history window scrolls past them.
  const { data: mediaMsgs } = await supabase
    .from("wa_messages")
    .select("body, message_type, created_at, meta")
    .eq("contact_id", contact.id)
    .eq("direction", "in")
    .in("message_type", ["image", "document"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (mediaMsgs?.length) {
    const lines = [...mediaMsgs].reverse().map((m) => {
      const meta = (m.meta ?? {}) as {
        kind?: string;
        slip?: Record<string, unknown> | null;
      };
      const slip = meta.slip ? ` (slip details: ${JSON.stringify(meta.slip)})` : "";
      return `${m.created_at.slice(0, 10)} [${meta.kind || m.message_type}] ${m.body.slice(0, 200)}${slip}`;
    });
    parts.push(
      `IMAGES & FILES THE CUSTOMER HAS SENT (you saw these when they arrived — recall them naturally when relevant):\n${lines.join("\n")}`,
    );
  }

  // Lessons the coaching analyzer learned from past won/lost conversations.
  const { data: coaching } = await supabase
    .from("wa_coaching")
    .select("notes")
    .eq("is_active", true)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (coaching?.notes?.trim()) {
    parts.push(
      `LESSONS FROM YOUR OWN PAST DEALS (auto-learned weekly — apply them unless they conflict with the pricing rules):\n${coaching.notes.trim()}`,
    );
  }

  return parts.join("\n\n");
}

/** The per-contact language instruction — same language AND same script. */
function languageDirective(language: WaContact["language"]): string {
  switch (language) {
    case "si":
      return `LANGUAGE: This customer writes in Sinhala (සිංහල script). Reply ONLY in Sinhala, in Sinhala script — every message, every follow-up. Keep package names, prices (Rs 90,000) and technical terms (SEO, CRM, e-commerce) in English/numerals, the way Sri Lankans naturally mix them.`;
    case "ta":
      return `LANGUAGE: This customer writes in Tamil (தமிழ் script). Reply ONLY in Tamil, in Tamil script — every message, every follow-up. Keep package names, prices (Rs 90,000) and technical terms (SEO, CRM, e-commerce) in English/numerals, the way Sri Lankans naturally mix them.`;
    case "si-latn":
      return `LANGUAGE: This customer writes Sinhala in English letters ("Singlish", e.g. "mata website ekak one"). Reply in romanized Sinhala EXACTLY the same way — Latin letters, NEVER Sinhala script — matching their casual spelling style. English technical terms and prices stay as they are.`;
    case "ta-latn":
      return `LANGUAGE: This customer writes Tamil in English letters ("Tanglish", e.g. "enakku website venum"). Reply in romanized Tamil EXACTLY the same way — Latin letters, NEVER Tamil script — matching their casual spelling style. English technical terms and prices stay as they are.`;
    case "en":
      return `LANGUAGE: Reply in English.`;
    default:
      return `LANGUAGE: Reply in English by default. Switch to Sinhala or Tamil ONLY when the customer clearly writes to you in that language, or explicitly asks you to use it — a stray local word ("machan", "aiya") or a mixed English sentence is NOT a switch, stay in English. When they genuinely do write in Sinhala/Tamil — native script OR romanized in English letters ("Singlish"/"Tanglish") — reply the same way and in the SAME script (romanized stays romanized, never native script), then call set_language ONCE so it sticks across replies, follow-ups and voice notes.`;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildToolSchemas(allowed: Set<string>): ToolSchema[] {
  const catalogKeys = new Set(WA_TOOL_CATALOG.map((t) => t.key));
  const schemas: Record<string, ToolSchema> = {
    save_contact: fn("save_contact", "Save the contact's name/details. Creates their client profile and CRM lead (idempotent — safe to call again with more details).", {
      name: { type: "string", description: "The contact's full name." },
      company: { type: "string", description: "Their business/company name, if mentioned." },
      email: { type: "string", description: "Email address, if shared." },
      city: { type: "string", description: "City/area, if mentioned." },
      service_interest: {
        type: "string",
        description: "What they want, e.g. 'e-commerce store', 'business website', 'social media marketing'.",
      },
    }, ["name"]),
    get_context: fn("get_context", "Read the linked CRM lead, client profile, research status and recent activity for this contact.", {}),
    research_contact: fn("research_contact", "Start deep AI research on the contact's business (website, reviews, competitors). Takes a few minutes; check later with get_research.", {
      company: { type: "string", description: "The business name to research." },
      website: { type: "string", description: "Their website URL, if known." },
    }, ["company"]),
    get_research: fn("get_research", "Fetch the research briefing for this contact's business (call research_contact first).", {}),
    audit_website: fn("audit_website", "Instantly audit a website (seconds): mobile-friendliness, HTTPS, SEO basics, freshness. Returns concrete issues you can mention naturally in conversation. Call this the moment they share their website URL.", {
      website: { type: "string", description: "The website URL or domain, e.g. nimalbakery.lk" },
    }, ["website"]),
    send_showcase: fn("send_showcase", "Queue the live showcase: a personalized page with their audit scores AND an AI redesign concept of their own homepage, delivered automatically into this chat as one image message with a link. Use after the audit has run and interest is real — it's your strongest closing move.", {
      website: { type: "string", description: "Their website URL (defaults to the lead's saved website)." },
    }),
    update_lead: fn("update_lead", "Update the linked CRM lead: deal value, score and/or a qualification note.", {
      value: { type: "number", description: "Estimated deal value in LKR." },
      score: { type: "string", enum: ["hot", "warm", "cold"], description: "How promising this lead feels." },
      note: { type: "string", description: "A short qualification note to log on the lead." },
    }),
    create_task: fn("create_task", "Create a CRM task for the team.", {
      title: { type: "string", description: "Short task title." },
      notes: { type: "string" },
      due_in_days: { type: "number", description: "Days until due (default 1)." },
    }, ["title"]),
    schedule_followup: fn("schedule_followup", "Schedule a follow-up reminder for the team to re-engage this contact.", {
      days: { type: "number", description: "In how many days to follow up." },
      note: { type: "string", description: "What to say / check when following up." },
    }, ["days"]),
    schedule_promise: fn("schedule_promise", "The customer committed to a time or future event ('call me Monday', 'salary on the 25th', 'let me ask my partner') — schedule YOUR OWN follow-up message for exactly that moment. Call it in the same turn you hear the commitment.", {
      summary: {
        type: "string",
        description: "What they committed to, in your words, e.g. \"said to call back Monday after lunch\" or \"salary lands on the 25th, will decide then\".",
      },
      due_date: {
        type: "string",
        description: "When to follow up, as \"YYYY-MM-DD\" in the customer's LOCAL date (resolve \"Monday\"/\"the 25th\" against the current date & time you were given).",
      },
      due_time: {
        type: "string",
        description: "Local time \"HH:mm\" (24h). If they only named a day, pick a sensible business hour (default 10:00); if they named a time already past today, use the next occurrence.",
      },
      source_quote: { type: "string", description: "Their exact words that made the commitment, verbatim." },
    }, ["summary", "due_date"]),
    cancel_promise: fn("cancel_promise", "Cancel or complete a scheduled promise follow-up (see the OPEN PROMISES list) when it resolved in-chat or plans changed.", {
      promise_id: { type: "string", description: "The id in [brackets] from the OPEN PROMISES list — copy it exactly." },
      outcome: { type: "string", enum: ["done", "no_longer_relevant"], description: "Why it's being closed." },
      reason: { type: "string", description: "Short note on what happened." },
    }, ["promise_id"]),
    send_booking_link: fn("send_booking_link", "Get the agency's active meeting booking link(s) to share with the contact.", {}),
    create_proposal: fn("create_proposal", "Create a draft proposal from the collected requirements. Only call once you know their name, business and what they need.", {
      business_description: {
        type: "string",
        description: "2-4 sentences about their business and what they need, from this conversation.",
      },
      project_type: { type: "string", enum: ["business", "ecommerce"], description: "Website type." },
      tier: {
        type: "string",
        enum: ["starter", "launch", "growth", "scale"],
        description: "Business-website package tier (only when project_type=business; default growth).",
      },
      platform: {
        type: "string",
        enum: ["shopify", "custom"],
        description: "E-commerce platform (only when project_type=ecommerce; default custom).",
      },
      project_name: { type: "string", description: "Short project name, e.g. 'Nimal Bakery Website'." },
    }, ["business_description", "project_type"]),
    send_quote: fn("send_quote", "THE CLOSER. Create a real, signable quotation for the package the customer just AGREED to and deliver the e-sign link into this chat automatically. Only call when they clearly said yes to a specific package/price — never to test the waters.", {
      project_type: { type: "string", enum: ["business", "ecommerce"], description: "Website type they agreed to." },
      tier: {
        type: "string",
        enum: ["starter", "launch", "growth", "scale"],
        description: "Business-website package tier (only when project_type=business; default growth).",
      },
      platform: {
        type: "string",
        enum: ["shopify", "custom"],
        description: "E-commerce platform (only when project_type=ecommerce; default custom).",
      },
      custom_items: {
        type: "array",
        description: "Extra agreed line items — ONLY add-ons priced in the knowledge base that the customer explicitly agreed to. Never invent items or prices.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Line item label." },
            price: { type: "number", description: "Price in LKR, exactly as priced in the knowledge base." },
          },
          required: ["name", "price"],
        },
      },
      discount: {
        type: "number",
        description: "Discount in LKR — only after a genuine price objection. Automatically capped at the team's discount authority; 0 or omitted = no discount.",
      },
    }, ["project_type"]),
    notify_team: fn("notify_team", "Send an urgent in-app + push notification to the whole team.", {
      title: { type: "string" },
      body: { type: "string" },
    }, ["title"]),
    handoff_human: fn("handoff_human", "Pause the AI for this chat and alert the team that a human must take over.", {
      reason: { type: "string", description: "Why the handoff is needed." },
    }, ["reason"]),
    set_language: fn("set_language", "Set the language for this chat. English is the default, so you only call this to switch AWAY from English — when the customer clearly writes to you in Sinhala/Tamil (native script or romanized 'Singlish'/'Tanglish'), or explicitly asks you to reply in that language. Do NOT call it for a stray local word or a mostly-English message. Call it once when they genuinely switch, and again only if they clearly switch back.", {
      language: {
        type: "string",
        enum: ["en", "si", "ta", "si-latn", "ta-latn"],
        description: "en = English · si = Sinhala script · ta = Tamil script · si-latn = Sinhala in English letters (\"Singlish\") · ta-latn = Tamil in English letters (\"Tanglish\").",
      },
    }, ["language"]),
  };

  return Array.from(allowed)
    .filter((k) => catalogKeys.has(k) && schemas[k])
    .map((k) => schemas[k]);
}

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): ToolSchema {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required?.length ? { required } : {}),
        additionalProperties: false,
      },
    },
  };
}

type WaToolOutcome = { ok: boolean; result: string };

async function executeWaTool(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  try {
    switch (name) {
      case "save_contact":
        return await toolSaveContact(supabase, contact, config, args);
      case "get_context":
        return await toolGetContext(supabase, contact);
      case "research_contact":
        return await toolResearchContact(supabase, contact, config, args);
      case "get_research":
        return await toolGetResearch(supabase, contact);
      case "audit_website":
        return await toolAuditWebsite(supabase, contact, args);
      case "send_showcase":
        return await toolSendShowcase(supabase, contact, args);
      case "update_lead":
        return await toolUpdateLead(supabase, contact, args);
      case "create_task":
      case "schedule_followup": {
        const days =
          name === "schedule_followup"
            ? Math.max(1, Number(args.days ?? 1))
            : Math.max(0, Number(args.due_in_days ?? 1));
        const title =
          name === "schedule_followup"
            ? `Follow up with ${contact.display_name || formatWaPhone(contact.wa_id)} (WhatsApp)`
            : String(args.title ?? "").trim();
        if (!title) return { ok: false, result: "Task needs a title." };
        const notes = String(args.note ?? args.notes ?? "").trim() || null;
        const { error } = await supabase.from("crm_tasks").insert({
          lead_id: contact.lead_id,
          title,
          notes,
          due_at: new Date(Date.now() + days * 24 * 3600_000).toISOString(),
          created_by: null,
        });
        return error
          ? { ok: false, result: error.message }
          : { ok: true, result: `Task created, due in ${days} day(s): "${title}".` };
      }
      case "schedule_promise":
        return await toolSchedulePromise(supabase, contact, config, args);
      case "cancel_promise":
        return await toolCancelPromise(supabase, contact, args);
      case "set_language": {
        const lang = String(args.language ?? "").trim();
        if (!isWaLanguage(lang))
          return { ok: false, result: "language must be one of: en, si, ta, si-latn, ta-latn." };
        // The webhook's script detector is ground truth for native script —
        // the model may refine TO a script/romanized variant, but a typed
        // Sinhala/Tamil contact never gets "downgraded" to plain English.
        if ((contact.language === "si" || contact.language === "ta") && lang === "en")
          return {
            ok: false,
            result: `They have written to you in ${contact.language === "si" ? "Sinhala" : "Tamil"} script — keep replying in it. Only switch if THEY clearly switch language.`,
          };
        const { error } = await supabase
          .from("wa_contacts")
          .update({ language: lang })
          .eq("id", contact.id);
        if (error) return { ok: false, result: error.message };
        contact.language = lang;
        return {
          ok: true,
          result: `Saved — reply in ${WA_LANGUAGE_LABELS[lang]} (same script) from now on, including follow-ups.`,
        };
      }
      case "send_booking_link": {
        const { data: links } = await supabase
          .from("meeting_links")
          .select("slug, title")
          .eq("active", true)
          .order("created_at", { ascending: false })
          .limit(3);
        if (!links?.length)
          return { ok: false, result: "No active booking links exist. Offer to have the team call them instead." };
        const rendered = links
          .map((l) => `${l.title}: ${appLink(`/book/${l.slug}`) ?? `(booking page /book/${l.slug})`}`)
          .join("\n");
        return { ok: true, result: `Share one of these booking links:\n${rendered}` };
      }
      case "notify_team": {
        const title = String(args.title ?? "").trim();
        if (!title) return { ok: false, result: "Notification needs a title." };
        const detail = String(args.body ?? "").trim();
        const who =
          contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id);
        const count = await notifyEveryone(supabase, {
          title: `WhatsApp: ${title}`,
          body: detail || null,
          link: "/whatsapp",
          sms: `ARCON — WhatsApp (${who}): ${title}${detail ? `. ${detail}` : ""}. Open the inbox.`,
        });
        return { ok: true, result: `Notified ${count} team member(s).` };
      }
      case "handoff_human": {
        await supabase
          .from("wa_contacts")
          .update({ agent_enabled: false, needs_attention: true })
          .eq("id", contact.id);
        contact.agent_enabled = false;
        {
          const who =
            contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id);
          const reason = String(args.reason ?? "").slice(0, 140);
          await notifyEveryone(supabase, {
            title: "WhatsApp — human takeover needed",
            body: `${who} — ${reason}`,
            link: "/whatsapp",
            sms: `ARCON: WhatsApp customer ${who} (${formatWaPhone(contact.wa_id)}) needs a human${reason ? ` — ${reason}` : ""}. AI is paused — open the inbox to take over.`,
          });
        }
        return {
          ok: true,
          result:
            "AI paused for this chat and the team was alerted. Tell the customer a team member will continue the conversation shortly, then stop.",
        };
      }
      case "create_proposal":
        return await toolCreateProposal(supabase, contact, args);
      case "send_quote":
        return await toolSendQuote(supabase, contact, config, args);
      default:
        return { ok: false, result: `Unknown tool "${name}".` };
    }
  } catch (e) {
    return {
      ok: false,
      result: e instanceof Error ? e.message : "The tool crashed.",
    };
  }
}

// ---- save_contact: the "new lead walks in" flow ---------------------------

async function toolSaveContact(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const name = String(args.name ?? "").trim();
  if (!name) return { ok: false, result: "A name is required." };
  const company = String(args.company ?? "").trim() || null;
  const rawEmail = String(args.email ?? "").trim() || null;
  const city = String(args.city ?? "").trim() || null;
  const interest = String(args.service_interest ?? "").trim() || null;
  const phonePretty = formatWaPhone(contact.wa_id);

  // Don't let an obviously-fake / undeliverable email into the CRM — we send
  // quotes and invoices there. checkEmail does format + placeholder + MX checks.
  let email = rawEmail;
  let emailNote = "";
  if (rawEmail) {
    const check = await checkEmail(rawEmail);
    if (!check.ok) {
      email = null;
      emailNote =
        check.reason === "no-mx"
          ? ` NOTE: the email "${rawEmail}" doesn't look deliverable (its domain can't receive mail), so it was NOT saved — ask the customer to double-check their email before sending anything there.`
          : ` NOTE: the email "${rawEmail}" looks fake or invalid, so it was NOT saved — ask the customer for a real email before sending anything there.`;
    }
  }

  const done: string[] = [];

  // 1. Client profile.
  let clientId = contact.client_id;
  if (!clientId) {
    const { data: client } = await supabase
      .from("clients")
      .insert({
        name,
        company,
        email,
        phone: phonePretty,
        city,
        status: "lead",
        notes: `Created by the WhatsApp agent.${interest ? ` Interested in: ${interest}.` : ""}`,
        created_by: null,
      })
      .select("id")
      .single();
    if (client) {
      clientId = client.id;
      done.push("client profile created");
    }
  } else {
    await supabase
      .from("clients")
      .update({ name, ...(company ? { company } : {}), ...(email ? { email } : {}), ...(city ? { city } : {}) })
      .eq("id", clientId);
    done.push("client profile updated");
  }

  // 2. CRM lead.
  let leadId = contact.lead_id;
  if (!leadId && config.auto_create_lead) {
    const spot = await resolveLeadLandingSpot(supabase, config);
    if (!spot) {
      return { ok: false, result: "No CRM pipeline exists yet — the team must create one first." };
    }
    const { data: lead } = await supabase
      .from("leads")
      .insert({
        pipeline_id: spot.pipelineId,
        stage_id: spot.stageId,
        title: interest ? `${name} — ${interest}` : `${name} — WhatsApp`,
        contact_name: name,
        contact_phone: phonePretty,
        contact_email: email,
        company,
        notes: `Lead captured by the WhatsApp agent.${interest ? ` Wants: ${interest}.` : ""}`,
        source: config.lead_source || "whatsapp",
        tags: ["whatsapp"],
        client_id: clientId,
        created_by: null,
      })
      .select("*")
      .single();
    if (lead) {
      leadId = lead.id;
      done.push("CRM lead created");
      await fireAutomationTrigger(supabase, {
        trigger: "lead_created",
        lead,
        payload: { message: interest ?? "", source: lead.source },
        triggerKey: `${lead.id}:created`,
      });
    }
  } else if (leadId) {
    await supabase
      .from("leads")
      .update({
        contact_name: name,
        ...(email ? { contact_email: email } : {}),
        ...(company ? { company } : {}),
      })
      .eq("id", leadId);
    done.push("lead updated");
  }

  await supabase
    .from("wa_contacts")
    .update({ display_name: name, client_id: clientId, lead_id: leadId })
    .eq("id", contact.id);
  contact.display_name = name;
  contact.client_id = clientId;
  contact.lead_id = leadId;

  await notifyEveryone(supabase, {
    title: "New WhatsApp lead",
    body: `${name}${company ? ` (${company})` : ""} — ${phonePretty}${interest ? ` — wants ${interest}` : ""}`,
    link: leadId ? `/crm/lead/${leadId}` : "/whatsapp",
  });

  return {
    ok: true,
    result: `Saved: ${done.join(", ") || "nothing new"}.${emailNote} Continue the conversation naturally — don't mention CRM records.`,
  };
}

async function resolveLeadLandingSpot(
  supabase: DB,
  config: WaConfig,
): Promise<{ pipelineId: string; stageId: string | null } | null> {
  let pipelineId = config.pipeline_id;
  let stageId = config.stage_id;
  if (!pipelineId) {
    const { data: pipe } = await supabase
      .from("pipelines")
      .select("id")
      .order("position")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    pipelineId = pipe?.id ?? null;
    stageId = null;
  }
  if (!pipelineId) return null;
  if (!stageId) {
    const { data: stage } = await supabase
      .from("pipeline_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .order("position")
      .limit(1)
      .maybeSingle();
    stageId = stage?.id ?? null;
  }
  return { pipelineId, stageId };
}

// ---- context + research ----------------------------------------------------

async function toolGetContext(supabase: DB, contact: WaContact): Promise<WaToolOutcome> {
  const out: Record<string, unknown> = {
    phone: formatWaPhone(contact.wa_id),
    name: contact.display_name || contact.profile_name || null,
  };

  if (contact.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("title, value, status, score, notes, tags, source, ai_summary, ai_next_action")
      .eq("id", contact.lead_id)
      .maybeSingle();
    if (lead) {
      out.lead = {
        ...lead,
        notes: (lead.notes ?? "").slice(0, 600),
        ai_summary: (lead.ai_summary ?? "").slice(0, 600),
      };
    }
    const { data: activities } = await supabase
      .from("lead_activities")
      .select("kind, title, created_at")
      .eq("lead_id", contact.lead_id)
      .order("created_at", { ascending: false })
      .limit(6);
    out.recent_activity = (activities ?? []).map(
      (a) => `${a.created_at.slice(0, 10)} [${a.kind}] ${a.title}`,
    );
    const { data: research } = await supabase
      .from("lead_research")
      .select("status")
      .eq("lead_id", contact.lead_id)
      .maybeSingle();
    out.research_status = research?.status ?? "not started";
  }
  if (contact.client_id) {
    const { data: client } = await supabase
      .from("clients")
      .select("name, company, email, city, status")
      .eq("id", contact.client_id)
      .maybeSingle();
    if (client) out.client = client;
  }

  return { ok: true, result: JSON.stringify(out) };
}

async function toolResearchContact(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const company = String(args.company ?? "").trim();
  if (!company) return { ok: false, result: "A company/business name is required." };
  const website = String(args.website ?? "").trim() || null;

  if (!contact.lead_id) {
    // Research hangs off a lead — create the CRM records first.
    const saved = await toolSaveContact(supabase, contact, config, {
      name: contact.display_name || contact.profile_name || company,
      company,
    });
    if (!contact.lead_id)
      return {
        ok: false,
        result: `Could not create a CRM lead to attach research to (${saved.result}).`,
      };
  }

  await supabase
    .from("leads")
    .update({ company, ...(website ? { company_website: website } : {}) })
    .eq("id", contact.lead_id);

  const started = await queueLeadResearch(supabase, {
    leadId: contact.lead_id,
    company,
    requestedBy: null,
  });
  return started.ok
    ? {
        ok: true,
        result:
          "Research is running SILENTLY in the background. NEVER tell the customer you're researching them or mention reports — just reply naturally now (use the audit results if you have them, or keep qualifying). When the research finishes, you'll automatically get to send a follow-up that shows off what you learned.",
      }
    : { ok: false, result: "Could not start research." };
}

async function toolGetResearch(supabase: DB, contact: WaContact): Promise<WaToolOutcome> {
  if (!contact.lead_id) return { ok: false, result: "No CRM lead is linked yet." };
  const { data: research } = await supabase
    .from("lead_research")
    .select("status, report, error")
    .eq("lead_id", contact.lead_id)
    .maybeSingle();
  if (!research) return { ok: false, result: "No research has been started for this contact." };
  if (research.status !== "done") {
    return {
      ok: true,
      result: `Research status: ${research.status}${research.error ? ` (${research.error})` : ""}. Not ready yet — do NOT mention any research to the customer; keep the conversation moving naturally.`,
    };
  }
  const raw = JSON.stringify(research.report ?? {});
  return {
    ok: true,
    result: `Research briefing (JSON, may be truncated):\n${raw.slice(0, 3500)}`,
  };
}

// ---- instant website audit --------------------------------------------------

/**
 * One-scrape audit (the Find Leads triage engine): probes the URL, reads the
 * homepage and grades mobile/HTTPS/SEO/freshness in a few seconds — fast
 * enough to run inside the webhook reply. The deep Lighthouse scorecard
 * arrives later via the background research pipeline (get_research).
 */
async function toolAuditWebsite(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const website = String(args.website ?? "").trim();
  if (!website) return { ok: false, result: "A website URL is required." };

  const probe = await probeSite(website);

  if (probe.verdict === "down") {
    return {
      ok: true,
      result: `The site doesn't load at all (nothing answered at ${website}). That IS the headline issue — visitors and Google see a dead site. Mention it gently and pivot to how quickly we could get a proper site live.`,
    };
  }
  if (probe.verdict === "erroring") {
    return {
      ok: true,
      result: `The site is answering with server errors (HTTP ${probe.status}) — visitors currently see an error page. That's the headline issue; pivot to fixing/rebuilding it.`,
    };
  }
  if (!probe.html) {
    return {
      ok: true,
      result: `The site is up but couldn't be read (HTTP ${probe.status}, likely bot protection). Don't claim specific issues — say you had a quick look and would love to run a full audit, then keep qualifying. Deep research may still get through.`,
    };
  }

  const seo = analyzeSeo(probe.html);
  const text = probe.html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const verdict = quickSiteVerdict({
    seo,
    https: probe.finalUrl.startsWith("https://"),
    copyrightYear: extractCopyrightYear(text),
    contentChars: text.length,
  });

  // Real Lighthouse numbers sharpen the pitch, but the webhook reply can't
  // wait forever — race PSI against a hard cap and degrade gracefully. The
  // background research pass runs the full-budget Lighthouse audit anyway.
  const psi = await Promise.race([
    runPageSpeed(probe.finalUrl),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
  ]).catch(() => null);

  if (psi) {
    if (psi.performance >= 0 && psi.performance < 60) {
      const paint = psi.metrics.find((m) => /largest paint/i.test(m.label));
      verdict.issues.unshift(
        `Google PageSpeed score is ${psi.performance}/100 on mobile${paint ? ` (${paint.label.toLowerCase()}: ${paint.value})` : ""} — visitors are leaving before it loads.`,
      );
    }
    for (const audit of psi.failedAudits.slice(0, 3)) {
      if (!verdict.issues.includes(audit)) verdict.issues.push(audit);
    }
  }

  // Anchor the audit onto the CRM lead so the team sees it too.
  if (contact.lead_id) {
    await supabase
      .from("leads")
      .update({ company_website: probe.finalUrl })
      .eq("id", contact.lead_id);
    await supabase.from("lead_activities").insert({
      lead_id: contact.lead_id,
      kind: "note",
      title: `Website audit — ${verdict.score}/100`,
      body: verdict.issues.length ? verdict.issues.join("\n") : "No major issues found.",
      actor_id: null,
    });
  }

  const summary = {
    url: probe.finalUrl,
    score: verdict.score,
    lighthouse: psi
      ? {
          performance: psi.performance,
          seo: psi.seo,
          accessibility: psi.accessibility,
        }
      : "pending — full scores arrive with the background research",
    issues: verdict.issues,
  };
  return {
    ok: true,
    result:
      `${JSON.stringify(summary)}\n` +
      (verdict.issues.length
        ? "Pick the 2 issues a business owner FEELS most (mobile, Not Secure, dead-slow, looks outdated) and mention them casually like you just browsed the site — never dump the whole list. Compliment one genuine thing first."
        : "The site is technically decent — compliment it, then sell growth instead: more leads, better Google ranking, automation. The deep research report (get_research) will find more angles."),
  };
}

// ---- live showcase -----------------------------------------------------------

async function toolSendShowcase(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  let website = String(args.website ?? "").trim();
  let business = contact.display_name || contact.profile_name || "";

  if (contact.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("company, company_website, contact_name")
      .eq("id", contact.lead_id)
      .maybeSingle();
    website = website || lead?.company_website?.trim() || "";
    business = lead?.company?.trim() || business || lead?.contact_name?.trim() || "";
  }
  if (!website) {
    return {
      ok: false,
      result: "No website on file — ask for their website URL first (or run audit_website with it).",
    };
  }

  const queued = await queueWaShowcase(supabase, {
    contactId: contact.id,
    leadId: contact.lead_id,
    url: website,
    business: business || "their business",
  });
  if (!queued.ok) return { ok: false, result: queued.error ?? "Could not queue the showcase." };

  return {
    ok: true,
    result:
      "Showcase queued — it builds in the background and arrives in this chat automatically as ONE image message with a link (audit + redesign concept together). Tell them you're putting something together they'll want to see, then keep the conversation going. Do NOT promise an exact time and do NOT describe the contents piece by piece.",
  };
}

// ---- lead updates ----------------------------------------------------------

async function toolUpdateLead(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  if (!contact.lead_id) return { ok: false, result: "No CRM lead is linked — call save_contact first." };

  const patch: Database["public"]["Tables"]["leads"]["Update"] = {};
  if (args.value != null && !Number.isNaN(Number(args.value))) patch.value = Number(args.value);
  const score = String(args.score ?? "");
  if (score === "hot" || score === "warm" || score === "cold") {
    patch.score = score;
    patch.score_reason = "Set by the WhatsApp agent";
  }
  if (Object.keys(patch).length) {
    const { error } = await supabase.from("leads").update(patch).eq("id", contact.lead_id);
    if (error) return { ok: false, result: error.message };
  }

  const note = String(args.note ?? "").trim();
  if (note) {
    await supabase.from("lead_activities").insert({
      lead_id: contact.lead_id,
      kind: "note",
      title: "WhatsApp agent note",
      body: note,
      actor_id: null,
    });
  }
  return { ok: true, result: "Lead updated." };
}

// ---- proposals ---------------------------------------------------------------

async function toolCreateProposal(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const clientName = contact.display_name || contact.profile_name;
  if (!clientName)
    return { ok: false, result: "Capture the contact's name first (save_contact)." };

  const description = String(args.business_description ?? "").trim();
  if (description.length < 20)
    return { ok: false, result: "business_description is too thin — collect more detail first." };

  const selection: ProposalSelection = {
    ...defaultSelection(),
    type: args.project_type === "ecommerce" ? "ecommerce" : "business",
  };
  const tier = String(args.tier ?? "");
  if (["starter", "launch", "growth", "scale"].includes(tier)) {
    selection.tier = tier as ProposalSelection["tier"];
  }
  const platform = String(args.platform ?? "");
  if (["shopify", "custom"].includes(platform)) {
    selection.platform = platform as ProposalSelection["platform"];
  }

  const projectName =
    String(args.project_name ?? "").trim() || `${clientName} — Website Project`;
  const pricing = buildPricing(selection);

  const narrative = await generateProposalContent({
    businessDescription: description,
    clientName,
    projectName,
    selectionSummary: selectionSummary(selection),
    includedFeatures: includedFeatures(selection),
  });

  const { data: proposal, error } = await supabase
    .from("proposals")
    .insert({
      client_name: clientName,
      project_name: projectName,
      proposal_date: new Date().toISOString().slice(0, 10),
      selection: selection as unknown as Record<string, unknown>,
      content: { ...defaultContent(), ...narrative } as unknown as Record<string, unknown>,
      grand_total: pricing.oneTimeTotal,
      created_by: null,
    })
    .select("id")
    .single();
  if (error || !proposal) {
    return { ok: false, result: error?.message ?? "Could not save the proposal." };
  }

  await supabase.from("crm_tasks").insert({
    lead_id: contact.lead_id,
    title: `Review & send WhatsApp proposal — ${clientName}`,
    notes: `Drafted by the WhatsApp agent from chat requirements. Total ${money(pricing.oneTimeTotal)}.`,
    due_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    created_by: null,
  });
  await notifyEveryone(supabase, {
    title: "WhatsApp agent drafted a proposal",
    body: `${clientName} — ${projectName} (${money(pricing.oneTimeTotal)}). Review it under Proposals.`,
    link: "/proposals",
  });

  if (contact.lead_id) {
    await supabase.from("lead_activities").insert({
      lead_id: contact.lead_id,
      kind: "automation",
      title: "Proposal drafted by WhatsApp agent",
      body: `${projectName} — ${money(pricing.oneTimeTotal)}`,
      actor_id: null,
    });
  }

  return {
    ok: true,
    result: `Draft proposal created (${money(pricing.oneTimeTotal)} one-time). The team will review and send it — tell the customer it's on the way, and do NOT promise a delivery date or discounts.`,
  };
}

// ---- send_quote: the closing room -------------------------------------------

/**
 * The money moment. Builds a real e-sign quotation from the agreed package
 * (catalog prices only — the agent can't invent numbers), delivers the
 * /q/<token> signing link straight into the chat, and marks the lead hot.
 * Signing it fires the `quote_accepted` automation (invoice + payment
 * details + deposit task) with zero human involvement.
 */
async function toolSendQuote(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const customerName = contact.display_name;
  if (!customerName)
    return { ok: false, result: "Capture the contact's name first (save_contact)." };

  const appBase = appLink("");
  if (appBase === null)
    return {
      ok: false,
      result:
        "NEXT_PUBLIC_APP_URL isn't configured, so a signable link can't be built. Tell the customer the team will send the formal quote shortly.",
    };

  // One live quote at a time — nudge them to the pending one instead of
  // stacking duplicates when the model calls this twice.
  if (contact.lead_id) {
    const { data: pending } = await supabase
      .from("quotes")
      .select("quote_number, share_token, grand_total, status")
      .eq("lead_id", contact.lead_id)
      .in("status", ["sent", "viewed"])
      .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pending) {
      return {
        ok: true,
        result: `Quote ${pending.quote_number} (${money(Number(pending.grand_total))}) is already awaiting their signature${pending.status === "viewed" ? " — they've opened it" : ""}. Don't create another; nudge them to sign the one in this chat. Only re-share the link if they say they lost it: ${appLink(`/q/${pending.share_token}`)}`,
      };
    }
  }

  // Same deterministic pricing as create_proposal — catalog only.
  const selection: ProposalSelection = {
    ...defaultSelection(),
    type: args.project_type === "ecommerce" ? "ecommerce" : "business",
  };
  const tier = String(args.tier ?? "");
  if (["starter", "launch", "growth", "scale"].includes(tier)) {
    selection.tier = tier as ProposalSelection["tier"];
  }
  const platform = String(args.platform ?? "");
  if (["shopify", "custom"].includes(platform)) {
    selection.platform = platform as ProposalSelection["platform"];
  }
  for (const raw of Array.isArray(args.custom_items) ? args.custom_items : []) {
    const item = raw as { name?: unknown; price?: unknown };
    const label = String(item?.name ?? "").trim();
    const price = Number(item?.price);
    if (label && Number.isFinite(price) && price > 0) {
      selection.customFeatures.push({ name: label, price: Math.round(price) });
    }
  }

  const pricing = buildPricing(selection);
  const items: InvoiceItem[] = pricing.lineItems.map((l) => ({
    item: l.label,
    description: "",
    qty: "1",
    rate: String(l.amount),
    total: l.amount,
  }));
  const subtotal = pricing.oneTimeTotal;

  // Discount authority: clamp to the team's configured limit, once per deal.
  let discount = Math.max(0, Math.round(Number(args.discount) || 0));
  let discountNote = "";
  if (discount > 0) {
    const maxDiscount = Math.floor(
      (subtotal * Math.max(0, config.max_autonomous_discount_pct ?? 0)) / 100,
    );
    if (maxDiscount <= 0) {
      discount = 0;
      discountNote = " The team granted you NO discount authority — the quote was sent at full price; don't promise any discount.";
    } else {
      if (contact.lead_id) {
        const { data: discounted } = await supabase
          .from("quotes")
          .select("id")
          .eq("lead_id", contact.lead_id)
          .gt("discount", 0)
          .limit(1);
        if (discounted?.length) {
          discount = 0;
          discountNote = " A discounted quote already exists for this deal — no second discount allowed; the quote was sent at full price.";
        }
      }
      if (discount > maxDiscount) {
        discount = maxDiscount;
        discountNote = ` Discount was capped at your authority limit (${money(maxDiscount)}).`;
      }
    }
  }
  const grandTotal = Math.max(0, subtotal - discount);

  // Q-YYYY-NNN, continuing the workspace's numbering.
  const { count } = await supabase
    .from("quotes")
    .select("*", { count: "exact", head: true });
  const quoteNumber = `Q-${new Date().getFullYear()}-${String((count ?? 0) + 1).padStart(3, "0")}`;
  const validUntil = new Date(Date.now() + 7 * 24 * 3600_000).toISOString().slice(0, 10);

  let customerEmail: string | null = null;
  if (contact.client_id) {
    const { data: client } = await supabase
      .from("clients")
      .select("email")
      .eq("id", contact.client_id)
      .maybeSingle();
    customerEmail = client?.email ?? null;
  }

  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
      quote_number: quoteNumber,
      title: selectionSummary(selection),
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: formatWaPhone(contact.wa_id),
      lead_id: contact.lead_id,
      client_id: contact.client_id,
      items,
      subtotal,
      discount,
      tax_rate: 0,
      tax_amount: 0,
      grand_total: grandTotal,
      currency: "LKR",
      valid_until: validUntil,
      terms: "50% deposit to start, balance on delivery.",
      status: "sent",
      sent_at: new Date().toISOString(),
      created_by: null,
    })
    .select("share_token")
    .single();
  if (error || !quote) {
    return { ok: false, result: error?.message ?? "Could not create the quote." };
  }

  if (contact.lead_id) {
    await supabase
      .from("leads")
      .update({ value: grandTotal, score: "hot", score_reason: "Agreed to a package — quote sent" })
      .eq("id", contact.lead_id);
  }

  const link = appLink(`/q/${quote.share_token}`)!;
  const firstName = customerName.split(/\s+/)[0] || "there";
  const sent = await sendAndLogWa(supabase, {
    contact,
    body: `${firstName}, here's your formal quotation ${quoteNumber} — *${money(grandTotal)}*${discount > 0 ? ` (${money(discount)} off applied)` : ""} ✍️\nYou can review and sign it right on your phone 👇\n${link}\nValid until ${validUntil}.`,
    sentBy: "agent",
  });
  if (!sent.ok) {
    return {
      ok: false,
      result: `Quote ${quoteNumber} was created but the WhatsApp send failed (${sent.error ?? "unknown"}). Apologize briefly and say the quote is on its way.`,
    };
  }

  await notifyEveryone(supabase, {
    title: "Agent sent a signable quote ✍️",
    body: `${customerName} — ${quoteNumber} (${money(grandTotal)}). Waiting for their signature.`,
    link: contact.lead_id ? `/crm/lead/${contact.lead_id}` : "/invoices?tab=quotes",
  });

  return {
    ok: true,
    result: `Quote ${quoteNumber} (${money(grandTotal)} total) was created and the signing link is ALREADY delivered in this chat.${discountNote} Now send ONE short human message: they can open it and sign right on their phone, and the moment they sign we get started. Do NOT paste the link again.`,
  };
}

// ---- research-complete follow-up -------------------------------------------

/**
 * Fired by the research pipeline the moment a lead's deep-research report
 * lands. If that lead came from WhatsApp (and the agent is still on for the
 * conversation), the agent sends ONE unprompted follow-up that casually
 * shows it now knows the customer's business inside-out — without ever
 * mentioning that any "research" happened.
 */
export async function sendWaResearchFollowup(
  supabase: DB,
  researchId: string,
): Promise<void> {
  try {
    const { data: research } = await supabase
      .from("lead_research")
      .select("id, lead_id, company_name, status, report")
      .eq("id", researchId)
      .maybeSingle();
    if (!research || research.status !== "done" || !research.lead_id) return;

    const { data: contact } = await supabase
      .from("wa_contacts")
      .select("*")
      .eq("lead_id", research.lead_id)
      .maybeSingle();
    if (!contact || !contact.agent_enabled) return;

    const config = await getWaAgentConfig(supabase);
    if (!config.enabled || !isOpenAIConfigured()) return;

    // One follow-up per research run, even if two workers see "done".
    const { data: already } = await supabase
      .from("wa_agent_logs")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("tool", "research_followup")
      .eq("args->>research_id", researchId)
      .limit(1);
    if (already?.length) return;
    await supabase.from("wa_agent_logs").insert({
      contact_id: contact.id,
      tool: "research_followup",
      args: { research_id: researchId, company: research.company_name },
      ok: true,
      result: "Post-research follow-up message",
    });

    const { data: history } = await supabase
      .from("wa_messages")
      .select("direction, body")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_MESSAGES);
    const thread: ChatMessage[] = (history ?? [])
      .reverse()
      .filter((m) => m.body.trim())
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.body,
      }));

    const briefing = JSON.stringify(research.report ?? {}).slice(0, 4500);
    const messages: ChatMessage[] = [
      { role: "system", content: await buildSystemPrompt(supabase, contact, config) },
      ...thread,
      {
        role: "system",
        content: `Your homework on ${research.company_name} just landed (the customer knows nothing about it):\n${briefing}\n\nSend ONE short, natural follow-up message now — like a consultant who's genuinely been thinking about their business since the last message. Casually show you know your stuff: reference 1-2 REAL specifics from the briefing (what they do, their market/reputation/competitors, or a concrete website problem) and connect it to how we'd help. NEVER mention research, reports, audits or tools — you just know. Human voice, max 3-4 sentences, end with exactly one question or next step.`,
      },
    ];

    const model = process.env.OPENAI_WHATSAPP_MODEL?.trim() || undefined;
    const reply = await openaiChat(messages, undefined, { model });
    const text = (reply.content ?? "").trim();
    if (text) {
      await sendAndLogWa(supabase, { contact, body: text, sentBy: "agent" });
    }
  } catch (e) {
    console.error("[wa-agent] research follow-up failed:", e);
  }
}

// ---------------------------------------------------------------------------
// The agent-run queue — inbound replies, drained by the automation tick
// ---------------------------------------------------------------------------

/**
 * Run every due queued agent reply. Called by the automation tick every
 * minute; the webhook arms `agent_due_at` per inbound message (debounced),
 * so one run answers a whole burst with full history.
 */
export async function processDueWaAgentRuns(
  supabase: DB,
): Promise<{ processed: number; replied: number; skipped: number }> {
  const out = { processed: 0, replied: 0, skipped: 0 };
  try {
    if (!isOpenAIConfigured()) return out;
    const config = await getWaAgentConfig(supabase);

    const { data: due } = await supabase
      .from("wa_contacts")
      .select("*")
      .not("agent_due_at", "is", null)
      .lte("agent_due_at", new Date().toISOString())
      .order("agent_due_at")
      .limit(MAX_AGENT_RUNS_PER_TICK);

    for (const contact of due ?? []) {
      out.processed++;

      // Lease, don't clear — if this tick dies mid-run the reply isn't
      // lost: the lease expires and the next tick retries. A retry after a
      // successful send is a no-op thanks to the last_direction guard below
      // (sendAndLogWa flips it to "out").
      const lease = new Date(
        Date.now() + AGENT_LEASE_MINUTES * 60_000,
      ).toISOString();
      const { data: claimed } = await supabase
        .from("wa_contacts")
        .update({ agent_due_at: lease })
        .eq("id", contact.id)
        .eq("agent_due_at", contact.agent_due_at!)
        .select("id");
      // A fresh message re-armed the debounce (or another worker claimed it).
      if (!claimed?.length) continue;

      const release = () =>
        supabase
          .from("wa_contacts")
          .update({ agent_due_at: null })
          .eq("id", contact.id)
          .eq("agent_due_at", lease);

      if (
        !config.enabled ||
        !contact.agent_enabled ||
        contact.do_not_contact ||
        contact.last_direction !== "in"
      ) {
        out.skipped++;
        await release();
        continue;
      }

      // Voice-first customers get a voice note back — mirror what they
      // sent last. Also refresh "typing…" for the compose window (the
      // webhook's indicator may have expired by now).
      const { data: latest } = await supabase
        .from("wa_messages")
        .select("wa_message_id, meta")
        .eq("contact_id", contact.id)
        .eq("direction", "in")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const voice = Boolean(
        (latest?.meta as { voice?: boolean } | null)?.voice,
      );
      if (latest?.wa_message_id) void markWhatsAppRead(latest.wa_message_id);

      try {
        await runWaAgent(supabase, contact, config, { voice });
        out.replied++;
      } finally {
        await release();
      }
    }
  } catch (e) {
    console.error("[wa-agent] agent-run queue failed:", e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Promise tracking — the agent keeps the customer's own commitments
// ---------------------------------------------------------------------------

/**
 * "Call me Monday", "salary comes on the 25th", "let me ask my partner" —
 * the agent captures these with the schedule_promise tool and the tick
 * fires an agent-composed message at exactly that moment. Unlike the
 * generic cadence, promises survive inbound replies (the conversation
 * moving doesn't cancel "salary on the 25th"); the model sees its open
 * promises in every system prompt and cancels the ones that resolve.
 * A pending promise suppresses the 48/72/120h cadence — one nudge track
 * per contact at a time.
 */
const MAX_PROMISES_PER_TICK = 3;
/** Beyond this horizon an automatic message is presumptuous — a human task fits better. */
const MAX_PROMISE_DAYS = 60;
const MAX_PENDING_PROMISES = 5;

type WaPromise = Database["public"]["Tables"]["wa_promises"]["Row"];

/**
 * "YYYY-MM-DD" + "HH:mm" wall-clock in `timezone` → UTC Date. Two-pass
 * Intl shift, no date library: guess the instant as if the wall-clock were
 * UTC, read that instant back in the timezone, correct by the difference.
 * (Asia/Colombo has no DST so one pass converges; loop twice for others.)
 */
function localToUtc(date: string, time: string, timezone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(wallUtc)) return null;
  let guess = wallUtc;
  try {
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date(guess));
      const get = (type: string) =>
        Number(parts.find((p) => p.type === type)?.value ?? NaN);
      const seen = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
      );
      if (!Number.isFinite(seen)) return null;
      guess += wallUtc - seen;
    }
  } catch {
    // Bad timezone string — degrade to treating the wall-clock as UTC.
    return new Date(wallUtc);
  }
  return new Date(guess);
}

/** "Tuesday, 14 Jul 2026, 15:30" in the workspace timezone — for prompts and tool results. */
function formatInTimezone(at: Date | string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

async function toolSchedulePromise(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  if (contact.do_not_contact)
    return { ok: false, result: "This contact opted out — never schedule messages for them." };
  const tz = config.timezone || "Asia/Colombo";
  const summary = String(args.summary ?? "").trim();
  if (!summary)
    return { ok: false, result: "Describe what they committed to in `summary`." };
  const due = localToUtc(
    String(args.due_date ?? ""),
    String(args.due_time ?? "").trim() || "10:00",
    tz,
  );
  if (!due)
    return {
      ok: false,
      result: 'Could not parse the time — pass due_date as "YYYY-MM-DD" and due_time as "HH:mm" (24h, local).',
    };
  if (due.getTime() <= Date.now())
    return {
      ok: false,
      result: `That moment already passed — it is now ${formatInTimezone(new Date(), tz)} (${tz}). Pick the next sensible occurrence.`,
    };
  if (due.getTime() > Date.now() + MAX_PROMISE_DAYS * 24 * 3600_000)
    return {
      ok: false,
      result: `That's more than ${MAX_PROMISE_DAYS} days out — too far for an automatic follow-up. Use schedule_followup to remind the team instead.`,
    };

  const sourceQuote = String(args.source_quote ?? "").trim() || null;

  // Same-moment dedupe: a lease retry (or an over-eager second call) updates
  // the existing promise instead of stacking a duplicate nudge.
  const { data: pending } = await supabase
    .from("wa_promises")
    .select("id, due_at")
    .eq("contact_id", contact.id)
    .eq("status", "pending");
  const near = (pending ?? []).find(
    (p) => Math.abs(new Date(p.due_at).getTime() - due.getTime()) < 3600_000,
  );
  if (near) {
    await supabase
      .from("wa_promises")
      .update({ summary, source_quote: sourceQuote, due_at: due.toISOString() })
      .eq("id", near.id);
    return {
      ok: true,
      result: `Updated the existing scheduled follow-up — you'll automatically message them ${formatInTimezone(due, tz)}.`,
    };
  }
  if ((pending ?? []).length >= MAX_PENDING_PROMISES)
    return {
      ok: false,
      result: `This contact already has ${MAX_PENDING_PROMISES} scheduled follow-ups — cancel one with cancel_promise first.`,
    };

  const { error } = await supabase.from("wa_promises").insert({
    contact_id: contact.id,
    summary,
    source_quote: sourceQuote,
    due_at: due.toISOString(),
  });
  if (error) return { ok: false, result: error.message };

  // The promise IS the next touch — pause the generic quiet-chat cadence.
  await supabase
    .from("wa_contacts")
    .update({ next_followup_at: null })
    .eq("id", contact.id);
  contact.next_followup_at = null;

  return {
    ok: true,
    result: `Done — you'll automatically follow up ${formatInTimezone(due, tz)} (${tz}). Acknowledge it naturally in your reply; never mention reminders or systems.`,
  };
}

async function toolCancelPromise(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<WaToolOutcome> {
  const id = String(args.promise_id ?? "").trim();
  if (!id)
    return { ok: false, result: "Pass promise_id exactly as shown in the OPEN PROMISES list." };
  const outcome = String(args.outcome ?? "").trim() || "no_longer_relevant";
  const reason = String(args.reason ?? "").trim();
  const { data: cancelled } = await supabase
    .from("wa_promises")
    .update({ status: "cancelled", result: reason ? `${outcome}: ${reason}` : outcome })
    .eq("id", id)
    .eq("contact_id", contact.id)
    .eq("status", "pending")
    .select("id");
  if (!cancelled?.length)
    return { ok: false, result: "No pending promise with that id — check the OPEN PROMISES list." };

  // Nothing else scheduled and they still owe a reply → the generic
  // cadence takes back over from the agent's last outbound message.
  const { data: remaining } = await supabase
    .from("wa_promises")
    .select("id")
    .eq("contact_id", contact.id)
    .eq("status", "pending")
    .limit(1);
  if (!remaining?.length && contact.last_direction === "out") {
    await scheduleNextFollowup(supabase, contact.id);
  }
  return { ok: true, result: "Promise cancelled." };
}

/** Called by the automation tick — fires every due promised follow-up. */
export async function processDueWaPromises(
  supabase: DB,
): Promise<{ processed: number; sent: number; skipped: number }> {
  const out = { processed: 0, sent: 0, skipped: 0 };
  try {
    const config = await getWaAgentConfig(supabase);
    if (!config.enabled || !config.followups_enabled) return out;

    const { data: due } = await supabase
      .from("wa_promises")
      .select("*")
      .eq("status", "pending")
      .lte("due_at", new Date().toISOString())
      .order("due_at")
      .limit(MAX_PROMISES_PER_TICK);

    for (const promise of due ?? []) {
      const { data: contact } = await supabase
        .from("wa_contacts")
        .select("*")
        .eq("id", promise.contact_id)
        .maybeSingle();
      if (!contact) continue;
      out.processed++;

      // They're mid-conversation (a reply run is queued) — nudge the
      // promise out a few minutes instead of colliding with the live reply.
      if (contact.agent_due_at) {
        await supabase
          .from("wa_promises")
          .update({ due_at: new Date(Date.now() + 5 * 60_000).toISOString() })
          .eq("id", promise.id)
          .eq("due_at", promise.due_at);
        out.skipped++;
        continue;
      }

      // Quiet hours: a promised late-night ping shifts to morning like
      // every other nudge (replies stay 24/7 — this is agent-initiated).
      if (isQuietHours(config)) {
        const resume = nextQuietHoursEnd(config).toISOString();
        const { data: deferred } = await supabase
          .from("wa_promises")
          .update({ due_at: resume })
          .eq("id", promise.id)
          .eq("due_at", promise.due_at)
          .select("id");
        if (deferred?.length) {
          out.skipped++;
          await logPromise(supabase, promise, true, `Deferred to ${resume} — quiet hours`);
        }
        continue;
      }

      // Claim first — a crash beyond this point must never double-send.
      const { data: claimed } = await supabase
        .from("wa_promises")
        .update({ status: "sent" })
        .eq("id", promise.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      const skip = await promiseSkipReason(supabase, contact);
      if (skip) {
        out.skipped++;
        await supabase
          .from("wa_promises")
          .update({ result: `Skipped: ${skip}` })
          .eq("id", promise.id);
        await logPromise(supabase, promise, true, `Skipped: ${skip}`);
        continue;
      }

      const withinWindow =
        !!contact.last_inbound_at &&
        Date.now() - new Date(contact.last_inbound_at).getTime() < 24 * 3600_000;

      if (withinWindow && isOpenAIConfigured()) {
        const sent = await sendPromiseTouch(supabase, contact, config, promise);
        if (sent) out.sent++;
        await supabase
          .from("wa_promises")
          .update({ result: sent ? "Promise follow-up sent" : "Compose/send failed — nothing was sent" })
          .eq("id", promise.id);
        await logPromise(
          supabase,
          promise,
          sent,
          sent ? "Promise follow-up sent" : "Promise follow-up — nothing was sent",
        );
      } else if (config.followup_template_name?.trim()) {
        // Outside the free-form window → the approved template.
        const template = config.followup_template_name.trim();
        const sent = await sendWhatsAppTemplate({
          to: contact.wa_id,
          template,
          language: config.followup_template_lang?.trim() || "en",
        });
        await supabase.from("wa_messages").insert({
          contact_id: contact.id,
          wa_message_id: sent.ok ? sent.waMessageId : null,
          direction: "out",
          body: `[template: ${template}]`,
          status: sent.ok ? "sent" : "failed",
          error: sent.ok ? null : sent.error,
          sent_by: "agent",
        });
        if (sent.ok) {
          out.sent++;
          await supabase
            .from("wa_contacts")
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: `[template: ${template}]`,
              last_direction: "out",
            })
            .eq("id", contact.id);
          // If they ignore the template, the generic cadence takes over.
          await scheduleNextFollowup(supabase, contact.id);
        }
        await supabase
          .from("wa_promises")
          .update({
            result: sent.ok
              ? `Sent as template "${template}"`
              : `Template send failed: ${sent.error}`,
          })
          .eq("id", promise.id);
        await logPromise(
          supabase,
          promise,
          sent.ok,
          sent.ok ? `Sent as template "${template}"` : `Template send failed: ${sent.error}`,
        );
      } else {
        // Outside the window and no template — a human has to keep the promise.
        out.skipped++;
        await supabase.from("crm_tasks").insert({
          lead_id: contact.lead_id,
          title: `Promised follow-up due — ${contact.display_name || formatWaPhone(contact.wa_id)}`,
          notes: `The customer's moment has arrived: "${promise.summary}". The 24h WhatsApp window is closed and no approved template is configured, so the agent can't message them itself. Call them or send a template manually.`,
          due_at: new Date().toISOString(),
          created_by: null,
        });
        await supabase
          .from("wa_promises")
          .update({ result: "Outside the 24h window with no template — handed to the team" })
          .eq("id", promise.id);
        await logPromise(
          supabase,
          promise,
          true,
          "Outside the 24h window with no follow-up template — handed to the team.",
        );
      }
    }
  } catch (e) {
    console.error("[wa-agent] promise processing failed:", e);
  }
  return out;
}

/** Why a due promise must NOT be sent — or null when it's good to go. */
async function promiseSkipReason(
  supabase: DB,
  contact: WaContact,
): Promise<string | null> {
  if (contact.do_not_contact) return "contact opted out";
  if (!contact.agent_enabled) return "agent is paused for this chat";
  if (contact.needs_attention) return "chat is flagged for a human";
  if (contact.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("status")
      .eq("id", contact.lead_id)
      .maybeSingle();
    if (lead && lead.status !== "open") return `deal is already ${lead.status}`;
  }
  return null;
}

/** Compose + send one promise follow-up with full conversation context. */
async function sendPromiseTouch(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  promise: WaPromise,
): Promise<boolean> {
  const quoteLine = await buildQuoteStateLine(supabase, contact.lead_id);
  const nudge = `It's now the exact moment the customer asked you to come back to them: ${promise.summary}${promise.source_quote ? ` (their words: "${promise.source_quote}")` : ""}. Send ONE short, natural message that picks the conversation up right on that promise — reference what they said they'd do or what was supposed to happen, like a sharp human who simply remembered. NEVER say "just following up" and never mention schedules, reminders or systems. Human voice, max 3 sentences, end with exactly one easy question or next step.${quoteLine}`;

  const { data: history } = await supabase
    .from("wa_messages")
    .select("direction, body")
    .eq("contact_id", contact.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_MESSAGES);
  const thread: ChatMessage[] = (history ?? [])
    .reverse()
    .filter((m) => m.body.trim())
    .map((m) => ({
      role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt(supabase, contact, config) },
    ...thread,
    { role: "system", content: nudge },
  ];

  const model = process.env.OPENAI_WHATSAPP_MODEL?.trim() || undefined;
  let text = "";
  try {
    const reply = await openaiChat(messages, undefined, { model });
    text = (reply.content ?? "").trim();
  } catch (e) {
    console.error("[wa-agent] promise compose failed:", e);
    return false;
  }
  if (!text) return false;

  // sendAndLogWa arms the generic cadence afterwards — if they ignore the
  // kept promise, the ordinary 48h chase takes over naturally.
  const sent = await sendAndLogWa(supabase, { contact, body: text, sentBy: "agent" });
  return sent.ok;
}

/** Cancel every pending promise for a contact (opt-out, manual block). */
export async function cancelPendingWaPromises(
  supabase: DB,
  contactId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("wa_promises")
    .update({ status: "cancelled", result: reason })
    .eq("contact_id", contactId)
    .eq("status", "pending");
}

async function logPromise(
  supabase: DB,
  promise: WaPromise,
  ok: boolean,
  result: string,
): Promise<void> {
  await supabase.from("wa_agent_logs").insert({
    contact_id: promise.contact_id,
    tool: "promise",
    args: { promise_id: promise.id, summary: promise.summary, due_at: promise.due_at },
    ok,
    result,
  });
}

// ---------------------------------------------------------------------------
// Quiet hours — the agent never sleeps, but its NUDGES wait for morning
// ---------------------------------------------------------------------------

/** The hour (0-23) in the workspace's configured timezone. */
function hourInTimezone(timezone: string, at: Date): number {
  try {
    return (
      Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "numeric",
          hour12: false,
        }).format(at),
      ) % 24
    );
  } catch {
    // Bad timezone string — degrade to UTC rather than crash a send loop.
    return at.getUTCHours();
  }
}

/**
 * True while agent-INITIATED nudges (follow-up touches, cold outreach,
 * automation reminders) should hold. Replies to customer messages ignore
 * this completely — the agent answers 24/7.
 */
export function isQuietHours(config: WaConfig, at = new Date()): boolean {
  if (!config.quiet_hours_enabled) return false;
  const start = ((Number(config.quiet_hours_start) % 24) + 24) % 24;
  const end = ((Number(config.quiet_hours_end) % 24) + 24) % 24;
  if (start === end) return false;
  const hour = hourInTimezone(config.timezone || "Asia/Colombo", at);
  // 21 → 9 wraps midnight; 1 → 5 doesn't.
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** When the current quiet window ends — deferred nudges resume then. */
export function nextQuietHoursEnd(config: WaConfig, from = new Date()): Date {
  const t = new Date(from);
  // Walk hour boundaries until the window closes — timezone- and DST-proof
  // without a date library, at most 24 steps.
  for (let i = 0; i < 25 && isQuietHours(config, t); i++) {
    t.setMinutes(0, 0, 0);
    t.setTime(t.getTime() + 3600_000);
  }
  // Jitter so a night's deferred nudges don't all fire at the same minute.
  t.setTime(t.getTime() + Math.floor(Math.random() * 40) * 60_000);
  return t;
}

/** True when the lead opened a quote's signing page within the last hour —
 * they're awake and reading it, so the hot nudge beats quiet hours. */
async function hasRecentQuoteView(
  supabase: DB,
  leadId: string | null,
): Promise<boolean> {
  if (!leadId) return false;
  const { data } = await supabase
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .gte("viewed_at", new Date(Date.now() - 3600_000).toISOString())
    .limit(1);
  return Boolean(data?.length);
}

// ---------------------------------------------------------------------------
// The follow-up brain — the agent chases its own quiet deals
// ---------------------------------------------------------------------------

/**
 * Autonomous multi-touch cadence, anchored to the agent's last outbound
 * message and cleared instantly by any inbound reply:
 *
 *   touch 1 after 48h — soft nudge
 *   touch 2 after another 72h — fresh angle (a voice note when the voice
 *                                pipeline is on: nearly impossible to ignore)
 *   touch 3 after another 120h — graceful breakup, lead scored cold
 *
 * Inside Meta's 24h window the agent composes each touch itself with full
 * conversation + deal context. Outside it, the configured approved template
 * is sent instead — or, with no template, a human task is created and the
 * cadence ends.
 */
const FOLLOWUP_DELAY_HOURS: Record<number, number> = { 0: 48, 1: 72, 2: 120 };
const MAX_FOLLOWUP_TOUCHES = 3;
const MAX_FOLLOWUPS_PER_TICK = 4;

/** Arm the next touch after an agent send — never overwrites an earlier one. */
async function scheduleNextFollowup(supabase: DB, contactId: string): Promise<void> {
  const { data: c } = await supabase
    .from("wa_contacts")
    .select("followup_stage, next_followup_at, do_not_contact")
    .eq("id", contactId)
    .maybeSingle();
  if (!c || c.next_followup_at || c.do_not_contact) return;
  const hours = FOLLOWUP_DELAY_HOURS[c.followup_stage ?? 0];
  if (!hours) return; // all touches sent — the cadence is over
  // A pending promise IS the next touch — never stack the generic cadence
  // on top of a moment the customer themselves named.
  const { data: promise } = await supabase
    .from("wa_promises")
    .select("id")
    .eq("contact_id", contactId)
    .eq("status", "pending")
    .limit(1);
  if (promise?.length) return;
  await supabase
    .from("wa_contacts")
    .update({
      next_followup_at: new Date(Date.now() + hours * 3600_000).toISOString(),
    })
    .eq("id", contactId);
}

/** Called by the automation tick — sends every due follow-up touch. */
export async function processDueWaFollowups(
  supabase: DB,
): Promise<{ processed: number; sent: number; skipped: number }> {
  const out = { processed: 0, sent: 0, skipped: 0 };
  try {
    const config = await getWaAgentConfig(supabase);
    if (!config.enabled || !config.followups_enabled) return out;

    const { data: due } = await supabase
      .from("wa_contacts")
      .select("*")
      .not("next_followup_at", "is", null)
      .lte("next_followup_at", new Date().toISOString())
      .order("next_followup_at")
      .limit(MAX_FOLLOWUPS_PER_TICK);

    for (const contact of due ?? []) {
      out.processed++;

      // Quiet hours: nudges wait for morning (the agent still answers
      // customers 24/7 — this only time-shifts self-initiated touches).
      // Exception: they opened the quote within the last hour (the /q
      // page's hot nudge) — they're awake and reading it right now.
      if (isQuietHours(config)) {
        const hot = await hasRecentQuoteView(supabase, contact.lead_id);
        if (!hot) {
          const resume = nextQuietHoursEnd(config).toISOString();
          // Compare-and-set: if they replied meanwhile (which clears the
          // schedule), don't re-arm a morning nudge over it.
          const { data: deferred } = await supabase
            .from("wa_contacts")
            .update({ next_followup_at: resume })
            .eq("id", contact.id)
            .eq("next_followup_at", contact.next_followup_at!)
            .select("id");
          if (deferred?.length) {
            out.skipped++;
            await logFollowup(
              supabase,
              contact.id,
              (contact.followup_stage ?? 0) + 1,
              true,
              `Deferred to ${resume} — quiet hours`,
            );
          }
          continue;
        }
      }

      // Claim first — a crash beyond this point must never double-send.
      await supabase
        .from("wa_contacts")
        .update({ next_followup_at: null })
        .eq("id", contact.id);

      const skip = await followupSkipReason(supabase, contact);
      if (skip) {
        out.skipped++;
        await logFollowup(supabase, contact.id, contact.followup_stage, true, `Skipped: ${skip}`);
        continue;
      }

      const touch = (contact.followup_stage ?? 0) + 1;
      const withinWindow =
        !!contact.last_inbound_at &&
        Date.now() - new Date(contact.last_inbound_at).getTime() < 24 * 3600_000;

      if (withinWindow && isOpenAIConfigured()) {
        // Bump the stage BEFORE sending so sendAndLogWa arms the next
        // touch with the right gap.
        await supabase
          .from("wa_contacts")
          .update({ followup_stage: touch })
          .eq("id", contact.id);
        contact.followup_stage = touch;

        const sent = await sendFollowupTouch(supabase, contact, config, touch);
        if (sent) out.sent++;
        await logFollowup(
          supabase,
          contact.id,
          touch,
          sent,
          sent ? `Touch ${touch}/${MAX_FOLLOWUP_TOUCHES} sent` : `Touch ${touch} — nothing was sent`,
        );
        if (sent && touch >= MAX_FOLLOWUP_TOUCHES) await coolDownLead(supabase, contact);
      } else if (config.followup_template_name?.trim()) {
        // Outside the free-form window → the approved template.
        const template = config.followup_template_name.trim();
        const sent = await sendWhatsAppTemplate({
          to: contact.wa_id,
          template,
          language: config.followup_template_lang?.trim() || "en",
        });
        await supabase.from("wa_messages").insert({
          contact_id: contact.id,
          wa_message_id: sent.ok ? sent.waMessageId : null,
          direction: "out",
          body: `[template: ${template}]`,
          status: sent.ok ? "sent" : "failed",
          error: sent.ok ? null : sent.error,
          sent_by: "agent",
        });
        if (sent.ok) {
          out.sent++;
          const nextHours = FOLLOWUP_DELAY_HOURS[touch];
          await supabase
            .from("wa_contacts")
            .update({
              followup_stage: touch,
              next_followup_at: nextHours
                ? new Date(Date.now() + nextHours * 3600_000).toISOString()
                : null,
              last_message_at: new Date().toISOString(),
              last_message_preview: `[template: ${template}]`,
              last_direction: "out",
            })
            .eq("id", contact.id);
          if (touch >= MAX_FOLLOWUP_TOUCHES) await coolDownLead(supabase, contact);
        }
        await logFollowup(
          supabase,
          contact.id,
          touch,
          sent.ok,
          sent.ok ? `Touch ${touch} sent as template "${template}"` : `Template send failed: ${sent.error}`,
        );
      } else {
        // Outside the window and no template — a human has to take it.
        out.skipped++;
        await supabase.from("crm_tasks").insert({
          lead_id: contact.lead_id,
          title: `Re-engage ${contact.display_name || formatWaPhone(contact.wa_id)} — WhatsApp gone quiet`,
          notes:
            "The 24h WhatsApp window closed and no approved follow-up template is configured, so the agent can't chase this deal itself. Call them or send a template manually.",
          due_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
          created_by: null,
        });
        await logFollowup(
          supabase,
          contact.id,
          touch,
          true,
          "Outside the 24h window with no follow-up template — handed to the team, cadence stopped.",
        );
      }
    }
  } catch (e) {
    console.error("[wa-agent] follow-up processing failed:", e);
  }
  return out;
}

/** Why a due follow-up must NOT be sent — or null when it's good to go. */
async function followupSkipReason(
  supabase: DB,
  contact: WaContact,
): Promise<string | null> {
  if (contact.do_not_contact) return "contact opted out";
  if (!contact.agent_enabled) return "agent is paused for this chat";
  if (contact.needs_attention) return "chat is flagged for a human";
  if ((contact.followup_stage ?? 0) >= MAX_FOLLOWUP_TOUCHES) return "cadence already complete";
  if (contact.last_direction !== "out") return "they already replied";
  {
    // Belt-and-braces: a cadence armed before the promise existed must
    // yield to it (the promise processor is the one nudge track).
    const { data: promise } = await supabase
      .from("wa_promises")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("status", "pending")
      .limit(1);
    if (promise?.length) return "a promise follow-up is pending";
  }
  if (contact.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("status")
      .eq("id", contact.lead_id)
      .maybeSingle();
    if (lead && lead.status !== "open") return `deal is already ${lead.status}`;
  }
  return null;
}

/** One DEAL STATE line when a signable quote sits unsigned — sharpens a nudge. */
async function buildQuoteStateLine(
  supabase: DB,
  leadId: string | null,
): Promise<string> {
  if (!leadId) return "";
  const { data: q } = await supabase
    .from("quotes")
    .select("quote_number, status, grand_total, currency, valid_until, viewed_at")
    .eq("lead_id", leadId)
    .in("status", ["sent", "viewed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!q) return "";
  const justViewed =
    !!q.viewed_at && Date.now() - new Date(q.viewed_at).getTime() < 3600_000;
  return `\nDEAL STATE: quote ${q.quote_number} (${q.currency} ${Number(q.grand_total).toLocaleString()}) is awaiting their signature${q.status === "viewed" ? " — they HAVE opened it" : " — not opened yet"}${justViewed ? ". They were looking at it just minutes ago — this is a hot moment, reference it naturally and invite questions" : ""}${q.valid_until ? `; it's valid until ${q.valid_until}` : ""}.`;
}

/** Compose + send one AI follow-up touch (touch 2 goes out as a voice note). */
async function sendFollowupTouch(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
  touch: number,
): Promise<boolean> {
  // Deal state sharpens the nudge: is a signable quote sitting unsigned?
  const quoteLine = await buildQuoteStateLine(supabase, contact.lead_id);

  const nudge =
    touch >= MAX_FOLLOWUP_TOUCHES
      ? `The customer went quiet after your last message. This is follow-up touch 3 of 3 — the graceful breakup. Send ONE warm, zero-pressure goodbye: you get that now might not be the right time, the door stays open, they can pick this up whenever they're ready. No question at the end this time, no guilt. Max 2-3 sentences.${quoteLine}`
      : `The customer went quiet after your last message. This is follow-up touch ${touch} of 3. Send ONE short, casual re-engagement message with a FRESH angle — never "just following up": reference something concrete you know about their business or website (from the chat, the audit, or your background knowledge) and tie it to a reason to act${touch === 1 ? ". Keep it light and helpful" : ". Add gentle urgency or a new benefit they haven't heard yet"}. Human voice, max 3 sentences, end with exactly one easy question or next step.${quoteLine}`;

  const { data: history } = await supabase
    .from("wa_messages")
    .select("direction, body")
    .eq("contact_id", contact.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_MESSAGES);
  const thread: ChatMessage[] = (history ?? [])
    .reverse()
    .filter((m) => m.body.trim())
    .map((m) => ({
      role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt(supabase, contact, config) },
    ...thread,
    { role: "system", content: nudge },
  ];

  const model = process.env.OPENAI_WHATSAPP_MODEL?.trim() || undefined;
  let text = "";
  try {
    const reply = await openaiChat(messages, undefined, { model });
    text = (reply.content ?? "").trim();
  } catch (e) {
    console.error("[wa-agent] follow-up compose failed:", e);
    return false;
  }
  if (!text) return false;

  // Touch 2 lands as a voice note when the voice pipeline is on — a voice
  // message from "a real person" gets heard. Falls back to plain text.
  if (touch === 2 && config.voice_replies === "match") {
    const spoke = await sendVoiceReply(supabase, contact, text);
    if (spoke) {
      await scheduleNextFollowup(supabase, contact.id);
      return true;
    }
  }
  const sent = await sendAndLogWa(supabase, { contact, body: text, sentBy: "agent" });
  return sent.ok;
}

/** After the breakup touch: score the lead cold and note why. */
async function coolDownLead(supabase: DB, contact: WaContact): Promise<void> {
  if (!contact.lead_id) return;
  await supabase
    .from("leads")
    .update({ score: "cold", score_reason: "No response after 3 automated follow-ups" })
    .eq("id", contact.lead_id);
  await supabase.from("lead_activities").insert({
    lead_id: contact.lead_id,
    kind: "note",
    title: "Follow-up cadence complete — breakup sent",
    body: "The agent sent all 3 follow-up touches with no reply. Lead scored cold.",
    actor_id: null,
  });
}

async function logFollowup(
  supabase: DB,
  contactId: string,
  touch: number,
  ok: boolean,
  result: string,
): Promise<void> {
  await supabase.from("wa_agent_logs").insert({
    contact_id: contactId,
    tool: "followup",
    args: { touch },
    ok,
    result,
  });
}

// ---------------------------------------------------------------------------
// Opt-out hardening — "stop" means stop, instantly and forever
// ---------------------------------------------------------------------------

const OPT_OUT_PHRASES = [
  "stop",
  "unsubscribe",
  "opt out",
  "don't message",
  "dont message",
  "stop messaging",
  "not interested",
  "no longer interested",
  "remove me",
  "leave me alone",
  "එපා", // Sinhala: "no / don't"
  "අවශ්‍ය නැහැ", // Sinhala: "not needed"
  "වුවමනා නැහැ",
  "வேண்டாம்", // Tamil: "don't want"
];

/** True when a short inbound message reads as "stop contacting me". */
export function detectWaOptOut(body: string): boolean {
  const text = body.trim().toLowerCase();
  // Real opt-outs are short; long messages mentioning "stop" are conversation.
  if (!text || text.length > 80) return false;
  return OPT_OUT_PHRASES.some(
    (p) => text === p || (p.length > 4 && text.includes(p)),
  );
}

/**
 * Flag the contact do-not-contact, kill the cadence, close the lead and say
 * one polite goodbye. Every automated send path checks the flag afterwards;
 * this protects the number's Meta quality rating (blocks hurt it badly).
 */
export async function handleWaOptOut(supabase: DB, contact: WaContact): Promise<void> {
  await supabase
    .from("wa_contacts")
    .update({
      do_not_contact: true,
      followup_stage: 0,
      next_followup_at: null,
      agent_due_at: null,
    })
    .eq("id", contact.id);
  contact.do_not_contact = true;
  await cancelPendingWaPromises(supabase, contact.id, "contact opted out");

  if (contact.lead_id) {
    await supabase
      .from("leads")
      .update({ status: "lost", score: "cold", score_reason: "Opted out on WhatsApp" })
      .eq("id", contact.lead_id);
    await supabase.from("lead_activities").insert({
      lead_id: contact.lead_id,
      kind: "note",
      title: "Opted out on WhatsApp",
      body: "The contact asked not to be messaged. All automated WhatsApp messaging is now blocked for them; the team can still write manually.",
      actor_id: null,
    });
  }

  // One polite goodbye — they just messaged us, so the window is open.
  await sendAndLogWa(supabase, {
    contact,
    body: "No problem at all — we won't message you again. If you ever change your mind, just drop us a text here anytime 👍",
    sentBy: "keyword",
  });
  await notifyEveryone(supabase, {
    title: "WhatsApp opt-out",
    body: `${contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id)} asked not to be contacted — automated messaging stopped, lead closed as lost.`,
    link: "/whatsapp",
  });
}

// ---------------------------------------------------------------------------
// Payment slips — the money-moment watcher (vision-classified inbound media)
// ---------------------------------------------------------------------------

export type InboundSlipInfo = {
  /** The 📷/📄 body line already stored on the message. */
  description: string;
  mediaUrl: string | null;
  slip?: {
    amount?: number | null;
    currency?: string | null;
    date?: string | null;
    bank?: string | null;
    reference?: string | null;
  } | null;
  /** For images/documents that only MIGHT be a slip: stay silent unless an
   * unpaid installment is actually waiting for this contact. */
  requirePendingInstallment?: boolean;
};

/**
 * A customer sent what looks like a payment slip. NEVER marks anything as
 * paid — money is verified by a human: the team gets an urgent task + push
 * with the slip, and marking the installment paid in Finance fires the
 * payment_received kickoff automation exactly as before.
 */
export async function handleInboundPaymentSlip(
  supabase: DB,
  contact: WaContact,
  info: InboundSlipInfo,
): Promise<void> {
  try {
    // The pending installment this slip most likely pays.
    let pending: { seq: number; amount: number; planTitle: string; currency: string } | null =
      null;
    if (contact.lead_id || contact.client_id) {
      const ors: string[] = [];
      if (contact.lead_id) ors.push(`lead_id.eq.${contact.lead_id}`);
      if (contact.client_id) ors.push(`client_id.eq.${contact.client_id}`);
      const { data: plans } = await supabase
        .from("payment_plans")
        .select("id, title, currency")
        .or(ors.join(","))
        .order("created_at", { ascending: false })
        .limit(5);
      if (plans?.length) {
        const byId = new Map(plans.map((p) => [p.id, p]));
        const { data: inst } = await supabase
          .from("payment_installments")
          .select("seq, amount, plan_id")
          .in("plan_id", plans.map((p) => p.id))
          .eq("status", "pending")
          .order("seq")
          .limit(1);
        const first = inst?.[0];
        if (first) {
          const plan = byId.get(first.plan_id);
          pending = {
            seq: first.seq,
            amount: Number(first.amount),
            planTitle: plan?.title ?? "payment plan",
            currency: plan?.currency ?? "LKR",
          };
        }
      }
    }
    if (info.requirePendingInstallment && !pending) return;

    const name =
      contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id);
    const extracted = info.slip
      ? Object.entries(info.slip)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "";

    const expectLine = pending
      ? `Expected: installment ${pending.seq} of "${pending.planTitle}" — ${pending.currency} ${pending.amount.toLocaleString()}.`
      : "No pending installment found in Finance — double-check what this payment is for.";

    await supabase.from("crm_tasks").insert({
      lead_id: contact.lead_id,
      title: `Verify payment slip — ${name}`,
      notes: [
        info.description,
        extracted ? `Slip reads: ${extracted}.` : null,
        expectLine,
        info.mediaUrl ? `Slip: ${info.mediaUrl}` : "See the WhatsApp chat for the attachment.",
        "Once the money is confirmed, mark the installment paid in Finance — that fires the kickoff automation and messages the customer automatically.",
      ]
        .filter(Boolean)
        .join("\n"),
      due_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      created_by: null,
    });

    await notifyEveryone(supabase, {
      title: "💰 Payment slip received",
      body: `${name}${extracted ? ` — ${extracted}` : ""}${pending ? ` (installment ${pending.seq}: ${pending.currency} ${pending.amount.toLocaleString()})` : ""}`,
      link: "/whatsapp",
    });

    if (contact.lead_id) {
      await supabase.from("lead_activities").insert({
        lead_id: contact.lead_id,
        kind: "note",
        title: "Payment slip received on WhatsApp",
        body: [info.description, extracted ? `Slip reads: ${extracted}` : null, info.mediaUrl]
          .filter(Boolean)
          .join("\n"),
        actor_id: null,
      });
    }

    // Audit trail alongside the agent's tool calls.
    await supabase.from("wa_agent_logs").insert({
      contact_id: contact.id,
      tool: "payment_slip",
      args: (info.slip ?? {}) as Record<string, unknown>,
      ok: true,
      result: `Slip flagged for verification. ${expectLine}`.slice(0, 500),
    });
  } catch (e) {
    console.error("[wa-agent] payment slip handling failed:", e);
  }
}

// ---- manual CRM link (used by the inbox UI's "Add to CRM" button) ----------

export async function linkWaContactToCrm(
  supabase: DB,
  contactId: string,
  name?: string,
): Promise<{ ok: boolean; error?: string; leadId?: string | null }> {
  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("*")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return { ok: false, error: "Contact not found." };

  const config = await getWaAgentConfig(supabase);
  const resolved =
    name?.trim() ||
    contact.display_name ||
    contact.profile_name ||
    formatWaPhone(contact.wa_id);
  // A manual "Add to CRM" click always creates the lead, whatever the toggle.
  const outcome = await toolSaveContact(
    supabase,
    contact,
    { ...config, auto_create_lead: true },
    { name: resolved },
  );
  return outcome.ok
    ? { ok: true, leadId: contact.lead_id }
    : { ok: false, error: outcome.result };
}

// ---- shared ------------------------------------------------------------------

async function notifyEveryone(
  supabase: DB,
  opts: { title: string; body: string | null; link: string; sms?: string | null },
): Promise<number> {
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, phone, full_name");

  // Urgent alerts (human takeover, notify_team) ALSO go out as SMS — an
  // in-app/push notification can sit unseen for hours, but a text lands on the
  // phone. Recipients: every teammate with a number on file, plus any extra
  // numbers in TEAM_ALERT_PHONE (comma/space separated) for an ops mobile that
  // isn't a login. Deduped, and never sent for routine (sms-less) notifies.
  const smsText = opts.sms?.trim().slice(0, SMS_MAX_LENGTH) || null;
  const smsReady = Boolean(smsText) && isSmsConfigured();
  const smsSeen = new Set<string>();
  const sendAlertSms = async (rawPhone: string, name: string) => {
    const phone = normalizePhone(rawPhone);
    if (!phone.ok || smsSeen.has(phone.value)) return;
    smsSeen.add(phone.value);
    const sent = await sendSms({
      to: phone.value,
      message: smsText!,
      contactName: name || undefined,
    });
    await supabase.from("sms_messages").insert({
      to_number: phone.value,
      message: smsText!,
      client_name: name,
      kind: "team_alert",
      status: sent.ok ? "sent" : "failed",
      error: sent.ok ? null : sent.error,
      segments: countSmsSegments(smsText!),
      created_by: null,
    });
  };

  for (const p of profiles ?? []) {
    await supabase.from("notifications").insert({
      user_id: p.id,
      type: "system",
      title: opts.title,
      body: opts.body,
      link: opts.link,
    });
    await sendPushToUser({
      userId: p.id,
      title: opts.title,
      body: opts.body || opts.title,
      link: opts.link,
    });
    if (smsReady && p.phone) await sendAlertSms(p.phone, p.full_name ?? "");
  }

  if (smsReady) {
    const extra = (process.env.TEAM_ALERT_PHONE ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const num of extra) await sendAlertSms(num, "Team");
  }

  return profiles?.length ?? 0;
}
