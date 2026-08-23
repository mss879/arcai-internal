import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChat } from "@/lib/ai/openai";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import {
  benchmarkByService,
  finishedProjects,
  type ServiceBenchmark,
} from "@/lib/project-history";

type DB = SupabaseClient<Database>;

/**
 * Pricing grounded in your own actuals (AI-2).
 *
 * "Business websites like this one took 24 days and cost LKR 41,000 in extras;
 * you quoted 150,000 and kept 62%." Every one of those numbers is already in
 * the database and nobody has ever subtracted them.
 *
 * The numbers come from project-history.ts, not from a model. The model is
 * only asked to turn them into a sentence and name what it would change —
 * which means an estimate can be wrong about advice but never about arithmetic.
 */

export type ProjectEstimate = {
  serviceType: string;
  serviceLabel: string;
  /** How many finished projects the figures rest on. Below 3, treat as thin. */
  sampleSize: number;
  medianDays: number | null;
  medianQuoted: number;
  medianExtras: number;
  medianMarginPercent: number | null;
  currency: string;
  /** Plain-English read of the numbers, or null when AI isn't configured. */
  advice: string | null;
  /** Kept lessons from past post-mortems that bear on this service type. */
  lessons: { title: string; body: string }[];
};

export async function estimateForService(
  supabase: DB,
  serviceType: string,
): Promise<{ ok: true; estimate: ProjectEstimate } | { ok: false; error: string }> {
  const history = await finishedProjects(supabase, { limit: 60 });
  const benchmark = benchmarkByService(history).find(
    (b) => b.serviceType === serviceType,
  );

  if (!benchmark) {
    return {
      ok: false,
      error:
        "Not enough history yet — at least two finished projects of this type are needed before the numbers mean anything.",
    };
  }

  // AI-6's output feeds AI-1 and AI-2: only lessons a person KEPT are quoted
  // back, so a bad post-mortem can never become pricing advice.
  const { data: lessons } = await supabase
    .from("project_lessons")
    .select("title, body, category")
    .eq("status", "kept")
    .in("category", ["pricing", "scope", "timeline"])
    .order("created_at", { ascending: false })
    .limit(6);

  const label =
    SERVICE_TYPE_LABELS[serviceType as keyof typeof SERVICE_TYPE_LABELS] ??
    serviceType;

  const estimate: ProjectEstimate = {
    serviceType,
    serviceLabel: label,
    sampleSize: benchmark.count,
    medianDays: benchmark.medianDays,
    medianQuoted: benchmark.medianQuoted,
    medianExtras: benchmark.medianExtras,
    medianMarginPercent: benchmark.medianMarginPercent,
    currency: benchmark.currency,
    advice: null,
    lessons: (lessons ?? []).map((l) => ({ title: l.title, body: l.body })),
  };

  if (!isOpenAIConfigured()) return { ok: true, estimate };

  try {
    const reply = await openaiChat(
      [
        {
          role: "system",
          content:
            "You advise a small Sri Lankan digital agency on pricing, using ONLY the figures given. Plain text, 3-4 sentences, no markdown, no headings. Quote the actual numbers. If the sample is under 3 projects, say plainly that it is too thin to price from. Never invent a figure that isn't in the input, and never recommend a specific price — say what the history supports and what to watch.",
        },
        { role: "user", content: describe(benchmark, label, estimate.lessons) },
      ],
      undefined,
      { temperature: 0.4, timeoutMs: 30_000 },
    );
    estimate.advice = (reply.content ?? "").trim() || null;
  } catch {
    // The numbers are the point; the sentence is a bonus. A failed model call
    // must not deny the team the benchmark it already earned.
  }

  return { ok: true, estimate };
}

function describe(
  b: ServiceBenchmark,
  label: string,
  lessons: { title: string; body: string }[],
): string {
  return [
    `Service type: ${label}`,
    `Finished projects in the sample: ${b.count}`,
    `Median delivery time: ${b.medianDays ?? "unknown"} days`,
    `Median quoted: ${b.currency} ${Math.round(b.medianQuoted).toLocaleString()}`,
    `Median billable extras raised after start: ${b.currency} ${Math.round(b.medianExtras).toLocaleString()}`,
    `Median margin kept: ${b.medianMarginPercent === null ? "unknown (no costs recorded)" : `${b.medianMarginPercent}%`}`,
    lessons.length
      ? `\nLessons the team kept from past post-mortems:\n${lessons
          .map((l) => `- ${l.title}: ${l.body}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Every service type with enough history to estimate from. */
export async function allEstimates(supabase: DB): Promise<ServiceBenchmark[]> {
  return benchmarkByService(await finishedProjects(supabase, { limit: 80 }));
}
