import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, WaInsightOutcome, WaLessonKind } from "@/lib/database.types";
import {
  isOpenAIConfigured,
  openaiChatJSON,
  OpenAIRateLimitError,
} from "@/lib/ai/openai";
import { fetchThread, notifyEveryone } from "@/lib/wa-agent";
import { localDateInTimezone } from "@/lib/wa-coaching";
import { localMinutesOfDay } from "@/lib/wa-cold-outreach";

type DB = SupabaseClient<Database>;

/**
 * The nightly learning loop, in two cheap stages that ride the every-minute
 * automation tick without ever hogging it:
 *
 *   1. ENQUEUE (once per local day, claim-first on insights_ran_for):
 *      every conversation that ENDED yesterday — crossed 48h of silence, or
 *      its lead closed — becomes one pending wa_convo_insights row.
 *
 *   2. SCORE (every tick, ≤2 rows): the thread is read once by the model,
 *      which extracts objections, questions, buying signals, FAQ gaps
 *      ("let me get the team to confirm" moments) and reply-quality flags.
 *      The OUTCOME is decided by CODE, not the model — and a booked call
 *      counts as the AGENT'S WIN: its whole job is give the info, set up
 *      the call. What happens to the deal after that is the team's half.
 *
 *   3. MINE (once per local day, after the queue drains, claim-first on
 *      lessons_ran_for): one model call over the last 14 days of scored
 *      insights proposes up to 5 lessons. They land in wa_lessons as
 *      `pending` — NOTHING reaches the live prompt until the team approves
 *      it on the Lessons card (wa-agent.ts injects approved ones only).
 *
 * Total nightly AI budget: ~2-6 small model calls. Scored rows also feed
 * the Analytics tab (objection frequency, drop-off, quality flags).
 */

/** Silence long enough to call a conversation over (mirrors the coach's
 * ghost line). The enqueue window is [48h, 72h] ago so each day picks up
 * exactly the threads that crossed the line since yesterday's run. */
const CONVO_ENDS_AFTER_MS = 48 * 3600_000;
const ENQUEUE_WINDOW_MS = 72 * 3600_000;
/** Per-day and per-tick caps — the tick must stay fast. */
const MAX_ENQUEUE_PER_DAY = 40;
const INSIGHTS_PER_TICK = 2;
const MAX_SCORE_ATTEMPTS = 2;
/** How far back the lesson miner reads scored conversations. */
const MINER_LOOKBACK_DAYS = 14;
const MAX_LESSONS_PER_RUN = 5;

const VALID_KINDS: WaLessonKind[] = [
  "objection_rebuttal",
  "faq",
  "phrasing",
  "playbook",
];

export async function processWaInsights(
  supabase: DB,
): Promise<{ enqueued: number; scored: number; lessons: number }> {
  const out = { enqueued: 0, scored: 0, lessons: 0 };
  try {
    if (!isOpenAIConfigured()) return out;

    const { data: config } = await supabase
      .from("wa_agent_config")
      .select("timezone, insights_ran_for, lessons_ran_for")
      .eq("id", 1)
      .maybeSingle();
    if (!config) return out;
    const tz = config.timezone || "Asia/Colombo";
    const today = localDateInTimezone(tz);

    out.enqueued = await enqueueEndedConversations(
      supabase,
      config.insights_ran_for,
      today,
    );
    out.scored = await scorePendingInsights(supabase, tz);
    out.lessons = await mineLessons(supabase, config.lessons_ran_for, today);
  } catch (e) {
    console.error("[wa-insights] run failed:", e);
  }
  return out;
}

