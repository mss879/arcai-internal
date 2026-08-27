import "server-only";

/**
 * The morning briefing (0102) — Arcus opening the conversation.
 *
 * This is the feature the whole proactive phase exists for: you open the app
 * and a conversation is already waiting, telling you what needs you today.
 *
 * Three decisions shape the implementation.
 *
 * FIGURES ARE QUERIED, NEVER WRITTEN. Step 2 gathers every number from the
 * same helpers the pages use (`collectDigestStats`, the projects and invoice
 * tables, the events feed). The model in step 3 is given those numbers and
 * asked only to rank and narrate them. It cannot invent a total, because it
 * is never asked for one — the same division of labour the risk radar uses,
 * and the reason a briefing can be trusted at a glance.
 *
 * IT IS A THREAD, NOT AN EMAIL. The briefing is written into
 * `assistant_threads` as an ordinary conversation with one assistant message.
 * That means asking "why is that project at risk?" just works: the thread is
 * already in Studio's rail, already in context, already backed by all 60-odd
 * tools. A notification and a web push point at it; realtime (0101) makes it
 * appear on every open device without a reload.
 *
 * IT NEVER SILENTLY SKIPS. Synthesis runs as an OpenAI background job, which
 * can be slow or fail. If it errors, expires, or the API key is missing, the
 * fallback assembles a plain scoreboard from the same gathered numbers and
 * delivers that instead. A morning with no briefing would be worse than a
 * plain one.
 *
 * CAS-claimed per member per day on `assistant_config.briefing_sent_for`, so
 * however many ticks race, exactly one wins.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_MODELS, isOpenAIConfigured, isReasoningModel } from "@/lib/ai/openai";
import {
  pollBackgroundJob,
  startBackgroundJob,
} from "@/lib/assistant/openai-background";
import { briefingArtifact } from "@/lib/assistant-artifacts";
import type { Database } from "@/lib/database.types";
import { collectDigestStats } from "@/lib/intelligence";
import { sendPushToUser } from "@/lib/push";
import { localDateInTimezone } from "@/lib/wa-coaching";
import { localMinutesOfDay } from "@/lib/wa-cold-outreach";

type DB = SupabaseClient<Database>;

/** Members briefed per tick — each is one background job kickoff. */
const MAX_MEMBERS_PER_TICK = 3;

/** How long after the chosen time a briefing may still be delivered. */
const WINDOW_MINUTES = 120;

/** Give up on a background job after this and send the plain scoreboard. */
const JOB_DEADLINE_MS = 10 * 60_000;

const DEFAULT_TZ = "Asia/Colombo";

const SYSTEM = `You write one short morning briefing for the person who runs a small web/AI agency in Sri Lanka. Their assistant is called Arcus.

You are given REAL FIGURES already queried from their workspace. Your job is to decide what matters most today, and to say it in their language. You must NOT invent, estimate or adjust a single number — every figure in your output must appear verbatim in the input.

Write:
- headline: one sentence, the single most important thing about today. Concrete, not "good morning".
- spoken_script: the same briefing read aloud in 2-4 short sentences, no markdown, numbers spoken naturally ("a hundred and twenty thousand rupees").
- sections: 2-4 groups. Each has a short title, 1-4 lines of plain text (each line one fact), an optional href from the input, and an optional tone: positive | warning | danger | info | neutral.
- priorities: up to 3 things worth doing today. Each has a short label ("Chase the overdue invoices") and a prompt — the exact sentence the person would say to Arcus to start that job ("Show me every overdue invoice and draft the chasers").

Rules:
- Money is LKR, written like "Rs. 120,000".
- Lead with what needs a decision or is at risk; wins come last and briefly.
- If a section has nothing in it, leave the section out entirely.
- Never mention that you are an AI, and never describe your own output.

Reply with JSON only:
{"headline":"...","spoken_script":"...","sections":[{"title":"...","lines":["..."],"href":"...","tone":"..."}],"priorities":[{"label":"...","prompt":"..."}]}`;

