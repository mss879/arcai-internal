import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";
import { createAiUsageInvoice } from "@/lib/invoices";

import { colomboDay, colomboHour, colomboPeriod, periodEnd, previousPeriod } from "./time-core";

type DB = SupabaseClient<Database>;

/**
 * The `aiBilling` tick pass (0126): once a day from 06:00 Colombo, raise
 * last month's invoice for every billable project that does not have one.
 * Daily rather than only on the 1st, so a missed morning or a failed create
 * (an LKR project with no rate, say) is retried the next day. The stamp is
 * claimed before the work; the `ai_invoices` unique key makes a re-run — or
 * a manual "Raise invoice" landing at the same moment — harmless.
 */

const STAMP_KEY = "ai_billing";
const FROM_HOUR = 6;
const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 3;

export type AiBillingResult = { skipped: boolean; period: string | null; raised: number; zero: number; failed: number };

export async function processAiBilling(db: DB, now = new Date()): Promise<AiBillingResult> {
  const result: AiBillingResult = { skipped: true, period: null, raised: 0, zero: 0, failed: 0 };
  try {
    if (colomboHour(now) < FROM_HOUR) return result;
    const today = colomboDay(now);
    const { data: stamp } = await db.from("app_settings").select("value").eq("key", STAMP_KEY).maybeSingle();
    if ((stamp?.value as { ran_for?: string } | null)?.ran_for === today) return result;
    await db
      .from("app_settings")
      .upsert({ key: STAMP_KEY, value: { ran_for: today, at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" });
    result.skipped = false;

    const period = previousPeriod(colomboPeriod(now));
    result.period = period;

    const { data: projects } = await db
      .from("ai_projects")
      .select("id, billing_from")
      .eq("billing_enabled", true)
      .lte("billing_from", periodEnd(period))
      .limit(200);
    if (!projects?.length) return result;

    const { data: links } = await db
      .from("ai_invoices")
      .select("project_id, status, attempts")
      .eq("period", period)
      .in("project_id", projects.map((p) => p.id));
    const settled = new Set((links ?? []).filter((l) => l.status === "created" || l.status === "skipped_zero" || (l.status === "failed" && l.attempts >= MAX_ATTEMPTS)).map((l) => l.project_id));

    for (const project of projects.filter((p) => !settled.has(p.id)).slice(0, MAX_PER_RUN)) {
      const res = await createAiUsageInvoice(db, { projectId: project.id, period });
      if (!res.ok) {
        result.failed += 1;
        await captureError(new Error(`AI invoice for ${project.id} / ${period} failed: ${res.error}`), {
          source: "tick",
          path: "ai/billing",
          meta: { project: project.id, period },
        });
      } else if (res.skipped) result.zero += 1;
      else if (res.created) result.raised += 1;
    }
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/billing-pass" });
  }
  return result;
}
