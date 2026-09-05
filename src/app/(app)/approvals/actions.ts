"use server";

import { revalidatePath } from "next/cache";

import { approvalsCount } from "@/lib/approvals";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

import { setMemberLoanApproval } from "@/app/(app)/team/[id]/actions";
import { decideLessonAction } from "@/app/(app)/whatsapp/actions";
import { approveLeadOutreach, discardLeadOutreach } from "@/app/(app)/crm/actions";

/**
 * Deciding, from one screen (0119).
 *
 * Every branch here delegates to the action that already owns that queue.
 * That is the whole design: approving a loan texts the member, discarding an
 * outreach draft has its own bookkeeping, and re-implementing either of those
 * here is how the side effect quietly goes missing.
 *
 * Only two queues are decided in place — commissions and change requests —
 * and only because their "approve" is a single status write with no side
 * effects of its own.
 */

export type ApprovalDecision = "approve" | "decline";

export async function decideApproval(
  key: string,
  decision: ApprovalDecision,
  meta?: { userId?: string },
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const at = key.indexOf(":");
  if (at <= 0) return { ok: false, error: "That item no longer exists." };
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);

  const supabase = await createClient();

  switch (kind) {
    case "loan": {
      if (!meta?.userId) return { ok: false, error: "Missing the member." };
      const res = await setMemberLoanApproval(
        id,
        meta.userId,
        decision === "approve" ? "approved" : "declined",
      );
      if (!res.ok) return res;
      break;
    }

    case "commission": {
      const { error } = await supabase
        .from("commissions")
        .update(
          decision === "approve"
            ? { status: "approved" as const }
            : { status: "pending" as const },
        )
        .eq("id", id);
      if (error) return { ok: false, error: error.message };
      // Declining a commission means deleting it, which is a different and
      // more destructive act — done on the project, where the context is.
      if (decision === "decline") {
        return {
          ok: false,
          error: "Remove a commission from the project it belongs to.",
        };
      }
      break;
    }

    case "wa_lesson": {
      const res = await decideLessonAction(
        id,
        decision === "approve" ? "approved" : "rejected",
      );
      if (!res.ok) return res;
      break;
    }

    case "outreach": {
      // `id` is the LEAD id for this queue — that is what both actions take.
      const res =
        decision === "approve"
          ? await approveLeadOutreach(id)
          : await discardLeadOutreach(id);
      if (!res.ok) return res;
      break;
    }

    case "change_request": {
      if (decision === "approve") {
        // Accepting bills the client, so it belongs on the project page where
        // the price is set. This screen can only decline.
        return {
          ok: false,
          error: "Price it and accept it on the project — it becomes a billable extra.",
        };
      }
      const { error } = await supabase
        .from("project_change_requests")
        .update({ status: "declined" as const })
        .eq("id", id);
      if (error) return { ok: false, error: error.message };
      break;
    }

    // An assistant draft is sent from its card (it needs a browser session),
    // and a carousel needs a design chosen. Both are "open it" rather than
    // "decide it here", and the UI links rather than offering a button.
    default:
      return { ok: false, error: "Open this one to deal with it." };
  }

  revalidatePath("/approvals");
  revalidatePath("/dashboard");
  return { ok: true };
}

/** The topbar badge's number — every queue, one round-trip (approvals_count). */
export async function getApprovalsCount(): Promise<number> {
  const profile = await getProfile();
  if (!profile) return 0;
  const supabase = await createClient();
  return approvalsCount(supabase).catch(() => 0);
}