type Section = {
  title: string;
  lines: string[];
  href?: string;
  tone?: "positive" | "warning" | "danger" | "info" | "neutral";
};

type BriefingBody = {
  headline: string;
  spoken_script?: string;
  sections: Section[];
  priorities?: { label: string; prompt: string }[];
};

/**
 * Deliver each member's morning briefing.
 *
 * Runs in three states across successive ticks: claim + gather + kick off the
 * job, poll it, then deliver. Never throws — it shares the tick.
 */
export async function processAssistantBriefing(
  supabase: DB,
): Promise<{ started: number; delivered: number }> {
  try {
    const { data: configs } = await supabase
      .from("assistant_config")
      .select(
        "user_id, timezone, briefing_enabled, briefing_time, briefing_sent_for, briefing_job_id, briefing_job_started_at",
      )
      .eq("briefing_enabled", true)
      .limit(50);
    if (!configs?.length) return { started: 0, delivered: 0 };

    let started = 0;
    let delivered = 0;

    for (const config of configs.slice(0, MAX_MEMBERS_PER_TICK)) {
      const tz = config.timezone || DEFAULT_TZ;
      const today = localDateInTimezone(tz);

      // A job already in flight for today: poll it, deliver or fall back.
      if (config.briefing_job_id && config.briefing_sent_for === today) {
        const done = await collectAndDeliver(supabase, config.user_id, tz, {
          jobId: config.briefing_job_id,
          startedAt: config.briefing_job_started_at,
        });
        if (done) delivered += 1;
        continue;
      }

      if (config.briefing_sent_for === today) continue;
      if (!inWindow(tz, config.briefing_time)) continue;

      // Claim the day BEFORE the work. Whoever wins this conditional update
      // owns the briefing; every other tick moves on.
      const { data: claimed } = await supabase
        .from("assistant_config")
        .update({ briefing_sent_for: today })
        .eq("user_id", config.user_id)
        .or(`briefing_sent_for.is.null,briefing_sent_for.neq.${today}`)
        .select("user_id");
      if (!claimed?.length) continue;

      const facts = await gatherFacts(supabase);
      const model = process.env.OPENAI_BRIEFING_MODEL?.trim() || AI_MODELS.chat;

      if (!isOpenAIConfigured()) {
        await deliver(supabase, config.user_id, tz, fallbackBriefing(facts));
        delivered += 1;
        continue;
      }

      const job = await startBackgroundJob({
        model,
        system: SYSTEM,
        user: JSON.stringify(facts),
        reasoning: isReasoningModel(model),
        effort: "medium",
      });

      if ("error" in job) {
        // No job, no waiting: the plain scoreboard goes out now.
        await deliver(supabase, config.user_id, tz, fallbackBriefing(facts));
        delivered += 1;
        continue;
      }

      await supabase
        .from("assistant_config")
        .update({
          briefing_job_id: job.jobId,
          briefing_job_started_at: new Date().toISOString(),
        })
        .eq("user_id", config.user_id);
      started += 1;
    }

    return { started, delivered };
  } catch {
    return { started: 0, delivered: 0 };
  }
}

/** Poll one in-flight job; deliver on success, fall back past the deadline. */
async function collectAndDeliver(
  supabase: DB,
  userId: string,
  tz: string,
  job: { jobId: string; startedAt: string | null },
): Promise<boolean> {
  const result = await pollBackgroundJob(job.jobId);
  const age = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;

  if (result.status === "pending") {
    // Waited long enough — a briefing at eleven is not a morning briefing.
    if (age < JOB_DEADLINE_MS) return false;
    const facts = await gatherFacts(supabase);
    await deliver(supabase, userId, tz, fallbackBriefing(facts));
    await clearJob(supabase, userId);
    return true;
  }

  if (result.status === "error") {
    const facts = await gatherFacts(supabase);
    await deliver(supabase, userId, tz, fallbackBriefing(facts));
    await clearJob(supabase, userId);
    return true;
  }

  const parsed = parseBriefing(result.text);
  const facts = parsed ? null : await gatherFacts(supabase);
  await deliver(
    supabase,
    userId,
    tz,
    parsed ?? fallbackBriefing(facts as Facts),
  );
  await clearJob(supabase, userId);
  return true;
}

