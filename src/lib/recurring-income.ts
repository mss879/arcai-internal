import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * The money that simply turns up every month (0100).
 *
 * Finance tracked one-off installments, cheques and project payments. It had
 * no idea about hosting, care plans and social-media retainers — income that
 * arrives every month and is invisible until someone remembers to type it in.
 * Nobody notices a missed month, which is exactly the money most worth
 * noticing.
 *
 * Once a month, per arrangement, this materialises one entry the team marks
 * received. The arrangement is the promise; the entry is the fact — and only
 * facts belong in a cash-flow chart.
 *
 * Never throws: it runs inside the tick alongside everything else.
 */

export type RecurringIncomeResult = { generated: number; skipped: number };

/** A safety rail on a table nobody expects to be large. */
const MAX_PER_TICK = 100;

export async function processRecurringIncome(
  supabase: DB,
): Promise<RecurringIncomeResult> {
  const result: RecurringIncomeResult = { generated: 0, skipped: 0 };

  try {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const dayOfMonth = today.getUTCDate();
    // The 1st of the current month — what an entry's `period` always is.
    const period = `${todayIso.slice(0, 7)}-01`;

    const { data: schedules } = await supabase
      .from("recurring_income")
      .select(
        "id, label, amount, currency, day_of_month, started_on, ended_on, last_run_on",
      )
      .eq("is_active", true)
      // Due today or earlier in the month — a tick that misses the 4th still
      // generates on the 5th rather than skipping the month entirely.
      .lte("day_of_month", dayOfMonth)
      .lte("started_on", todayIso)
      .limit(MAX_PER_TICK);

    if (!schedules?.length) return result;

    for (const schedule of schedules) {
      // Ended arrangements stop, but only after the month they ended in.
      if (schedule.ended_on && schedule.ended_on < period) {
        result.skipped++;
        continue;
      }
      // Cheap guard first: the stamp usually answers it without a query.
      if (schedule.last_run_on && schedule.last_run_on >= period) {
        result.skipped++;
        continue;
      }

      // The real guard. `(income_id, period)` is unique, so a race loses
      // harmlessly rather than double-billing a client's month.
      const { data: existing } = await supabase
        .from("recurring_income_entries")
        .select("id")
        .eq("income_id", schedule.id)
        .eq("period", period)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("recurring_income")
          .update({ last_run_on: period })
          .eq("id", schedule.id);
        result.skipped++;
        continue;
      }

      const due = `${todayIso.slice(0, 7)}-${String(schedule.day_of_month).padStart(2, "0")}`;

      const { error } = await supabase.from("recurring_income_entries").insert({
        income_id: schedule.id,
        period,
        due_date: due,
        // Copied, not referenced: raising the price next year must not
        // silently restate what was billed last year.
        amount: schedule.amount,
        currency: schedule.currency,
        status: "pending",
      });
      if (error) {
        // Almost certainly the unique index doing its job under a race.
        result.skipped++;
        continue;
      }

      await supabase
        .from("recurring_income")
        .update({ last_run_on: period })
        .eq("id", schedule.id);
      result.generated++;
    }
  } catch (e) {
    console.error("[recurring-income] generation failed:", e);
  }

  return result;
}