/** Stage 1 — one pending row per conversation that ended yesterday. */
async function enqueueEndedConversations(
  supabase: DB,
  ranFor: string | null,
  today: string,
): Promise<number> {
  if (ranFor === today) return 0;

  // Claim-first (coaching_ran_for pattern) so concurrent ticks can't double-enqueue.
  const { data: claimed } = await supabase
    .from("wa_agent_config")
    .update({ insights_ran_for: today })
    .eq("id", 1)
    .or(`insights_ran_for.is.null,insights_ran_for.neq.${today}`)
    .select("id");
  if (!claimed?.length) return 0;

  // Rides the same once-a-day claim: week-old declined quotes become
  // win-back tasks for the team (never an autonomous re-offer).
  await queueDeclinedWinbacks(supabase);

  const now = Date.now();
  const rows: Database["public"]["Tables"]["wa_convo_insights"]["Insert"][] = [];

  // Ended by silence: last message crossed the 48h line within the last day.
  // last_inbound_at is required — a template blast nobody answered is the
  // cold module's statistic, not a conversation.
  const { data: silent } = await supabase
    .from("wa_contacts")
    .select("id, lead_id, campaign_id, language, last_message_at")
    .not("last_message_at", "is", null)
    .not("last_inbound_at", "is", null)
    .gte("last_message_at", new Date(now - ENQUEUE_WINDOW_MS).toISOString())
    .lte("last_message_at", new Date(now - CONVO_ENDS_AFTER_MS).toISOString())
    .limit(MAX_ENQUEUE_PER_DAY);
  for (const c of silent ?? []) {
    rows.push({
      contact_id: c.id,
      campaign_id: c.campaign_id,
      lead_id: c.lead_id,
      language: c.language,
      convo_ended_at: new Date(
        new Date(c.last_message_at!).getTime() + CONVO_ENDS_AFTER_MS,
      ).toISOString(),
    });
  }

  // Ended by closing: the lead was won or lost in the last day — score it
  // now instead of waiting out the silence window.
  const { data: closedLeads } = await supabase
    .from("leads")
    .select("id")
    .in("status", ["won", "lost"])
    .gte("updated_at", new Date(now - 24 * 3600_000).toISOString())
    .limit(MAX_ENQUEUE_PER_DAY);
  if (closedLeads?.length) {
    const { data: closedContacts } = await supabase
      .from("wa_contacts")
      .select("id, lead_id, campaign_id, language")
      .in("lead_id", closedLeads.map((l) => l.id))
      .not("last_inbound_at", "is", null);
    for (const c of closedContacts ?? []) {
      if (rows.some((r) => r.contact_id === c.id)) continue;
      rows.push({
        contact_id: c.id,
        campaign_id: c.campaign_id,
        lead_id: c.lead_id,
        language: c.language,
        convo_ended_at: new Date(now).toISOString(),
      });
    }
  }

  if (!rows.length) return 0;
  // ignoreDuplicates: a thread that ended once can't be enqueued twice for
  // the same ending (unique contact_id + convo_ended_at).
  const { error } = await supabase
    .from("wa_convo_insights")
    .upsert(rows.slice(0, MAX_ENQUEUE_PER_DAY), {
      onConflict: "contact_id,convo_ended_at",
      ignoreDuplicates: true,
    });
  if (error) {
    console.error(
      "[wa-insights] enqueue failed (is migration 0073 applied?):",
      error.message,
    );
    return 0;
  }
  console.log(`[wa-insights] enqueued ${rows.length} ended conversations`);
  return rows.length;
}

/**
 * Declined-quote win-back, human-in-the-loop by design: a quote declined
 * exactly a week ago, on a lead that's still open with no newer quote,
 * becomes a CRM task asking the team to approve a revised offer. Repricing
 * beyond the agent's discount authority is a team decision — the agent only
 * handles the conversation after the team sets the direction (its declined
 * DEAL STATE line already keeps it in recovery mode if the customer writes).
 * The [7d, 8d) window + the daily claim means each quote fires exactly once.
 */
async function queueDeclinedWinbacks(supabase: DB): Promise<void> {
  const now = Date.now();
  const { data: declined } = await supabase
    .from("quotes")
    .select(
      "id, quote_number, customer_name, currency, grand_total, declined_reason, declined_at, lead_id, created_at",
    )
    .eq("status", "declined")
    .gte("declined_at", new Date(now - 8 * 86400_000).toISOString())
    .lt("declined_at", new Date(now - 7 * 86400_000).toISOString())
    .limit(10);

  for (const q of declined ?? []) {
    if (!q.lead_id) continue;
    const { data: lead } = await supabase
      .from("leads")
      .select("id, status")
      .eq("id", q.lead_id)
      .maybeSingle();
    if (!lead || lead.status !== "open") continue;
    // A newer quote on the lead means the team already made its move.
    const { data: newer } = await supabase
      .from("quotes")
      .select("id")
      .eq("lead_id", q.lead_id)
      .gt("created_at", q.created_at)
      .limit(1);
    if (newer?.length) continue;

    const { error } = await supabase.from("crm_tasks").insert({
      lead_id: q.lead_id,
      title: `Win-back ${q.customer_name}: declined ${q.quote_number}`,
      notes: `${q.customer_name} declined ${q.quote_number} (${q.currency} ${Number(q.grand_total).toLocaleString()}) a week ago${q.declined_reason ? ` — their reason: "${q.declined_reason}"` : ""} and the lead is still open with no newer quote. Decide the revised offer (price, scope or payment terms) and re-engage — the WhatsApp agent handles the conversation once you set the direction.`,
      due_at: new Date().toISOString(),
      created_by: null,
    });
    if (error) {
      console.error("[wa-insights] win-back task insert failed:", error.message);
      break;
    }
    console.log(`[wa-insights] win-back task created for quote ${q.quote_number}`);
  }
}