async function clearJob(supabase: DB, userId: string): Promise<void> {
  await supabase
    .from("assistant_config")
    .update({ briefing_job_id: null, briefing_job_started_at: null })
    .eq("user_id", userId);
}

// ---- Facts ---------------------------------------------------------------

type Facts = {
  date: string;
  digest: Awaited<ReturnType<typeof collectDigestStats>> | null;
  overdue_invoices: { client: string; number: string; outstanding: number; days: number }[];
  risky_projects: { name: string; note: string | null; href: string }[];
  blocked_projects: { name: string; reason: string | null; days: number }[];
  meetings_today: { title: string; at: string }[];
  todos_due: { title: string; due: string | null }[];
  events: { title: string; body: string | null; href: string | null; importance: number }[];
  pending_memories: number;
};

/** Everything the briefing may talk about, queried — never guessed. */
async function gatherFacts(supabase: DB): Promise<Facts> {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const dayEnd = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  const [digest, invoices, risky, blocked, meetings, todos, events, memories] =
    await Promise.all([
      collectDigestStats(supabase).catch(() => null),
      supabase
        .from("invoices")
        .select("invoice_number, bill_to_name, invoice_date, grand_total, amount_paid")
        .order("invoice_date", { ascending: true })
        .limit(100),
      supabase
        .from("projects")
        .select("id, name, risk_rank, risk_note")
        .is("deleted_at", null)
        .eq("status", "active")
        .not("risk_rank", "is", null)
        .order("risk_rank", { ascending: true })
        .limit(3),
      supabase
        .from("projects")
        .select("name, blocked_reason, blocked_since")
        .is("deleted_at", null)
        .not("blocked_since", "is", null)
        .limit(10),
      supabase
        .from("meetings")
        .select("title, meeting_at")
        .gte("meeting_at", now.toISOString())
        .lt("meeting_at", dayEnd)
        .order("meeting_at", { ascending: true })
        .limit(10),
      supabase
        .from("todos")
        .select("title, due_date")
        .neq("status", "done")
        .not("due_date", "is", null)
        .lte("due_date", dayEnd)
        .order("due_date", { ascending: true })
        .limit(10),
      supabase
        .from("assistant_events")
        .select("title, body, href, importance, surfaced_via")
        .eq("status", "new")
        .neq("source", "pulse-marker")
        .order("importance", { ascending: false })
        .limit(15),
      supabase
        .from("assistant_memories")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
    ]);

  const overdue = (invoices.data ?? [])
    .map((inv) => {
      const outstanding = Number(inv.grand_total ?? 0) - Number(inv.amount_paid ?? 0);
      const days = Math.floor(
        (Date.now() - new Date(inv.invoice_date).getTime()) / 86_400_000,
      );
      return {
        client: inv.bill_to_name,
        number: inv.invoice_number,
        outstanding,
        days,
      };
    })
    .filter((inv) => inv.outstanding > 0 && inv.days >= 7)
    .slice(0, 8);

  return {
    date: todayIso,
    digest: digest ?? null,
    overdue_invoices: overdue,
    risky_projects: (risky.data ?? []).map((p) => ({
      name: p.name,
      note: p.risk_note,
      href: `/projects/${p.id}`,
    })),
    blocked_projects: (blocked.data ?? []).map((p) => ({
      name: p.name,
      reason: p.blocked_reason,
      days: Math.floor(
        (Date.now() - new Date(p.blocked_since as string).getTime()) / 86_400_000,
      ),
    })),
    meetings_today: (meetings.data ?? []).map((m) => ({
      title: m.title,
      at: new Intl.DateTimeFormat("en-GB", {
        timeZone: DEFAULT_TZ,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(m.meeting_at)),
    })),
    todos_due: (todos.data ?? []).map((t) => ({ title: t.title, due: t.due_date })),
    events: (events.data ?? []).map((e) => ({
      title: e.title,
      body: e.body,
      href: e.href,
      importance: e.importance,
    })),
    pending_memories: memories.count ?? 0,
  };
}

// ---- Rendering -----------------------------------------------------------

function parseBriefing(raw: string): BriefingBody | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const headline = String(obj.headline ?? "").trim();
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    if (!headline || !sections.length) return null;
    return {
      headline,
      spoken_script: String(obj.spoken_script ?? "").trim() || undefined,
      sections: sections
        .map((raw): Section | null => {
          const s = raw as Record<string, unknown>;
          const lines = Array.isArray(s.lines)
            ? s.lines.map((l) => String(l).trim()).filter(Boolean)
            : [];
          const title = String(s.title ?? "").trim();
          if (!title || !lines.length) return null;
          const href = String(s.href ?? "").trim();
          const tone = normaliseTone(s.tone);
          return {
            title,
            lines: lines.slice(0, 6),
            ...(href ? { href } : {}),
            ...(tone ? { tone } : {}),
          };
        })
        .filter((s): s is Section => s !== null)
        .slice(0, 5),
      priorities: Array.isArray(obj.priorities)
        ? obj.priorities
            .map((raw) => {
              const p = raw as Record<string, unknown>;
              const label = String(p.label ?? "").trim();
              const prompt = String(p.prompt ?? "").trim();
              return label && prompt ? { label, prompt } : null;
            })
            .filter((p): p is { label: string; prompt: string } => p !== null)
            .slice(0, 3)
        : undefined,
    };
  } catch {
    return null;
  }
}

