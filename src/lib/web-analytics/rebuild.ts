import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { rollupDay, rollupJourneys } from "./rollup";
import { SITE, isWebsiteSourceConfigured } from "./source";
import {
  REPLAYABLE_STREAMS,
  purgeLegacyMirror,
  resetSyncCursors,
  syncWebsiteAnalytics,
  type StreamName,
} from "./sync";

type DB = SupabaseClient<Database>;

/**
 * Re-mirror and recompute from scratch.
 *
 * The hourly pipeline is incremental in both halves, and both halves have
 * the same blind spot. The sync only reads rows newer than its watermark,
 * so a row mirrored by a mapper that was later corrected is never revisited.
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
 *   3. throws away the derived tables for the window, and
 *   4. recomputes every single day in it, whether or not anything changed.
 *
 * It is idempotent and safe to run twice. It is not cheap — it re-reads the
 * source and rescans the window — so it is a button someone presses, never
 * something on the tick.
 */

export type RebuildResult = {
  ok: boolean;
  skipped?: string;
  rowsPulled: number;
  daysRebuilt: number;
  /** Streams still holding a backlog: MAX_PAGES bounds one pull. */
  incomplete: boolean;
  errors: string[];
};

/** Wide enough to cover any window the dashboard offers, bounded so one run finishes. */
const MAX_DAYS = 180;

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Every UTC day in the window, newest first — the order that matters most. */
function daysInWindow(days: number): string[] {
  const capped = Math.min(MAX_DAYS, Math.max(1, Math.round(days)));
  const out: string[] = [];
  const today = new Date();
  for (let i = 0; i < capped; i++) {
    out.push(dayKey(new Date(today.getTime() - i * 86_400_000)));
  }
  return out;
}

/**
 * Clear the derived tables for the window before recomputing them.
 *
 * `rollupDay` upserts, which rewrites a day's row — but only for the keys it
 * still produces. A `web_page_daily` row for a path that no longer has views
 * on that day (because its duplicate legacy events were just pruned) would
 * survive the upsert untouched and keep being summed into the page table.
 * Deleting first is the only way the recomputation is actually a
 * recomputation rather than a merge with whatever was there before.
 */
async function clearDerived(supabase: DB, from: string, to: string): Promise<void> {
  await supabase
    .from("web_page_daily")
    .delete()
    .eq("site", SITE)
    .gte("day", from)
    .lte("day", to);
  await supabase
    .from("web_daily")
    .delete()
    .eq("site", SITE)
    .gte("day", from)
    .lte("day", to);
  await supabase.from("web_journeys").delete().eq("site", SITE);
}

export async function rebuildWebAnalytics(
  supabase: DB,
  opts: { days?: number; streams?: StreamName[] } = {},
): Promise<RebuildResult> {
  const errors: string[] = [];

  if (!isWebsiteSourceConfigured()) {
    return {
      ok: false,
      skipped:
        "Website source not configured — add WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY to the environment.",
      rowsPulled: 0,
      daysRebuilt: 0,
      incomplete: false,
      errors,
    };
  }

  const window = daysInWindow(opts.days ?? 90);
  const from = window[window.length - 1];
  const to = window[0];

  // ---- 1. replay the mirror ------------------------------------------------
  let rowsPulled = 0;
  let incomplete = false;
  try {
    // Cursors first, then the purge. If the run dies between the two, the
    // next scheduled tick finds a null watermark and finishes the re-mirror
    // by itself; the other order would leave a permanent hole in the archive.
    await resetSyncCursors(supabase, opts.streams ?? REPLAYABLE_STREAMS);
    if ((opts.streams ?? REPLAYABLE_STREAMS).includes("page_visits")) {
      await purgeLegacyMirror(supabase);
    }
    // One pull is bounded by MAX_PAGES per stream. A backlog larger than
    // that drains over the next few hourly ticks; the caller is told so it
    // can say that rather than implying everything is done.
    const sync = await syncWebsiteAnalytics(supabase);
    rowsPulled = sync.totalRows;
    for (const stream of sync.streams) {
      if (!stream.ok && stream.error) errors.push(`${stream.stream}: ${stream.error}`);
      // 20 pages x 1000 rows is the per-run ceiling in the sync.
      if (stream.rows >= 20_000) incomplete = true;
    }
  } catch (e) {
    errors.push(`replay: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 2. recompute every day in the window --------------------------------
  let daysRebuilt = 0;
  try {
    await clearDerived(supabase, from, to);
  } catch (e) {
    errors.push(`clear: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const day of window) {
    try {
      await rollupDay(supabase, day);
      daysRebuilt++;
    } catch (e) {
      errors.push(`rollup ${day}: ${e instanceof Error ? e.message : String(e)}`);
      // One bad day must not cost the other 89.
    }
  }

  try {
    const journeyStart = dayKey(new Date(Date.now() - 29 * 86_400_000));
    await rollupJourneys(supabase, journeyStart, to);
  } catch (e) {
    errors.push(`journeys: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: errors.length === 0,
    rowsPulled,
    daysRebuilt,
    incomplete,
    errors,
  };
}
