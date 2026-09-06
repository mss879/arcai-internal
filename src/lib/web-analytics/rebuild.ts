import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { daysInWindow } from "./job-core";
import { resetLedgerCursor } from "./ledger";
import { FULL_STEP_MS, runWebAnalyticsStep, type StepResult } from "./run";
import { isWebsiteSourceConfigured } from "./source";
import { purgeLegacyMirror, resetSyncCursors } from "./sync";

type DB = SupabaseClient<Database>;

/**
 * Re-mirror and recompute from scratch.
 *
 * The pipeline is incremental in both halves, and both halves have the
 * same blind spot. The sync only reads rows newer than its watermark, so a
 * row mirrored by a mapper that was later corrected is never revisited.
 * The rollup only recomputes days the sync touched — plus days with no
 * `web_daily` row at all — so a day already rolled up by an aggregation that
 * was later corrected keeps its wrong numbers forever.
 *
 * The practical effect is the thing this exists to fix: every correction to
 * the analytics logic lands in the code, ships, runs, and changes nothing
 * you can see, because the data it was written to fix is on the wrong side
 * of two watermarks. Somebody then reasonably concludes the fix did not
 * work.
 *
 * So this does what the incremental path deliberately will not:
 *
 *   1. winds every stream watermark back to zero,
 *   2. re-pulls the source, rewriting each mirrored row through today's
 *      mapping (channel classification, the legacy cutover, session length),
 *   3. rebuilds the lead ledger from the first conversion event, keeping
 *      every verdict a person set by hand,
 *   4. recomputes every single day in the window, whether or not anything
 *      changed, clearing each day's per-page rows as it goes.
 *
 * It is a JOB, not a call: it re-reads the whole source and rescans ninety
 * days, which no single serverless invocation survives. This opens the job
 * (superseding any ordinary sync in progress), does the first bounded step,
 * and returns; the page keeps stepping while it is open, and the automation
 * tick finishes whatever is left. It is idempotent and safe to run twice.
 */

export type RebuildResult = StepResult & { skipped?: string };

/** Wide enough to cover any window the dashboard offers, bounded so one job finishes. */
const MAX_DAYS = 180;

export async function rebuildWebAnalytics(
  supabase: DB,
  opts: { days?: number; budgetMs?: number } = {},
): Promise<RebuildResult> {
  if (!isWebsiteSourceConfigured()) {
    return {
      status: "unconfigured",
      done: true,
      skipped:
        "Website source not configured — add WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY to the environment.",
      summary: {
        running: false,
        stepping: false,
        phase: null,
        started_at: null,
        steps: 0,
        rows: 0,
        leads: 0,
        days_done: 0,
        days_left: 0,
        chats: 0,
        rebuild: false,
        errors: [],
        next_due_at: null,
        last: null,
      },
    };
  }

  const days = daysInWindow(opts.days ?? 90, new Date(), MAX_DAYS);

  return runWebAnalyticsStep(supabase, {
    budgetMs: opts.budgetMs ?? FULL_STEP_MS,
    rebuild: {
      days,
      // Under the lease, so a step already in flight cannot write a cursor
      // over the top of the reset. Cursors first, then the purge: if the run
      // dies between the two, the next step finds null watermarks and
      // finishes the re-mirror by itself; the other order would leave a
      // permanent hole in the archive.
      before: async () => {
        await resetSyncCursors(supabase);
        await purgeLegacyMirror(supabase);
        // The ledger re-reads every conversion event; manual verdicts survive
        // because the merge never overwrites them.
        await resetLedgerCursor(supabase);
      },
    },
  });
}