function normaliseTone(value: unknown): Section["tone"] {
  const tone = String(value ?? "").trim();
  return tone === "positive" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "info" ||
    tone === "neutral"
    ? tone
    : undefined;
}

/**
 * The no-AI briefing.
 *
 * Same figures, no narration — the agent-digest scoreboard shape. This is
 * what goes out when the model is unavailable, slow or wrong, and it is the
 * reason the morning is never silent.
 */
function fallbackBriefing(facts: Facts): BriefingBody {
  const sections: Section[] = [];
  const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

  if (facts.overdue_invoices.length) {
    const total = facts.overdue_invoices.reduce((s, i) => s + i.outstanding, 0);
    sections.push({
      title: "Money owed",
      tone: "warning",
      href: "/invoices?tab=past",
      lines: [
        `${facts.overdue_invoices.length} invoices outstanding, ${money(total)} in total.`,
        ...facts.overdue_invoices
          .slice(0, 3)
          .map((i) => `${i.client} — ${money(i.outstanding)}, ${i.days} days old.`),
      ],
    });
  }

  if (facts.blocked_projects.length || facts.risky_projects.length) {
    sections.push({
      title: "Projects",
      tone: facts.blocked_projects.length ? "danger" : "info",
      href: "/projects",
      lines: [
        ...facts.blocked_projects
          .slice(0, 3)
          .map((p) => `${p.name} blocked ${p.days} days${p.reason ? ` — ${p.reason}` : ""}.`),
        ...facts.risky_projects
          .slice(0, 2)
          .map((p) => `${p.name}${p.note ? ` — ${p.note}` : " is flagged as at risk."}`),
      ],
    });
  }

  if (facts.meetings_today.length || facts.todos_due.length) {
    sections.push({
      title: "Today",
      tone: "info",
      href: "/meetings",
      lines: [
        ...facts.meetings_today.map((m) => `${m.at} — ${m.title}`),
        ...facts.todos_due.slice(0, 4).map((t) => `Due: ${t.title}`),
      ],
    });
  }

  if (facts.digest) {
    sections.push({
      title: "This week",
      tone: "neutral",
      href: "/intelligence",
      lines: [
        `${facts.digest.new_leads} new leads, ${facts.digest.going_cold} going cold.`,
        `${money(facts.digest.open_deal_value)} of open deals.`,
        `${money(facts.digest.revenue_month)} in this month.`,
      ],
    });
  }

  if (!sections.length) {
    sections.push({
      title: "All quiet",
      tone: "positive",
      lines: ["Nothing overdue, nothing blocked, nothing due today."],
    });
  }

  const headline = facts.overdue_invoices.length
    ? `${facts.overdue_invoices.length} invoices are still unpaid this morning.`
    : facts.blocked_projects.length
      ? `${facts.blocked_projects[0].name} has been blocked for ${facts.blocked_projects[0].days} days.`
      : facts.meetings_today.length
        ? `${facts.meetings_today.length} meetings today — first at ${facts.meetings_today[0].at}.`
        : "Nothing urgent this morning.";

  const priorities: { label: string; prompt: string }[] = [];
  if (facts.overdue_invoices.length) {
    priorities.push({
      label: "Chase the overdue invoices",
      prompt: "Show me every overdue invoice and who owes what.",
    });
  }
  if (facts.blocked_projects.length) {
    priorities.push({
      label: "Look at what's blocked",
      prompt: "Which projects are blocked and what are they waiting on?",
    });
  }
  if (facts.pending_memories > 0) {
    priorities.push({
      label: `Review ${facts.pending_memories} things I learned`,
      prompt: "What have you learned about how I work that's waiting for approval?",
    });
  }

  return { headline, sections, priorities: priorities.slice(0, 3) };
}