/** Stage 2 — score up to INSIGHTS_PER_TICK pending rows with one model call each. */
async function scorePendingInsights(supabase: DB, tz: string): Promise<number> {
  const { data: pending } = await supabase
    .from("wa_convo_insights")
    .select("id, contact_id, lead_id, attempts")
    .eq("status", "pending")
    .order("created_at")
    .limit(INSIGHTS_PER_TICK);
  if (!pending?.length) return 0;

  let scored = 0;
  for (const row of pending) {
    try {
      const ok = await scoreOne(supabase, row, tz);
      if (ok) scored++;
    } catch (e) {
      if (e instanceof OpenAIRateLimitError) {
        // The tier is saturated — stop draining; the row stays pending and
        // the next tick retries without burning an attempt.
        console.warn("[wa-insights] rate limited — pausing scoring this tick");
        break;
      }
      await bumpAttempts(supabase, row.id, row.attempts);
      console.error("[wa-insights] scoring failed:", e);
    }
  }
  return scored;
}

async function scoreOne(
  supabase: DB,
  row: { id: string; contact_id: string; lead_id: string | null; attempts: number },
  tz: string,
): Promise<boolean> {
  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("id, call_booked_at, last_direction, last_message_at, language")
    .eq("id", row.contact_id)
    .maybeSingle();
  if (!contact) {
    await supabase
      .from("wa_convo_insights")
      .update({ status: "failed" })
      .eq("id", row.id);
    return false;
  }

  // Deterministic facts first — the model never gets to decide the outcome.
  const [inCount, outCount, lead, quote] = await Promise.all([
    supabase
      .from("wa_messages")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", row.contact_id)
      .eq("direction", "in"),
    supabase
      .from("wa_messages")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", row.contact_id)
      .eq("direction", "out"),
    row.lead_id
      ? supabase
          .from("leads")
          .select("status")
          .eq("id", row.lead_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    row.lead_id
      ? supabase
          .from("quotes")
          .select("status")
          .eq("lead_id", row.lead_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const leadStatus = lead.data?.status ?? null;
  const quoteStatus = quote.data?.status ?? null;
  const ghosted =
    contact.last_direction === "out" &&
    !!contact.last_message_at &&
    Date.now() - new Date(contact.last_message_at).getTime() >
      CONVO_ENDS_AFTER_MS;

  // A booked call IS the agent's win — it outranks everything except the
  // deal actually closing.
  const outcome: WaInsightOutcome =
    leadStatus === "won"
      ? "won"
      : leadStatus === "lost"
        ? "lost"
        : contact.call_booked_at
          ? "call_booked"
          : quoteStatus === "declined"
            ? "declined"
            : quoteStatus === "sent" || quoteStatus === "viewed"
              ? "quoted_pending"
              : ghosted
                ? "ghosted"
                : "open";

  const thread = await fetchThread(supabase, row.contact_id, tz);
  if (!thread.length) {
    await supabase
      .from("wa_convo_insights")
      .update({ status: "failed" })
      .eq("id", row.id);
    return false;
  }
  const transcript = thread
    .map((m) =>
      m.role === "system"
        ? `[${m.content}]`
        : `${m.role === "user" ? "CUSTOMER" : "AGENT"}: ${m.content}`,
    )
    .join("\n")
    .slice(0, 12_000);

  const raw = await openaiChatJSON(
    [
      {
        role: "system",
        content:
          "You dissect finished WhatsApp sales conversations for an AI sales agent's improvement loop. Extract only what the transcript actually shows — no invention, no generic sales theory. Output ONLY JSON.",
      },
      {
        role: "user",
        content: `Conversation outcome (already decided, for context): ${outcome}

TRANSCRIPT (CUSTOMER / AGENT, with [time gap] markers):
${transcript}

Return JSON:
{
  "stage_reached": one short phrase for how far the deal got ("greeting only" | "discovery" | "pitched package" | "price discussed" | "call agreed" | "quote sent" | ...),
  "objections": [customer objections, verbatim-ish, max 5],
  "questions_asked": [questions the CUSTOMER asked, max 6],
  "buying_signals": [moments of real buying intent, max 5],
  "faq_gaps": [questions the agent could NOT answer or deferred to the team, max 4],
  "quality_flags": [agent reply-rule violations from EXACTLY this list, only if clearly present: "asterisks", "wall_of_text", "no_closing_question", "missed_buying_signal", "repeated_greeting"],
  "summary": one 25-word-max summary of what happened and why it ended how it did
}
Empty arrays are fine — accuracy beats volume.`,
      },
    ],
    { temperature: 0.2, timeoutMs: 20_000 },
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await bumpAttempts(supabase, row.id, row.attempts);
    return false;
  }

  const flags = strings(parsed.quality_flags, 5, 40).filter((f) =>
    [
      "asterisks",
      "wall_of_text",
      "no_closing_question",
      "missed_buying_signal",
      "repeated_greeting",
    ].includes(f),
  );

  const { error } = await supabase
    .from("wa_convo_insights")
    .update({
      status: "scored",
      outcome,
      stage_reached: str(parsed.stage_reached, 80),
      objections: strings(parsed.objections, 5, 140),
      questions_asked: strings(parsed.questions_asked, 6, 140),
      buying_signals: strings(parsed.buying_signals, 5, 140),
      faq_gaps: strings(parsed.faq_gaps, 4, 140),
      quality_flags: flags,
      language: contact.language,
      messages_in: inCount.count ?? 0,
      messages_out: outCount.count ?? 0,
      summary: str(parsed.summary, 240),
      attempts: row.attempts + 1,
    })
    .eq("id", row.id);
  if (error) {
    console.error("[wa-insights] save failed:", error.message);
    return false;
  }
  return true;
}

async function bumpAttempts(
  supabase: DB,
  id: string,
  attempts: number,
): Promise<void> {
  await supabase
    .from("wa_convo_insights")
    .update({
      attempts: attempts + 1,
      status: attempts + 1 >= MAX_SCORE_ATTEMPTS ? "failed" : "pending",
    })
    .eq("id", id);
}

/** Stage 3 — one mining call per day, only after the day's queue is drained. */
async function mineLessons(
  supabase: DB,
  ranFor: string | null,
  today: string,
): Promise<number> {
  if (ranFor === today) return 0;

  // Wait until scoring is done for the day; otherwise the miner reads half a day.
  const { count: pendingCount } = await supabase
    .from("wa_convo_insights")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (pendingCount) return 0;

  const since = new Date(
    Date.now() - MINER_LOOKBACK_DAYS * 86400_000,
  ).toISOString();
  const { data: insights } = await supabase
    .from("wa_convo_insights")
    .select(
      "outcome, stage_reached, objections, buying_signals, faq_gaps, quality_flags, summary",
    )
    .eq("status", "scored")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  if (!insights?.length) return 0;

  const { data: claimed } = await supabase
    .from("wa_agent_config")
    .update({ lessons_ran_for: today })
    .eq("id", 1)
    .or(`lessons_ran_for.is.null,lessons_ran_for.neq.${today}`)
    .select("id");
  if (!claimed?.length) return 0;

  // Aggregate in code — the model gets counts and a few stories, not 200 rows.
  const tally = (key: "objections" | "faq_gaps" | "quality_flags") => {
    const counts = new Map<string, number>();
    for (const i of insights)
      for (const v of i[key] ?? [])
        counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([v, n]) => `${v} (×${n})`);
  };
  const wins = insights.filter(
    (i) => i.outcome === "call_booked" || i.outcome === "won",
  );
  const losses = insights.filter(
    (i) => i.outcome === "ghosted" || i.outcome === "lost",
  );
  const stories = (list: typeof insights, n: number) =>
    list
      .slice(0, n)
      .map((i) => `- [${i.outcome} @ ${i.stage_reached ?? "?"}] ${i.summary ?? ""}`)
      .join("\n");

  // Never re-propose anything the team has already seen — including rejects.
  const { data: existing } = await supabase
    .from("wa_lessons")
    .select("title, body")
    .order("created_at", { ascending: false })
    .limit(100);

  const raw = await openaiChatJSON(
    [
      {
        role: "system",
        content:
          "You coach an AI WhatsApp sales agent from evidence of its own finished conversations. A BOOKED CALL is the agent's win condition (its job: give the info, get the call). Propose only lessons the evidence supports. Never touch prices or discount policy. Output ONLY JSON.",
      },
      {
        role: "user",
        content: `Last ${MINER_LOOKBACK_DAYS} days: ${insights.length} scored conversations — ${wins.length} wins (call booked or deal won), ${losses.length} ghosted/lost.

Top objections heard: ${tally("objections").join("; ") || "(none)"}
Questions the agent COULDN'T answer: ${tally("faq_gaps").join("; ") || "(none)"}
Reply-quality violations: ${tally("quality_flags").join("; ") || "(none)"}

WINS (what worked):
${stories(wins, 8) || "(none yet)"}

GHOSTED / LOST (what didn't):
${stories(losses, 8) || "(none yet)"}

Lessons already in the review queue or decided (NEVER re-propose these or near-duplicates):
${(existing ?? []).map((l) => `- ${l.title}`).join("\n") || "(none)"}

Propose up to ${MAX_LESSONS_PER_RUN} NEW lessons as JSON:
{ "lessons": [ { "kind": "objection_rebuttal" | "faq" | "phrasing" | "playbook", "title": "≤80 chars", "body": "the exact instruction the agent will follow, ≤300 chars. For kind=faq use the format 'Q: …\\nA: …' with an answer the TEAM must be able to confirm" } ] }
Fewer, sharper lessons beat filler. Return {"lessons": []} if the evidence is thin.`,
      },
    ],
    { temperature: 0.4, timeoutMs: 20_000 },
  );

  let proposals: { kind: string; title: string; body: string }[] = [];
  try {
    const parsed = JSON.parse(raw) as { lessons?: unknown };
    if (Array.isArray(parsed.lessons))
      proposals = parsed.lessons as { kind: string; title: string; body: string }[];
  } catch {
    return 0;
  }

  const seen = new Set(
    (existing ?? []).map((l) => l.title.trim().toLowerCase()),
  );
  const rows = proposals
    .filter(
      (p) =>
        p &&
        VALID_KINDS.includes(p.kind as WaLessonKind) &&
        typeof p.title === "string" &&
        p.title.trim() &&
        typeof p.body === "string" &&
        p.body.trim() &&
        !seen.has(p.title.trim().toLowerCase()),
    )
    .slice(0, MAX_LESSONS_PER_RUN)
    .map((p) => ({
      kind: p.kind as WaLessonKind,
      title: p.title.trim().slice(0, 80),
      body: p.body.trim().slice(0, 400),
      source: "nightly_miner" as const,
      evidence: {
        window_days: MINER_LOOKBACK_DAYS,
        conversations: insights.length,
        wins: wins.length,
        ghosted_or_lost: losses.length,
        top_objections: tally("objections"),
        top_faq_gaps: tally("faq_gaps"),
        top_quality_flags: tally("quality_flags"),
      } as unknown as Record<string, unknown>,
    }));
  if (!rows.length) return 0;

  const { error } = await supabase.from("wa_lessons").insert(rows);
  if (error) {
    console.error("[wa-insights] lesson insert failed:", error.message);
    return 0;
  }
  console.log(`[wa-insights] proposed ${rows.length} lessons for review`);
  return rows.length;
}

/**
 * The morning agent digest — one push a day, no AI calls.
 *
 * Yesterday's scoreboard (new contacts, who replied, calls booked = agent
 * wins, quotes out) plus what needs the team TODAY (flagged chats, lessons
 * awaiting review, calls coming up in the next 24h). Mirrors the cold
 * digest's window + claim-first pattern exactly: 08:30–11:00 local, one
 * winner per day via CAS on agent_digest_sent_for.
 */
export async function processAgentDigest(
  supabase: DB,
): Promise<{ sent: boolean }> {
  try {
    const { data: config } = await supabase
      .from("wa_agent_config")
      .select("enabled, timezone, agent_digest_sent_for")
      .eq("id", 1)
      .maybeSingle();
    if (!config?.enabled) return { sent: false };

    const tz = config.timezone || "Asia/Colombo";
    const minutes = localMinutesOfDay(tz);
    if (minutes < 8 * 60 + 30 || minutes >= 11 * 60) return { sent: false };

    const today = localDateInTimezone(tz);
    if (config.agent_digest_sent_for === today) return { sent: false };

    const { data: claimed } = await supabase
      .from("wa_agent_config")
      .update({ agent_digest_sent_for: today })
      .eq("id", 1)
      .or(`agent_digest_sent_for.is.null,agent_digest_sent_for.neq.${today}`)
      .select("id");
    if (!claimed?.length) return { sent: false };

    const now = Date.now();
    const since48h = new Date(now - 48 * 3600_000).toISOString();
    const yesterday = localDateInTimezone(tz, new Date(now - 24 * 3600_000));
    const onYesterday = (iso: string) => localDateInTimezone(tz, new Date(iso)) === yesterday;

    const [contactsRes, inboundRes, logsRes, attentionRes, lessonsRes, upcomingRes] =
      await Promise.all([
        supabase
          .from("wa_contacts")
          .select("created_at")
          .gte("created_at", since48h)
          .limit(500),
        supabase
          .from("wa_messages")
          .select("contact_id, created_at")
          .eq("direction", "in")
          .gte("created_at", since48h)
          .limit(3000),
        supabase
          .from("wa_agent_logs")
          .select("tool, created_at")
          .in("tool", ["book_call", "send_quote"])
          .eq("ok", true)
          .gte("created_at", since48h)
          .limit(200),
        supabase
          .from("wa_contacts")
          .select("id", { count: "exact", head: true })
          .eq("needs_attention", true),
        supabase
          .from("wa_lessons")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabase
          .from("wa_contacts")
          .select("id", { count: "exact", head: true })
          .gt("call_booked_at", new Date(now).toISOString())
          .lte("call_booked_at", new Date(now + 24 * 3600_000).toISOString()),
      ]);

    const newContacts = (contactsRes.data ?? []).filter((c) => onYesterday(c.created_at)).length;
    const repliers = new Set(
      (inboundRes.data ?? [])
        .filter((m) => onYesterday(m.created_at))
        .map((m) => m.contact_id),
    ).size;
    const yLogs = (logsRes.data ?? []).filter((l) => onYesterday(l.created_at));
    const callsBooked = yLogs.filter((l) => l.tool === "book_call").length;
    const quotesSent = yLogs.filter((l) => l.tool === "send_quote").length;

    const lines = [
      `Yesterday: ${newContacts} new contact${newContacts === 1 ? "" : "s"}, ${repliers} in conversation, ${callsBooked} call${callsBooked === 1 ? "" : "s"} booked 🎯, ${quotesSent} quote${quotesSent === 1 ? "" : "s"} sent.`,
    ];
    const needs: string[] = [];
    if (upcomingRes.count) needs.push(`${upcomingRes.count} call${upcomingRes.count === 1 ? "" : "s"} coming up in the next 24h`);
    if (attentionRes.count) needs.push(`${attentionRes.count} chat${attentionRes.count === 1 ? "" : "s"} waiting on a human`);
    if (lessonsRes.count) needs.push(`${lessonsRes.count} lesson${lessonsRes.count === 1 ? "" : "s"} awaiting review`);
    if (needs.length) lines.push(`Today: ${needs.join(" · ")}.`);

    await notifyEveryone(supabase, {
      title: "🤖 WhatsApp agent digest",
      body: lines.join("\n"),
      link: "/whatsapp",
    });
    return { sent: true };
  } catch (e) {
    console.error("[wa-insights] agent digest failed:", e);
    return { sent: false };
  }
}

/** Clamp helpers — the model's output never reaches the DB unvalidated. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim().slice(0, max);
}
function strings(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((x) => x.slice(0, maxLen));
}
