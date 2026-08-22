"use server";

/**
 * Staff loans (0088) — admin only.
 *
 * Issuing a loan doesn't touch a single commission row: the member's balance
 * drops because the app subtracts what they still owe (see @/lib/loans), and
 * climbs back as repayments land. So every action here is just bookkeeping —
 * which is exactly why it can be trusted and undone.
 */

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { sendSmsToUser } from "@/lib/sms-alerts";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";
import type { ActionResult, MemberLoanApproval } from "@/lib/types";

/** Every screen that shows this member's money. */
function revalidateMemberMoney(userId: string) {
  revalidatePath(`/team/${userId}`);
  revalidatePath("/team");
  revalidatePath("/profile");
}

/**
 * Tell the member their loan was approved — once.
 *
 * They get a text on their profile number and an in-app notification, and the
 * loan is stamped so a second save (or an edit weeks later) can't text them
 * again. Nothing here can fail the approval that triggered it: an SMS that
 * doesn't go out must never leave the loan un-approved.
 */
async function announceApproval(
  supabase: Awaited<ReturnType<typeof createClient>>,
  loanId: string,
  adminId: string,
): Promise<{ texted: boolean }> {
  const { data: loan } = await supabase
    .from("member_loans")
    .select("id, user_id, amount, currency, approval, approval_notified_at")
    .eq("id", loanId)
    .maybeSingle();

  if (!loan) return { texted: false };
  if (loan.approval !== "approved") return { texted: false };
  if (loan.approval_notified_at) return { texted: false }; // already told them
  if (loan.user_id === adminId) return { texted: false }; // approved your own

  const amount = formatCurrency(Number(loan.amount), loan.currency);

  // Claim the announcement before sending, so two quick saves can't both
  // decide they're the one to text.
  const { data: claimed, error: claimError } = await supabase
    .from("member_loans")
    .update({ approval_notified_at: new Date().toISOString() })
    .eq("id", loan.id)
    .is("approval_notified_at", null)
    .select("id");
  if (claimError || !claimed?.length) return { texted: false };

  await supabase.from("notifications").insert({
    user_id: loan.user_id,
    actor_id: adminId,
    type: "commission",
    title: `Your loan of ${amount} was approved`,
    body: "It's deducted from your commission balance until it's repaid. See your profile for the balance.",
    link: "/profile",
  });

  // A text that can't be delivered (no phone on file, Notify.lk not
  // configured) is reported back so the admin hears about it instead of
  // assuming the member was told.
  const { sent } = await sendSmsToUser({
    userId: loan.user_id,
    message: `ARC AI: Your loan of ${amount} has been approved. It will be deducted from your commission until repaid. See your profile for the balance.`,
  });
  return { texted: sent };
}

export type MemberLoanInput = {
  id?: string;
  user_id: string;
  amount: number;
  currency?: string;
  reason?: string | null;
  issued_on?: string | null;
  due_on?: string | null;
  note?: string | null;
  /** 0089 — pending until the admin grants it. Defaults to pending. */
  approval?: MemberLoanApproval;
};

export async function saveMemberLoan(
  input: MemberLoanInput,
): Promise<ActionResult<{ texted: boolean }>> {
  const admin = await requireAdmin();
  if (!input.user_id) return { ok: false, error: "Choose a member." };
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    return { ok: false, error: "Enter a valid loan amount." };

  const supabase = await createClient();
  const approval: MemberLoanApproval = input.approval ?? "pending";
  const approved = approval === "approved";

  const payload = {
    user_id: input.user_id,
    amount: input.amount,
    currency: input.currency || "LKR",
    reason: input.reason?.trim() || null,
    issued_on: input.issued_on || new Date().toISOString().slice(0, 10),
    due_on: input.due_on || null,
    note: input.note?.trim() || null,
    issued_by: admin.id,
    approval,
    approved_at: approved ? new Date().toISOString() : null,
    approved_by: approved ? admin.id : null,
    // Dropping out of approved re-arms the announcement, so if it's granted
    // again later the member is told again.
    ...(approved ? {} : { approval_notified_at: null }),
  };

  const saved = input.id
    ? await supabase
        .from("member_loans")
        .update(payload)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase.from("member_loans").insert(payload).select("id").single();

  if (saved.error) return { ok: false, error: saved.error.message };

  let texted = false;
  if (approved && saved.data) {
    ({ texted } = await announceApproval(supabase, saved.data.id, admin.id));
  } else if (!input.id && input.user_id !== admin.id) {
    // A request on file changes none of their numbers, but they should still
    // know it was logged and is waiting on a decision.
    await supabase.from("notifications").insert({
      user_id: input.user_id,
      actor_id: admin.id,
      type: "commission",
      title: `Loan request of ${formatCurrency(input.amount, payload.currency)} logged`,
      body: "It's waiting for approval. Nothing is deducted from your commission until it's approved.",
      link: "/profile",
    });
  }

  revalidateMemberMoney(input.user_id);
  return { ok: true, texted };
}

