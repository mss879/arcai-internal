import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, WaSentBy } from "@/lib/database.types";
import {
  isOpenAIConfigured,
  openaiChat,
  type ChatMessage,
  type ToolSchema,
} from "@/lib/ai/openai";
import { generateProposalContent } from "@/lib/ai/proposal";
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
import { startLeadResearch } from "@/lib/research";
import { WA_TOOL_CATALOG } from "@/lib/wa-tools-catalog";
import { formatWaPhone, sendWhatsAppText } from "@/lib/whatsapp";

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
 *      globally and for this contact — the AI agent answers, using ONLY
 *      the tools ticked in wa_agent_config.allowed_tools.
 *
 * Every tool invocation is written to wa_agent_logs so the team can audit
 * exactly what the agent did and when.
 */

const MAX_TOOL_ROUNDS = 5;
const HISTORY_MESSAGES = 30;

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

  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

// ---------------------------------------------------------------------------
// Inbound orchestration
// ---------------------------------------------------------------------------

/**
 * Handle one stored inbound message end-to-end. Never throws — a broken
 * agent must not make the webhook fail (Meta would retry / disable it).
 */
export async function handleInboundWaMessage(
  supabase: DB,
  contact: WaContact,
  messageBody: string,
  waMessageId: string | null,
): Promise<void> {
  try {
    const config = await getWaAgentConfig(supabase);

    // 1. Keyword rules — instant, deterministic, run before the AI.
    const suppressAgent = await runKeywordRules(supabase, contact, messageBody);

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

    // 3. The AI agent.
    if (suppressAgent) return;
    if (!config.enabled || !contact.agent_enabled) return;
    if (!isOpenAIConfigured()) return;

    await runWaAgent(supabase, contact, config);
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
      await notifyEveryone(supabase, {
        title: rule.handoff ? "WhatsApp — human takeover needed" : "WhatsApp keyword matched",
        body: `${contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id)}: "${messageBody.slice(0, 120)}"`,
        link: "/whatsapp",
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
      await sendAndLogWa(supabase, { contact, body: text, sentBy: "agent" });
    }
    return;
  }
}

async function buildSystemPrompt(
  supabase: DB,
  contact: WaContact,
  config: WaConfig,
): Promise<string> {
  const name = contact.display_name || null;
  const known: string[] = [];
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
- SHORT messages. 1-3 sentences, like real texting. Never send walls of text or bullet lists longer than 3 items.
- Mirror their energy and language — casual if they're casual, formal if they're formal; reply in English, Sinhala or Tamil, whichever they use.
- BANNED: "As an AI", "I understand your concern", "Certainly!", "How may I assist you today", "I apologize for any inconvenience" — anything that smells like a call center or a bot. If someone directly asks if you're a bot, be honest and light: you're Arc, the agency's digital assistant, and a teammate can jump in anytime.
- NEVER invent prices, discounts or delivery dates. Quote ONLY what's in the knowledge base; anything else → "let me get the team to confirm that."`,
    `YOUR MISSION — learn everything, lead everything. You always hold the upper hand in the conversation: you ask the questions, you steer, and every message you send ends with exactly ONE question or a clear next step. Never leave a reply hanging with nothing to answer.

INFO CHECKLIST (collect in this order, one at a time, weaving it into natural chat — never interrogate):
1. Their NAME — always first. ${config.ask_name ? "Don't discuss anything substantial until you have it." : ""}
2. Their COMPANY / business name and what they do.
3. Their WEBSITE — always ask "do you have a website at the moment?" once you know the business.
4. What they need, their timeline, and a feel for budget.
5. Their email, and confirm this WhatsApp number is the best contact — slip these in naturally mid-conversation, e.g. when offering to send something.

THE MOMENT you learn their name (and again when you learn company/email), call save_contact. Log every meaningful detail they share with update_lead (note). Buying signals — asking prices, timelines, "can you do X" — mark the lead hot with update_lead.`,
    `IF THEY HAVE A WEBSITE:
- The moment they share the URL, call BOTH audit_website AND research_contact (same turn, before replying).
- Then reply like someone who literally just opened their site on their phone: compliment one genuine thing, then casually drop the 1-2 issues that hurt most ("just had a look — site's taking ages to load on mobile, and Google's basically ignoring your pages, no descriptions set 😬"). Sound like an expert who noticed, not a report.
- A message or two later, call get_research — once it's ready, reference their actual business like you did your homework: what they sell, their area, their competition. You want them thinking "these people already know my business better than my current web guy."
- Then bridge to the fix: what we'd do, the package that fits (knowledge base), and a call — send_booking_link.

IF THEY DON'T HAVE A WEBSITE:
- Totally fine — "actually easier, we start clean 😄". Ask what kind of site they're picturing: business site or online store?
- Then gather: what the business does, must-have features, any sites they like, timeline.
- Give them the fitting package + price straight from the knowledge base, frame it around THEIR goals ("for a bakery doing deliveries, the Growth package makes sense because…").
- Still call research_contact with their business name — reviews and Facebook pages often exist without a website.

CLOSING PLAYS:
- Momentum: offer something concrete and fast — "I can have a plan and exact quote to you today."
- When they're warm: send_booking_link for a quick call. When they're serious and you have requirements: create_proposal and tell them it's on the way.
- If they go quiet after pricing, don't chase with discounts — schedule_followup (2 days) and close warmly.
- Human wanted, frustration, or anything sensitive → handoff_human immediately.`,
    `What you already know about this contact:\n${known.join("\n")}`,
  ];

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
      .select("title, value, status, score, notes, tags")
      .eq("id", contact.lead_id)
      .maybeSingle();
    if (lead) {
      parts.push(
        `Linked CRM lead: ${JSON.stringify({
          title: lead.title,
          value: lead.value,
          status: lead.status,
          score: lead.score,
          tags: lead.tags,
          notes: (lead.notes ?? "").slice(0, 500),
        })}`,
      );
    }
  }

  return parts.join("\n\n");
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
    notify_team: fn("notify_team", "Send an urgent in-app + push notification to the whole team.", {
      title: { type: "string" },
      body: { type: "string" },
    }, ["title"]),
    handoff_human: fn("handoff_human", "Pause the AI for this chat and alert the team that a human must take over.", {
      reason: { type: "string", description: "Why the handoff is needed." },
    }, ["reason"]),
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
        const count = await notifyEveryone(supabase, {
          title: `WhatsApp: ${title}`,
          body: String(args.body ?? "").trim() || null,
          link: "/whatsapp",
        });
        return { ok: true, result: `Notified ${count} team member(s).` };
      }
      case "handoff_human": {
        await supabase
          .from("wa_contacts")
          .update({ agent_enabled: false, needs_attention: true })
          .eq("id", contact.id);
        contact.agent_enabled = false;
        await notifyEveryone(supabase, {
          title: "WhatsApp — human takeover needed",
          body: `${contact.display_name || contact.profile_name || formatWaPhone(contact.wa_id)} — ${String(args.reason ?? "").slice(0, 140)}`,
          link: "/whatsapp",
        });
        return {
          ok: true,
          result:
            "AI paused for this chat and the team was alerted. Tell the customer a team member will continue the conversation shortly, then stop.",
        };
      }
      case "create_proposal":
        return await toolCreateProposal(supabase, contact, args);
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
  const email = String(args.email ?? "").trim() || null;
  const city = String(args.city ?? "").trim() || null;
  const interest = String(args.service_interest ?? "").trim() || null;
  const phonePretty = formatWaPhone(contact.wa_id);

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
    result: `Saved: ${done.join(", ") || "nothing new"}. Continue the conversation naturally — don't mention CRM records.`,
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

  const started = await startLeadResearch(supabase, {
    leadId: contact.lead_id,
    company,
    requestedBy: null,
  });
  return started.ok
    ? {
        ok: true,
        result:
          "Research started — it takes a few minutes. Keep chatting; call get_research later (e.g. on the customer's next message).",
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
      result: `Research status: ${research.status}${research.error ? ` (${research.error})` : ""}. Not ready yet.`,
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
  opts: { title: string; body: string | null; link: string },
): Promise<number> {
  const { data: profiles } = await supabase.from("profiles").select("id");
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
  }
  return profiles?.length ?? 0;
}
