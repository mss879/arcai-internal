"use server";

/**
 * The team's side of what the client sends in (0094).
 *
 * Change requests and approvals both arrive from the portal; this is where
 * they get answered. The important one is `acceptChangeRequest` — it is the
 * difference between absorbing scope creep and charging for it, so it writes
 * a real billable expense rather than a note that someone might remember.
 */

import { revalidatePath } from "next/cache";

import {
  firstName,
  projectClientContact,
  sendClientSms,
} from "@/lib/project-sms";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// ---------------------------------------------------------------------------
// Change requests (CX-3)
// ---------------------------------------------------------------------------

/** Put a price on what the client asked for, and optionally tell them. */
export async function quoteChangeRequest(
  id: string,
  projectId: string,
  amount: number,
  note: string | null,
  opts?: { tellClient?: boolean },
): Promise<ActionResult & { smsError?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Enter a valid amount." };
  }

  const { data: updated, error } = await supabase
    .from("project_change_requests")
    .update({
      status: "quoted",
      quoted_amount: amount,
      quote_note: note?.trim() || null,
    })
    .eq("id", id)
    .eq("project_id", projectId)
    .select("id, body")
    .single();
  if (error || !updated) {
    return { ok: false, error: error?.message ?? "Couldn't save the quote." };
  }

  let smsError: string | undefined;
  if (opts?.tellClient) {
    const contact = await projectClientContact(supabase, projectId);
    if ("error" in contact) smsError = contact.error;
    else {
      const { data: project } = await supabase
        .from("projects")
        .select("currency")
        .eq("id", projectId)
        .maybeSingle();
      const res = await sendClientSms(supabase, {
        contact,
        message: [
          `Hi ${firstName(contact.clientName)}, about your request on ${contact.projectName}:`,
          `We can do it for ${project?.currency ?? "LKR"} ${amount.toLocaleString()}.`,
          note?.trim() || null,
          "Let us know and we'll get started.\n— ARC AI",
        ]
          .filter(Boolean)
          .join("\n"),
        kind: "custom",
        actorId: user.id,
        eventDetail: "Change request quoted to the client",
      });
      if (!res.ok) smsError = res.error;
    }
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, ...(smsError ? { smsError } : {}) };
}

/**
 * Say yes to a change — and bill for it.
 *
 * Writes a billable project expense at the quoted price and a task to do the
 * work. The expense is what the Additional expenses tab already knows how to
 * put on an invoice, so accepting a change here means it cannot be forgotten
 * at invoicing time.
 */
export async function acceptChangeRequest(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: request } = await supabase
    .from("project_change_requests")
    .select("id, body, status, quoted_amount, expense_id")
    .eq("id", id)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!request) return { ok: false, error: "Request not found." };
  if (request.expense_id) {
    return { ok: false, error: "This one has already been accepted." };
  }
  if (request.quoted_amount == null) {
    return { ok: false, error: "Price it first, so there's something to bill." };
  }

  const { data: project } = await supabase
    .from("projects")
    .select("currency")
    .eq("id", projectId)
    .maybeSingle();

  const summary =
    request.body.length > 70 ? `${request.body.slice(0, 67)}…` : request.body;

  const { data: expense, error: expenseError } = await supabase
    .from("project_expenses")
    .insert({
      project_id: projectId,
      description: `Change request — ${summary}`,
      detail: request.body,
      category: "scope",
      qty: 1,
      unit_amount: Number(request.quoted_amount),
      currency: project?.currency ?? "LKR",
      billable: true,
    })
    .select("id")
    .single();
  if (expenseError || !expense) {
    return {
      ok: false,
      error: expenseError?.message ?? "Couldn't create the expense.",
    };
  }

  // A task too, so the work itself doesn't get lost behind the invoice line.
  const { data: todo } = await supabase
    .from("todos")
    .insert({
      title: `Change request: ${summary}`,
      description: request.body,
      project_id: projectId,
      priority: "high",
    })
    .select("id")
    .single();

  await supabase
    .from("project_change_requests")
    .update({
      status: "accepted",
      expense_id: expense.id,
      todo_id: todo?.id ?? null,
    })
    .eq("id", id);

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "change_accepted",
    `${summary} — billed at ${project?.currency ?? "LKR"} ${Number(request.quoted_amount).toLocaleString()}`,
    "team",
  );

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/todos");
  return { ok: true };
}

export async function declineChangeRequest(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase
    .from("project_change_requests")
    .update({ status: "declined" })
    .eq("id", id)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approvals (CX-2)
// ---------------------------------------------------------------------------

/** Put something in front of the client to sign off, and text them about it. */
export async function requestApproval(
  projectId: string,
  title: string,
  detail: string | null,
  opts?: { tellClient?: boolean; milestoneId?: string | null },
): Promise<ActionResult & { smsError?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!title.trim()) return { ok: false, error: "What are they approving?" };

  const { error } = await supabase.from("project_approvals").insert({
    project_id: projectId,
    milestone_id: opts?.milestoneId ?? null,
    title: title.trim(),
    detail: detail?.trim() || null,
    requested_by: user.id,
  });
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "approval_requested",
    title.trim(),
    "team",
  );

  let smsError: string | undefined;
  if (opts?.tellClient) {
    const contact = await projectClientContact(supabase, projectId);
    if ("error" in contact) smsError = contact.error;
    else {
      const { data: project } = await supabase
        .from("projects")
        .select("share_token")
        .eq("id", projectId)
        .maybeSingle();
      const { appLink } = await import("@/lib/app-url");
      const link = project?.share_token
        ? appLink(`/public/project/${project.share_token}`)
        : null;
      const res = await sendClientSms(supabase, {
        contact,
        message: [
          `Hi ${firstName(contact.clientName)}, ${title.trim()} is ready for your approval on ${contact.projectName}.`,
          link,
          "— ARC AI",
        ]
          .filter(Boolean)
          .join("\n"),
        kind: "custom",
        actorId: user.id,
        eventDetail: `Approval request texted: ${title.trim()}`,
      });
      if (!res.ok) smsError = res.error;
    }
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, ...(smsError ? { smsError } : {}) };
}

export async function deleteApproval(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("project_approvals").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Comments (CX-4) — the team's replies
// ---------------------------------------------------------------------------

export async function postTeamComment(
  projectId: string,
  body: string,
  milestoneId?: string | null,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!body.trim()) return { ok: false, error: "Write something first." };

  const { data: me } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    milestone_id: milestoneId ?? null,
    author_type: "team",
    author_id: user.id,
    author_name: me?.full_name ?? "ARC AI",
    body: body.trim(),
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
