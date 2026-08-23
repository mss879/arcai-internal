import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { DELIVERY_STAGE_META, SERVICE_TYPE_LABELS } from "@/lib/constants";
import type { Database, ProjectLessonCategory } from "@/lib/database.types";
import { benchmarkByService, finishedProjects, projectOutcome } from "@/lib/project-history";

type DB = SupabaseClient<Database>;

/**
 * What a finished project taught us (AI-6).
 *
 * The WhatsApp agent has learned from lost deals since 0077; delivery has
 * learned from nothing. A project closes, the margin is whatever it is, and
 * the next quote for the same kind of work is written from the same instinct
 * as the last one.
 *
 * Approve-first, exactly like wa_lessons: the model proposes, a person keeps
 * or dismisses, and only KEPT lessons are ever quoted back into an estimate
 * (see project-estimate.ts). A model that mislearns once must not be able to
 * mis-price every job after it.
 */

const CATEGORIES: ProjectLessonCategory[] = [
  "pricing",
  "scope",
  "timeline",
  "delivery",
  "client",
];

const PROMPT = `You are running a post-mortem on a finished project for ARC AI, a digital agency in Sri Lanka.

Return STRICT JSON:
{
  "lessons": [
    {
      "title": string,       // 4-9 words, the lesson itself, e.g. "Quote content writing separately"
      "body": string,        // 2-3 sentences: what happened, and what to do differently
      "category": "pricing"|"scope"|"timeline"|"delivery"|"client"
    }
  ]
}

Rules:
- Between 1 and 4 lessons. Fewer good ones beat four padded ones.
- Every lesson must be traceable to a NUMBER in the input. "Design took 19 days against a 24-day whole-project median" is a lesson; "communication could be better" is not.
- A project that went well still teaches something — say what to repeat.
- Never invent figures. If the input lacks cost data, do not comment on margin.
- No markdown, no headings, no emoji. Output JSON only.`;

export type DraftedLesson = {
  title: string;
  body: string;
  category: ProjectLessonCategory;
};

/**
 * Run the post-mortem and file the lessons as `new`.
 *
 * Re-running refreshes rather than duplicates — the unique index is on
 * (project_id, title), so a second pass updates the lessons it repeats and
 * adds any it didn't find the first time. Lessons a person already decided on
 * keep their status.
 */
export async function runProjectPostMortem(
  supabase: DB,
  projectId: string,
): Promise<
  { ok: true; lessons: DraftedLesson[] } | { ok: false; error: string }
