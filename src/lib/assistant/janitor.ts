import "server-only";

/**
 * Housekeeping for the assistant's own tables (0102).
 *
 * Three things accumulate forever if nobody sweeps them:
 *
 *   - TOMBSTONES. A deleted thread keeps its id so other devices learn it is
 *     gone. After a month every device has long since reconciled, and the row
 *     is just weight.
 *   - OLD BRIEFINGS. A briefing is worth reading the morning it arrives and
 *     worth scrolling back to for a while. It is not worth keeping forever —
 *     and unlike a real conversation, nobody wrote it.
 *   - SPENT EVENTS. Dismissed, done, or past their own expiry.
 *
 * Deliberately conservative: it never touches a `chat` thread. A conversation
 * the user had is theirs until they delete it, however old.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/** How long a tombstone is kept so other devices can learn about the delete. */
const TOMBSTONE_DAYS = 30;

/** How long generated briefings stay in the rail. */
const BRIEFING_DAYS = 30;

/** Runs at most this often — there is nothing urgent about tidying up. */
const SWEEP_INTERVAL_MS = 6 * 3_600_000;

let lastSweep = 0;

export async function processAssistantJanitor(
  supabase: DB,
): Promise<{ swept: boolean }> {
  // In-process gate. A cold start sweeps once more than strictly needed,
  // which is cheaper than a row of state to remember that it did not.
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return { swept: false };
  lastSweep = Date.now();

  try {
    const tombstoneCutoff = new Date(
      Date.now() - TOMBSTONE_DAYS * 86_400_000,
    ).toISOString();
    const briefingCutoff = new Date(
      Date.now() - BRIEFING_DAYS * 86_400_000,
    ).toISOString();
    const now = new Date().toISOString();

    await Promise.all([
      supabase
        .from("assistant_threads")
        .delete()
        .not("deleted_at", "is", null)
        .lt("deleted_at", tombstoneCutoff),
      // Generated threads only — a chat the person actually had is never
      // swept, however old it is.
      supabase
        .from("assistant_threads")
        .delete()
        .eq("kind", "briefing")
        .lt("updated_at", briefingCutoff),
      supabase
        .from("assistant_events")
        .delete()
        .in("status", ["dismissed", "done"])
        .lt("created_at", tombstoneCutoff),
      supabase
        .from("assistant_events")
        .delete()
        .not("expires_at", "is", null)
        .lt("expires_at", now),
    ]);

    return { swept: true };
  } catch {
    return { swept: false };
  }
}