/**
 * Approve, decline, or send a loan back to pending.
 *
 * Approving is the moment the money counts as gone: it starts being deducted
 * from their commission, and they get the text saying so.
 */
export async function setMemberLoanApproval(
  id: string,
  userId: string,
  approval: MemberLoanApproval,
): Promise<ActionResult<{ texted: boolean }>> {
  const admin = await requireAdmin();
  const supabase = await createClient();
  const approved = approval === "approved";

  const { error } = await supabase
    .from("member_loans")
    .update({
      approval,
      approved_at: approved ? new Date().toISOString() : null,
      approved_by: approved ? admin.id : null,
      ...(approved ? {} : { approval_notified_at: null }),
    })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  const texted = approved
    ? (await announceApproval(supabase, id, admin.id)).texted
    : false;

  revalidateMemberMoney(userId);
  return { ok: true, texted };
}

export async function deleteMemberLoan(
  id: string,
  userId: string,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  // Repayments cascade with the loan (0088) — deleting is for a loan entered
  // by mistake, not for one that was settled.
  const { error } = await supabase.from("member_loans").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateMemberMoney(userId);
  return { ok: true };
}

/**
 * Write a loan off, or put it back on the books.
 *
 * A written-off loan stops being deducted from commission — the company has
 * decided to absorb it, so it must stop suppressing what the member is owed.
 */
export async function setMemberLoanWrittenOff(
  id: string,
  userId: string,
  writtenOff: boolean,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();

  if (writtenOff) {
    const { error } = await supabase
      .from("member_loans")
      .update({ status: "written_off" })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    // Back to 'outstanding'; the repayment trigger immediately corrects it to
    // 'repaid' if what's already come back covers the loan.
    const { error } = await supabase
      .from("member_loans")
      .update({ status: "outstanding" })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
    // Nudge the trigger by touching the amount to itself — cheaper than
    // duplicating the settled/not-settled rule here in TypeScript.
    const { data: loan } = await supabase
      .from("member_loans")
      .select("amount")
      .eq("id", id)
      .maybeSingle();
    if (loan) {
      const { data: paid } = await supabase
        .from("member_loan_repayments")
        .select("amount")
        .eq("loan_id", id);
      const repaid = (paid ?? []).reduce((s, r) => s + Number(r.amount), 0);
      if (repaid >= Number(loan.amount)) {
        await supabase
          .from("member_loans")
          .update({ status: "repaid" })
          .eq("id", id);
      }
    }
  }

  revalidateMemberMoney(userId);
  return { ok: true };
}

export type LoanRepaymentInput = {
  id?: string;
  loan_id: string;
  /** The loan's owner — used only to revalidate their screens. */
  user_id: string;
  amount: number;
  paid_on?: string | null;
  method?: string | null;
  note?: string | null;
};

export async function saveLoanRepayment(
  input: LoanRepaymentInput,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    return { ok: false, error: "Enter a valid repayment amount." };

  const supabase = await createClient();

  // Nothing can come back on a loan that was never granted.
  const { data: loan } = await supabase
    .from("member_loans")
    .select("approval")
    .eq("id", input.loan_id)
    .maybeSingle();
  if (loan && loan.approval !== "approved") {
    return { ok: false, error: "Approve the loan before recording repayments." };
  }

  const payload = {
    loan_id: input.loan_id,
    amount: input.amount,
    paid_on: input.paid_on || new Date().toISOString().slice(0, 10),
    method: input.method?.trim() || null,
    note: input.note?.trim() || null,
    recorded_by: admin.id,
  };

  const { error } = input.id
    ? await supabase
        .from("member_loan_repayments")
        .update(payload)
        .eq("id", input.id)
    : await supabase.from("member_loan_repayments").insert(payload);

  if (error) return { ok: false, error: error.message };

  if (!input.id && input.user_id !== admin.id) {
    await supabase.from("notifications").insert({
      user_id: input.user_id,
      actor_id: admin.id,
      type: "commission",
      title: `Repayment of ${formatCurrency(input.amount)} recorded`,
      body: "That much commission is released back to you. See your profile for the remaining loan balance.",
      link: "/profile",
    });
  }

  revalidateMemberMoney(input.user_id);
  return { ok: true };
}

export async function deleteLoanRepayment(
  id: string,
  userId: string,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("member_loan_repayments")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateMemberMoney(userId);
  return { ok: true };
}