> {
  if (!isOpenAIConfigured())
    return { ok: false, error: "OPENAI_API_KEY is not configured." };

  const result = await projectOutcome(supabase, projectId);
  if (!result)
    return {
      ok: false,
      error:
        "Nothing to learn from yet — a post-mortem needs a project that reached completed or delivered.",
    };

  const { outcome, stageDays, loggedMinutes, balance } = result;

  // The project's own numbers mean little without the numbers it should be
  // compared against, so the peer benchmark goes in too.
  const peers = benchmarkByService(await finishedProjects(supabase, { limit: 60 })).find(
    (b) => b.serviceType === (outcome.serviceType ?? "other"),
  );

  const label = outcome.serviceType
    ? (SERVICE_TYPE_LABELS[
        outcome.serviceType as keyof typeof SERVICE_TYPE_LABELS
      ] ?? outcome.serviceType)
    : "unspecified service";

  const facts = [
    `PROJECT: ${outcome.name} (${label})`,
    `Quoted: ${outcome.currency} ${Math.round(outcome.quoted).toLocaleString()}`,
    `Received: ${outcome.currency} ${Math.round(outcome.received).toLocaleString()}`,
    balance > 0
      ? `STILL OWED: ${outcome.currency} ${Math.round(balance).toLocaleString()}`
      : "Fully paid.",
    `Costs recorded: ${outcome.currency} ${Math.round(outcome.expenses).toLocaleString()} (of which ${Math.round(outcome.extras).toLocaleString()} was billable extras raised after the start)`,
    `Commissions: ${outcome.currency} ${Math.round(outcome.commissions).toLocaleString()}`,
    outcome.marginPercent === null
      ? "Margin: not computable — no costs were recorded."
      : `Margin kept: ${outcome.marginPercent}% (${outcome.currency} ${Math.round(outcome.profit).toLocaleString()})`,
    outcome.days === null
      ? "Duration: unknown (missing a start date or a delivery)."
      : `Duration: ${outcome.days} days start to delivery.`,
    loggedMinutes > 0
      ? `Time logged: ${Math.round(loggedMinutes / 60)} hours.`
      : "Time logged: none — nobody recorded hours on this job.",
    stageDays.length
      ? `Days per stage:\n${stageDays
          .map(
            (s) =>
              `- ${DELIVERY_STAGE_META[s.stage as keyof typeof DELIVERY_STAGE_META]?.label ?? s.stage}: ${s.days} days`,
          )
          .join("\n")}`
      : "Stage history: none recorded.",
    peers
      ? `\nHOW THIS COMPARES to our other ${label} projects (${peers.count} of them):\n- median duration ${peers.medianDays ?? "unknown"} days\n- median quoted ${peers.currency} ${Math.round(peers.medianQuoted).toLocaleString()}\n- median extras ${peers.currency} ${Math.round(peers.medianExtras).toLocaleString()}\n- median margin ${peers.medianMarginPercent === null ? "unknown" : `${peers.medianMarginPercent}%`}`
      : "\nNo peer projects of this type to compare against yet.",
  ].join("\n");

  let drafted: DraftedLesson[];
  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: PROMPT },
        { role: "user", content: facts },
      ],
      { temperature: 0.4, timeoutMs: 60_000 },
    );
    const parsed = JSON.parse(raw) as { lessons?: unknown };
    drafted = normalize(parsed.lessons);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The post-mortem could not be run.",
    };
  }

  if (drafted.length === 0)
    return { ok: false, error: "The post-mortem produced nothing usable." };

  const evidence = {
    quoted: outcome.quoted,
    received: outcome.received,
    expenses: outcome.expenses,
    extras: outcome.extras,
    margin_percent: outcome.marginPercent,
    days: outcome.days,
    logged_hours: Math.round(loggedMinutes / 60),
    stage_days: stageDays,
    peer_median_days: peers?.medianDays ?? null,
    peer_median_margin: peers?.medianMarginPercent ?? null,
  };

  // Upsert on (project_id, title): re-running refreshes the body and evidence
  // without resetting a status somebody already decided.
  for (const lesson of drafted) {
    const { data: existing } = await supabase
      .from("project_lessons")
      .select("id")
      .eq("project_id", projectId)
      .eq("title", lesson.title)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("project_lessons")
        .update({ body: lesson.body, category: lesson.category, evidence })
        .eq("id", existing.id);
    } else {
      await supabase.from("project_lessons").insert({
        project_id: projectId,
        project_name: outcome.name,
        title: lesson.title,
        body: lesson.body,
        category: lesson.category,
        evidence,
      });
    }
  }

  return { ok: true, lessons: drafted };
}

function normalize(raw: unknown): DraftedLesson[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (l): l is { title: string; body: string; category?: unknown } =>
        !!l &&
        typeof (l as { title?: unknown }).title === "string" &&
        typeof (l as { body?: unknown }).body === "string",
    )
    .map((l) => ({
      title: l.title.trim().slice(0, 120),
      body: l.body.trim().slice(0, 800),
      category: CATEGORIES.includes(l.category as ProjectLessonCategory)
        ? (l.category as ProjectLessonCategory)
        : "delivery",
    }))
    .filter((l) => l.title && l.body)
    .slice(0, 4);
}
