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
import { attachRepayments, loanBalance } from "@/lib/loans";
import { notifyUsers } from "@/lib/notify";
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
  /** 0120 — set when a payout run withheld this from the commission. */
  payout_id?: string | null;
  /** Skip the member's notification — the payout run sends its own. */
  silent?: boolean;
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
    // Only when a payout run is writing — the column is 0120's.
    ...(input.payout_id ? { payout_id: input.payout_id } : {}),
  };

  const { error } = input.id
    ? await supabase
        .from("member_loan_repayments")
        .update(payload)
        .eq("id", input.id)
    : await supabase.from("member_loan_repayments").insert(payload);

  if (error) return { ok: false, error: error.message };

  if (!input.id && !input.silent && input.user_id !== admin.id) {
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


// ---- Commission payout run (T4.7, 0120) ------------------------------------

export type CommissionPayoutInput = {
  /** The month the run covers — `YYYY-MM` or any date in it. */
  period: string;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  /** Withhold what they still owe on approved loans, oldest first. */
  deductLoan?: boolean;
};

export type CommissionPayoutResult = {
  payoutId: string;
  gross: number;
  loanDeduction: number;
  netPaid: number;
  commissions: number;
};

/** `2026-09-01` from `2026-09`, `2026-09-17` or a full timestamp. */
function periodStartOf(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

function periodLabel(period: string): string {
  return new Date(`${period}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Pay a member what they are owed, as one record.
 *
 * Until 0120 "paid" was a status somebody flipped on each commission row,
 * with nothing saying when, how much in total, or whether a loan was netted
 * off. A run does it once, in order:
 *
 *   1. one `commission_payouts` row — gross, deduction, net, how and when;
 *   2. every APPROVED, unpaid commission of theirs → `paid`, stamped with
 *      the run, in ONE update (a pending allocation is not money yet);
 *   3. the loan deduction as repayments through `saveLoanRepayment`, so the
 *      loan's own trigger settles it and the balance reads right everywhere;
 *   4. an `expenses` row, so Finance's outflows and this agree
 *      (category `commission` from 0121; `salaries` on a database without it);
 *   5. tell the member.
 *
 * Nothing here computes what is owed on its own: the figures come from the
 * same rows `summariseMemberMoney()` reads.
 */
export async function runCommissionPayout(
  userId: string,
  input: CommissionPayoutInput,
): Promise<ActionResult<CommissionPayoutResult>> {
  const admin = await requireAdmin();
  const period = periodStartOf(input.period);
  if (!period) return { ok: false, error: "Pick the month the payout covers." };

  const supabase = await createClient();

  const { data: member } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("id", userId)
    .maybeSingle();
  if (!member) return { ok: false, error: "That member no longer exists." };

  // --- What is owed: approved and not yet paid ---------------------------
  const { data: approved, error: approvedError } = await supabase
    .from("commissions")
    .select("id, amount")
    .eq("user_id", userId)
    .eq("status", "approved")
    .is("payout_id", null);
  if (approvedError) return { ok: false, error: approvedError.message };
  const rows = approved ?? [];
  const gross = rows.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  if (gross <= 0) {
    return { ok: false, error: "Nothing approved is waiting to be paid. Approve their commissions first." };
  }

  // --- The loan deduction, oldest loan first -----------------------------
  const allocations: { loanId: string; amount: number }[] = [];
  if (input.deductLoan) {
    const [{ data: loans }, { data: repayments }] = await Promise.all([
      supabase
        .from("member_loans")
        .select("*")
        .eq("user_id", userId)
        .eq("approval", "approved")
        .eq("status", "outstanding")
        .order("issued_on", { ascending: true }),
      supabase.from("member_loan_repayments").select("*").eq("user_id", userId),
    ]);
    let remaining = gross;
    for (const loan of attachRepayments(loans ?? [], repayments ?? [])) {
      if (remaining <= 0) break;
      const balance = loanBalance(loan);
      if (balance <= 0) continue;
      const take = Math.min(balance, remaining);
      allocations.push({ loanId: loan.id, amount: Math.round(take * 100) / 100 });
      remaining -= take;
    }
  }
  const loanDeduction = allocations.reduce((s, a) => s + a.amount, 0);
  const netPaid = Math.round((gross - loanDeduction) * 100) / 100;

  // --- 1. The record ------------------------------------------------------
  const { data: payout, error: payoutError } = await supabase
    .from("commission_payouts")
    .insert({
      user_id: userId,
      period,
      gross,
      loan_deduction: loanDeduction,
      net_paid: netPaid,
      method: input.method?.trim() || null,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      paid_by: admin.id,
    })
    .select("id")
    .single();
  if (payoutError || !payout) {
    return { ok: false, error: payoutError?.message ?? "Could not record the payout." };
  }

  // --- 2. Every approved commission → paid, in one statement --------------
  const { error: markError } = await supabase
    .from("commissions")
    .update({ status: "paid", payout_id: payout.id })
    .in(
      "id",
      rows.map((c) => c.id),
    )
    .eq("status", "approved")
    .is("payout_id", null);
  if (markError) {
    // Leave no half-run behind: the record goes if the commissions did not move.
    await supabase.from("commission_payouts").delete().eq("id", payout.id);
    return { ok: false, error: markError.message };
  }

  // --- 3. The deduction, as repayments the loan trigger understands -------
  const label = periodLabel(period);
  for (const a of allocations) {
    const res = await saveLoanRepayment({
      loan_id: a.loanId,
      user_id: userId,
      amount: a.amount,
      method: "Withheld from commission payout",
      note: `Payout for ${label}`,
      payout_id: payout.id,
      silent: true,
    });
    if (!res.ok) {
      // The commissions are paid and the record stands; say what did not.
      revalidateMemberMoney(userId);
      return { ok: false, error: `Paid, but the loan deduction failed: ${res.error}` };
    }
  }

  // --- 4. The company ledger ---------------------------------------------
  const description = `Commission payout — ${member.full_name} — ${label}`;
  const expenseBase = {
    expense_date: new Date().toISOString().slice(0, 10),
    description,
    vendor: member.full_name,
    amount: netPaid,
    currency: "LKR",
    payment_method: input.method?.trim() || null,
    created_by: admin.id,
  };
  let expenseId: string | null = null;
  if (netPaid > 0) {
    const first = await supabase
      .from("expenses")
      .insert({ ...expenseBase, category: "commission" })
      .select("id")
      .single();
    if (first.data) {
      expenseId = first.data.id;
    } else {
      // 0121 not applied: the CHECK still refuses 'commission'.
      const second = await supabase
        .from("expenses")
        .insert({ ...expenseBase, category: "salaries" })
        .select("id")
        .single();
      expenseId = second.data?.id ?? null;
    }
    if (expenseId) {
      await supabase.from("commission_payouts").update({ expense_id: expenseId }).eq("id", payout.id);
    }
  }

  // --- 5. Tell them --------------------------------------------------------
  if (userId !== admin.id) {
    await notifyUsers(supabase, {
      userIds: [userId],
      type: "commission",
      title: `Commission of ${formatCurrency(netPaid)} paid out`,
      body:
        loanDeduction > 0
          ? `${formatCurrency(gross)} for ${label}, less ${formatCurrency(loanDeduction)} withheld against your loan.${input.method ? ` Sent by ${input.method}.` : ""}`
          : `For ${label}.${input.method ? ` Sent by ${input.method}.` : ""}${input.reference ? ` Ref ${input.reference}.` : ""}`,
      link: "/profile",
      actorId: admin.id,
    }).catch(() => 0);
  }

  revalidateMemberMoney(userId);
  revalidatePath("/finance");
  return {
    ok: true,
    payoutId: payout.id,
    gross,
    loanDeduction,
    netPaid,
    commissions: rows.length,
  };
}