/** Write the briefing as a real conversation, then point at it. */
async function deliver(
  supabase: DB,
  userId: string,
  tz: string,
  body: BriefingBody,
): Promise<void> {
  const today = localDateInTimezone(tz);
  const threadId = `briefing-${today}-${userId.slice(0, 8)}`;
  const now = Date.now();

  const artifact = briefingArtifact({
    title: "Morning briefing",
    subtitle: today,
    area: "dashboard",
    headline: body.headline,
    spokenScript: body.spoken_script,
    sections: body.sections,
    priorities: body.priorities,
  });

  const { error: threadError } = await supabase.from("assistant_threads").upsert(
    {
      id: threadId,
      user_id: userId,
      title: "Morning briefing",
      kind: "briefing" as const,
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: "id" },
  );
  if (threadError) return;

  await supabase.from("assistant_messages").upsert(
    {
      id: `${threadId}-msg`,
      thread_id: threadId,
      user_id: userId,
      role: "assistant" as const,
      // The spoken script is the transcript line, so voice mode reads the
      // briefing rather than describing the artifact beside it.
      content: body.spoken_script || body.headline,
      at: now,
      payload: { artifacts: [artifact] },
    },
    { onConflict: "id" },
  );

  const link = `/dashboard?arc=thread:${threadId}`;
  await supabase.from("notifications").insert({
    user_id: userId,
    type: "assistant" as const,
    title: "Your morning briefing",
    body: body.headline,
    link,
  });
  await sendPushToUser({
    userId,
    title: "Your morning briefing",
    body: body.headline,
    link,
  });

  // Anything the briefing covered should not also buzz as a nudge later.
  await supabase
    .from("assistant_events")
    .update({ status: "surfaced", surfaced_via: ["briefing"] })
    .eq("status", "new")
    .neq("source", "pulse-marker")
    .lte("importance", 2);
}

/** True when now is within the briefing window for this member's timezone. */
function inWindow(tz: string, time: string): boolean {
  const match = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  const target = match
    ? Number(match[1]) * 60 + Number(match[2])
    : 8 * 60 + 30;
  const now = localMinutesOfDay(tz);
  return now >= target && now < target + WINDOW_MINUTES;
}
