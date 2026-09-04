import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendDigestEmails } from "@/lib/digests";
import { generateWeeklyDigest, scanChurn, scoreLeads } from "@/lib/intelligence";
import { localMinutesOfDay } from "@/lib/assistant/quiet-hours";
import { notifyUsers } from "@/lib/notify";

type DB = SupabaseClient<Database>;

/**
 * The Intelligence page's three jobs, on the tick.
 *
 * Lead scoring, the churn scan and the weekly digest all existed and all had
 * to be triggered by hand — the digest by a cron endpoint nobody had
 * scheduled, the other two by opening the page and pressing a button. So a
 * lead sat unscored until someone looked, and "this client has gone quiet"
 * was noticed by the same person who would have noticed anyway.
 *
 * Each is gated by its own stamp in `app_settings`, claimed BEFORE the work
 * runs. A tick that dies half way therefore skips its turn rather than
 * retrying forever, which is the right trade for jobs that cost AI calls and
 * whose whole point is to run roughly on a schedule.
 */

const TIME_ZONE = "Asia/Colombo";

/** Roughly hourly — a shade under, so the slot doesn't creep later each day. */
const SCORE_INTERVAL_MS = 55 * 60 * 1000;
const SCORE_KEY = "lead_scoring";
/** Daily, from 06:00 Colombo. */
const CHURN_KEY = "churn_scan";
const DIGEST_KEY = "weekly_digest";

export type IntelligenceJobsResult = {
  scored: number;
  churnAlerts: number;
  digest: boolean;
  /** How many people got the digest by email as well as in-app. */
  digestEmails: number;
};

/** Today in Colombo, as YYYY-MM-DD — the unit a daily stamp compares. */
function colomboDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 0 = Sunday, 1 = Monday, … in Colombo. */
function colomboWeekday(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

async function readStamp(db: DB, key: string): Promise<Record<string, unknown>> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value as Record<string, unknown>) ?? {};
}

async function writeStamp(
  db: DB,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await db.from("app_settings").upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}

/**
 * Claim a once-a-day slot, if the local hour has arrived.
 *
 * Returns true exactly once per Colombo day, and only at or after `fromHour`.
 * The stamp is written before the caller does the work, so a crash costs one
 * day's run rather than looping.
 */
async function claimDaily(
  db: DB,
  key: string,
  fromHour: number,
  now: Date,
): Promise<boolean> {
  if (localMinutesOfDay(TIME_ZONE, now) < fromHour * 60) return false;
  const today = colomboDay(now);
  const stamp = await readStamp(db, key);
  if (stamp.ran_for === today) return false;
  await writeStamp(db, key, { ran_for: today, at: now.toISOString() });
  return true;
}

export async function processIntelligenceJobs(
  db: DB,
  now = new Date(),
): Promise<IntelligenceJobsResult> {
  const result: IntelligenceJobsResult = {
    scored: 0,
    churnAlerts: 0,
    digest: false,
    digestEmails: 0,
  };

  // --- Lead scoring, hourly, unscored only ------------------------------
  try {
    const stamp = await readStamp(db, SCORE_KEY);
    const last = Date.parse(String(stamp.at ?? ""));
    if (!Number.isFinite(last) || now.getTime() - last >= SCORE_INTERVAL_MS) {
      await writeStamp(db, SCORE_KEY, { at: now.toISOString() });
      // Unscored only: rescoring everything hourly would be an AI bill, and
      // the score is a triage hint, not a live metric.
      result.scored = await scoreLeads(db);
    }
  } catch (e) {
    console.error("[intelligence] lead scoring failed:", e);
  }

  // --- Churn scan, once a day from 06:00 --------------------------------
  try {
    if (await claimDaily(db, CHURN_KEY, 6, now)) {
      result.churnAlerts = await scanChurn(db);
    }
  } catch (e) {
    console.error("[intelligence] churn scan failed:", e);
  }

  // --- Weekly digest, Monday from 08:00 ---------------------------------
  try {
    if (colomboWeekday(now) === 1 && (await claimDaily(db, DIGEST_KEY, 8, now))) {
      const { content } = await generateWeeklyDigest(db);
      const firstLine =
        content.split("\n").find((l) => l.trim()) ?? "Your weekly digest is ready.";
      await notifyUsers(db, {
        userIds: "all",
        title: "📊 Your weekly business digest is ready",
        body: firstLine,
        link: "/intelligence",
      });
      // 0115 — and by email, for whoever asked for it. The content is passed
      // in rather than regenerated, so the digest costs one AI call either
      // way.
      result.digestEmails = await sendDigestEmails(db, "weekly", {
        subject: "Your weekly business digest",
        body: content,
        link: "/intelligence",
      });
      result.digest = true;
    }
  } catch (e) {
    console.error("[intelligence] weekly digest failed:", e);
  }

  return result;
}
