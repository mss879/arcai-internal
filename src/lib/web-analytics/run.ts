import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { generateWebReport, analyseChatSessions } from "./report";
import { rollupTouchedDays } from "./rollup";
import { isWebsiteSourceConfigured } from "./source";
import { syncWebsiteAnalytics, type SyncResult } from "./sync";

type DB = SupabaseClient<Database>;

/**
 * The whole pipeline, in the order the steps depend on each other:
 *
 *   pull  → the raw mirror is now current
 *   roll  → the days that changed are recomputed
 *   read  → the AI labels new chat conversations
 *   write → the daily report is generated from the fresh rollups
 *
 * Every step after the pull is guarded, because they are all optional
 * improvements on data that is already safely stored. A rollup that
 * fails leaves stale numbers on the dashboard; a rollup that throws out
 * of this function would also lose the sync's watermark progress on the
 * next retry, and re-pull everything for nothing.
 */

export type PipelineResult = {
  ok: boolean;
  skipped?: string;
  sync: SyncResult | null;
  daysRolledUp: number;
  chatsAnalysed: number;
  reportId: string | null;
  errors: string[];
};

/** How often the automation tick is allowed to run the pipeline. */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Marker row that records when the whole pipeline last ran. */
const GATE = "pipeline";

/**
 * True if enough time has passed since the last pipeline run.
 *
 * The automation tick fires every minute. Without this the site's
 * Supabase would be scanned 1,440 times a day for data that changes at
 * the pace of human visits.
 */
export async function pipelineIsDue(supabase: DB): Promise<boolean> {
  const { data } = await supabase
    .from("web_sync_state")
    .select("last_run_at")
    .eq("stream", GATE)
    .maybeSingle();
  if (!data?.last_run_at) return true;
  return Date.now() - new Date(data.last_run_at).getTime() >= MIN_INTERVAL_MS;
}

async function stampGate(supabase: DB, error: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("web_sync_state").upsert(
    {
      stream: GATE,
      last_run_at: now,
      last_ok_at: error ? undefined : now,
      last_error: error,
      updated_at: now,
    },
    { onConflict: "stream" },
  );
}

export async function runWebAnalyticsPipeline(
  supabase: DB,
  opts: {
    /** Also write a report for this window. Skipped on routine ticks. */
    report?: "daily" | "weekly" | "monthly" | null;
    /** Label conversations with the AI. Costs money per row, so opt-in. */
    analyseChats?: boolean;
    createdBy?: string | null;
  } = {},
): Promise<PipelineResult> {
  const errors: string[] = [];

  if (!isWebsiteSourceConfigured()) {
    return {
      ok: false,
      skipped:
        "Website source not configured — add WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY to the environment.",
      sync: null,
      daysRolledUp: 0,
      chatsAnalysed: 0,
      reportId: null,
      errors,
    };
  }

  let sync: SyncResult | null = null;
  try {
    sync = await syncWebsiteAnalytics(supabase);
    for (const stream of sync.streams) {
      if (!stream.ok && stream.error) errors.push(`${stream.stream}: ${stream.error}`);
    }
  } catch (e) {
    errors.push(`sync: ${e instanceof Error ? e.message : String(e)}`);
  }

  let daysRolledUp = 0;
  try {
    // Today is always recomputed even when nothing new arrived, so the
    // dashboard's "today" row exists from the first run rather than
    // appearing only once the first visitor of the day shows up.
    const days = new Set(sync?.daysTouched ?? []);
    days.add(new Date().toISOString().slice(0, 10));
    daysRolledUp = await rollupTouchedDays(supabase, [...days]);
  } catch (e) {
    errors.push(`rollup: ${e instanceof Error ? e.message : String(e)}`);
  }

  let chatsAnalysed = 0;
  if (opts.analyseChats) {
    try {
      ({ analysed: chatsAnalysed } = await analyseChatSessions(supabase));
    } catch (e) {
      errors.push(`chat analysis: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let reportId: string | null = null;
  if (opts.report) {
    try {
      const report = await generateWebReport(supabase, opts.report, {
        createdBy: opts.createdBy ?? null,
      });
      reportId = report.id;
    } catch (e) {
      errors.push(`report: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await stampGate(supabase, errors.length ? errors.join(" · ").slice(0, 1000) : null);

  return {
    ok: errors.length === 0,
    sync,
    daysRolledUp,
    chatsAnalysed,
    reportId,
    errors,
  };
}

/**
 * The automation tick's entry point.
 *
 * Self-gating and silent: it returns without doing anything if the hour
 * has not elapsed or the source is unconfigured, so it can be called
 * unconditionally from the every-minute tick alongside everything else.
 */
export async function processWebAnalytics(supabase: DB): Promise<PipelineResult | null> {
  if (!isWebsiteSourceConfigured()) return null;
  if (!(await pipelineIsDue(supabase))) return null;

  // Data only. The daily report AND the chat labelling belong to the 06:15
  // scheduled function (web-analytics-sync.mts → ?report=daily&chats=1):
  // labelling is a paid model call per conversation, so running it on every
  // hourly pass was a recurring OpenAI bill — and the 06:00 hourly report
  // double-wrote the day the 06:15 pass was about to report on anyway.
  return runWebAnalyticsPipeline(supabase, {
    report: null,
    analyseChats: false,
  });
}
