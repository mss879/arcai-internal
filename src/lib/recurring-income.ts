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

export type RecurringIncomeResult = {
  generated: number;
  skipped: number;
  /** 0120 — invoices raised for new months, and reminders sent. */
  invoiced: number;
  reminded: number;
};

/** A safety rail on a table nobody expects to be large. */
const MAX_PER_TICK = 100;

export async function processRecurringIncome(
  supabase: DB,
): Promise<RecurringIncomeResult> {
  const result: RecurringIncomeResult = { generated: 0, skipped: 0, invoiced: 0, reminded: 0 };

  try {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const dayOfMonth = today.getUTCDate();
    // The 1st of the current month — what an entry's `period` always is.
    const period = `${todayIso.slice(0, 7)}-01`;

    const { data: schedules } = await supabase
      .from("recurring_income")
      .select(
        "id, label, amount, currency, day_of_month, started_on, ended_on, last_run_on, auto_invoice",
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

      const { data: entry, error } = await supabase
        .from("recurring_income_entries")
        .insert({
          income_id: schedule.id,
          period,
          due_date: due,
          // Copied, not referenced: raising the price next year must not
          // silently restate what was billed last year.
          amount: schedule.amount,
          currency: schedule.currency,
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !entry) {
        // Almost certainly the unique index doing its job under a race.
        result.skipped++;
        continue;
      }

      // 0120 — the month becomes an invoice the client can actually pay
      // against, numbered by the counter and emailed when there's an address.
      if (schedule.auto_invoice) {
        try {
          const { createRecurringInvoice } = await import("@/lib/invoices");
          const raised = await createRecurringInvoice(supabase, entry.id, { actorId: null });
          if (raised.ok && raised.created) result.invoiced++;
        } catch (e) {
          console.error("[recurring-income] auto-invoice failed:", e);
        }
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

  // 0120 — reminders, for arrangements that asked for them.
  try {
    result.reminded = await remindRecurring(supabase);
  } catch (e) {
    console.error("[recurring-income] reminders failed:", e);
  }

  return result;
}

/** Two days before a month falls due, and three days after it hasn't landed. */
const REMIND_BEFORE_DAYS = 2;
const CHASE_AFTER_DAYS = 3;
const MAX_REMINDERS_PER_TICK = 20;

/**
 * Tell the client a recurring month is coming, or is late (0120).
 *
 * Through notifyClient(), so the channel is chosen once — WhatsApp while
 * their window is open, SMS after, a task when neither. Each entry is
 * reminded at most once before and once after, stamped so a slow tick never
 * sends twice.
 */
async function remindRecurring(supabase: DB): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + REMIND_BEFORE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const lateBefore = new Date(Date.now() - CHASE_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10);

  const { data: entries } = await supabase
    .from("recurring_income_entries")
    .select(
      "id, due_date, amount, currency, period, reminded_at, overdue_reminded_at, invoice_id, income:recurring_income(id, label, client_id, project_id, remind, is_active)",
    )
    .eq("status", "pending")
    .lte("due_date", soon)
    .limit(200)
    .then((r) => r, () => ({ data: null }));

  let sent = 0;
  for (const entry of entries ?? []) {
    if (sent >= MAX_REMINDERS_PER_TICK) break;
    const income = entry.income as unknown as {
      id: string;
      label: string;
      client_id: string | null;
      project_id: string | null;
      remind: boolean;
      is_active: boolean;
    } | null;
    if (!income?.remind || !income.is_active || !income.client_id) continue;

    const amount = `${entry.currency} ${Number(entry.amount).toLocaleString()}`;
    const monthLabel = new Date(`${entry.period}T00:00:00`).toLocaleDateString("en-US", {
      month: "long",
    });

    let message: string | null = null;
    let stamp: "reminded_at" | "overdue_reminded_at" | null = null;
    if (!entry.reminded_at && entry.due_date >= today) {
      message = `Hi — a note from ARC AI: your ${income.label} for ${monthLabel} (${amount}) is due on ${entry.due_date}. Thank you!`;
      stamp = "reminded_at";
    } else if (!entry.overdue_reminded_at && entry.due_date <= lateBefore) {
      message = `Hi — your ${income.label} for ${monthLabel} (${amount}) was due on ${entry.due_date} and hasn't reached us yet. Could you arrange it, or reply here if it's on its way? — ARC AI`;
      stamp = "overdue_reminded_at";
    }
    if (!message || !stamp) continue;

    // Claim before sending, so a slow send can't be repeated by the next tick.
    const now = new Date().toISOString();
    const { data: claimed } = await supabase
      .from("recurring_income_entries")
      .update(stamp === "reminded_at" ? { reminded_at: now } : { overdue_reminded_at: now })
      .eq("id", entry.id)
      .is(stamp, null)
      .select("id");
    if (!claimed?.length) continue;

    const { notifyClient } = await import("@/lib/client-notify");
    const res = await notifyClient(supabase, {
      clientId: income.client_id,
      projectId: income.project_id,
      message,
      kind: "reminder",
      actorId: null,
      invoiceId: entry.invoice_id,
    });
    if (res.ok) sent++;
  }
  return sent;
}
