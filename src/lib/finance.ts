import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendPushToUser } from "@/lib/push";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

export type FinanceTickResult = {
  installment_reminders: number;
  overdue_chases: number;
  cheque_alerts: number;
};

/**
 * Built-in finance housekeeping, run from the automation tick:
 *
 *  1. SMS reminder N days before each pending installment is due
 *     (per-plan `remind_days_before`; null disables).
 *  2. SMS chase the day after an installment went overdue.
 *  3. In-app + push alert to every member when a pending cheque hits
 *     its due date.
 *
 * All bookkeeping flags (`reminder_sent_at`, `overdue_sent_at`,
 * `alerted_at`) guarantee each message fires exactly once.
 */
export async function processFinanceReminders(supabase: DB): Promise<FinanceTickResult> {
  const result: FinanceTickResult = {
    installment_reminders: 0,
    overdue_chases: 0,
    cheque_alerts: 0,
  };
  const today = new Date().toISOString().slice(0, 10);

  // ---- 1 + 2: installment reminders --------------------------------------
  if (isSmsConfigured()) {
    const { data: pending } = await supabase
      .from("payment_installments")
      .select("*, plan:payment_plans(*)")
      .eq("status", "pending")
      .limit(200);

    for (const inst of pending ?? []) {
      const plan = (inst as unknown as {
        plan: Database["public"]["Tables"]["payment_plans"]["Row"] | null;
      }).plan;
      if (!plan || plan.status !== "active" || plan.remind_days_before == null) continue;
      const phone = normalizePhone(plan.phone ?? "");
      if (!phone.ok) continue;

      const dueMs = new Date(`${inst.due_date}T00:00:00`).getTime();
      const daysUntil = Math.floor((dueMs - Date.now()) / (24 * 3600_000)) + 1;
      const firstName = plan.contact_name.split(/\s+/)[0] || "there";
      const amount = `${plan.currency} ${Number(inst.amount).toLocaleString()}`;

      // Pre-due reminder.
      if (
        !inst.reminder_sent_at &&
        daysUntil >= 0 &&
        daysUntil <= plan.remind_days_before
      ) {
        const message = `Hi ${firstName}, a friendly reminder from ARC AI: installment ${inst.seq} of "${plan.title}" (${amount}) is due on ${inst.due_date}. Thank you!`;
        const sent = await sendSms({ to: phone.value, message, contactName: plan.contact_name });
        await supabase.from("sms_messages").insert({
          to_number: phone.value,
          message,
          client_id: plan.client_id,
          client_name: plan.contact_name,
          kind: "payment_reminder",
          status: sent.ok ? "sent" : "failed",
          error: sent.ok ? null : sent.error,
          segments: countSmsSegments(message),
          created_by: null,
        });
        if (sent.ok) {
          await supabase
            .from("payment_installments")
            .update({ reminder_sent_at: new Date().toISOString() })
            .eq("id", inst.id);
          result.installment_reminders++;
        }
      }

      // Overdue chase (once, the day after due).
      if (!inst.overdue_sent_at && inst.due_date < today) {
        const message = `Hi ${firstName}, installment ${inst.seq} of "${plan.title}" (${amount}) was due on ${inst.due_date} and is still pending. Please arrange payment or contact us at support@arcai.agency.`;
        const sent = await sendSms({ to: phone.value, message, contactName: plan.contact_name });
        await supabase.from("sms_messages").insert({
          to_number: phone.value,
          message,
          client_id: plan.client_id,
          client_name: plan.contact_name,
          kind: "payment_reminder",
          status: sent.ok ? "sent" : "failed",
          error: sent.ok ? null : sent.error,
          segments: countSmsSegments(message),
          created_by: null,
        });
        if (sent.ok) {
          await supabase
            .from("payment_installments")
            .update({ overdue_sent_at: new Date().toISOString() })
            .eq("id", inst.id);
          result.overdue_chases++;
        }
      }
    }
  }

  // ---- 3: cheque due alerts ------------------------------------------------
  const { data: dueCheques } = await supabase
    .from("cheques")
    .select("*")
    .eq("status", "pending")
    .is("alerted_at", null)
    .lte("due_date", today);

  if (dueCheques?.length) {
    const { data: profiles } = await supabase.from("profiles").select("id");
    for (const cheque of dueCheques) {
      const title = `Cheque due: ${cheque.party_name}`;
      const body = `${cheque.currency} ${Number(cheque.amount).toLocaleString()} (${cheque.direction === "received" ? "to deposit" : "will be cashed"}) — due ${cheque.due_date}${cheque.bank ? `, ${cheque.bank}` : ""}.`;
      for (const p of profiles ?? []) {
        await supabase.from("notifications").insert({
          user_id: p.id,
          type: "system",
          title,
          body,
          link: "/finance?tab=cheques",
        });
        await sendPushToUser({ userId: p.id, title, body, link: "/finance?tab=cheques" });
      }
      await supabase
        .from("cheques")
        .update({ alerted_at: new Date().toISOString() })
        .eq("id", cheque.id);
      result.cheque_alerts++;
    }
  }

  return result;
}
