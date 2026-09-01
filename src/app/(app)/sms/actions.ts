"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { processDueSmsRuns } from "@/lib/sms-automation";
import {
  SMS_MAX_LENGTH,
  countSmsSegments,
  normalizePhone,
  personalizeMessage,
} from "@/lib/sms-utils";
import type {
  ActionResult,
  SmsKind,
  SmsStepKind,
  SmsWorkflow,
  SmsWorkflowStep,
} from "@/lib/types";

// ---- Sending -------------------------------------------------------------

export type SendSmsInput = {
  phone: string;
  message: string;
  clientId?: string | null;
  clientName?: string;
  kind?: SmsKind;
  invoiceId?: string | null;
};

/**
 * Send one SMS (custom message or payment reminder) and log it to
 * `sms_messages` — including failed attempts, so the history is honest.
 */
export async function sendSmsAction(input: SendSmsInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, error: phone.error };

  const clientName = input.clientName?.trim() ?? "";
  const message = personalizeMessage(input.message ?? "", clientName).trim();
  if (!message) return { ok: false, error: "Write a message first." };
  if (message.length > SMS_MAX_LENGTH) {
    return {
      ok: false,
      error: `Message is too long (${message.length}/${SMS_MAX_LENGTH} characters).`,
    };
  }

  const kind: SmsKind = input.kind === "payment_reminder" ? "payment_reminder" : "custom";

  const result = await sendSms({
    to: phone.value,
    message,
    contactName: clientName || undefined,
  });

  await supabase.from("sms_messages").insert({
    to_number: phone.value,
    message,
    client_id: input.clientId || null,
    client_name: clientName,
    kind,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    invoice_id: input.invoiceId || null,
    segments: countSmsSegments(message),
  });

  revalidatePath("/sms");
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

export type PromotionRecipient = {
  clientId: string | null;
  clientName: string;
  phone: string;
};

export type SendPromotionResult =
  | { ok: true; sent: number; failed: number; firstError?: string }
  | { ok: false; error: string };

/** Safety cap so one click can't fire an unbounded blast. */
const MAX_PROMOTION_RECIPIENTS = 500;
/** Notify.lk calls run in small parallel batches to keep the action fast. */
const PROMOTION_BATCH_SIZE = 5;

/**
 * Send one offer message to many clients at once (Promotions tab).
 * Every attempt — including invalid numbers — is logged to `sms_messages`
 * with kind 'promotion' so History shows exactly who got what.
 */
export async function sendPromotionSms(input: {
  message: string;
  recipients: PromotionRecipient[];
}): Promise<SendPromotionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const template = (input.message ?? "").trim();
  if (!template) return { ok: false, error: "Write the offer message first." };

  const recipients = (input.recipients ?? []).slice(0, MAX_PROMOTION_RECIPIENTS);
  if (recipients.length === 0) {
    return { ok: false, error: "Select at least one client." };
  }

  type LogRow = {
    to_number: string;
    message: string;
    client_id: string | null;
    client_name: string;
    kind: "promotion";
    status: "sent" | "failed";
    error: string | null;
    segments: number;
  };
  const rows: LogRow[] = [];
  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;

  async function deliver(recipient: PromotionRecipient) {
    const clientName = recipient.clientName?.trim() ?? "";
    const message = personalizeMessage(template, clientName).trim();
    const phone = normalizePhone(recipient.phone);

    let status: "sent" | "failed" = "failed";
    let error: string | null = null;

    if (!phone.ok) {
      error = phone.error;
    } else if (message.length > SMS_MAX_LENGTH) {
      error = `Message is too long (${message.length}/${SMS_MAX_LENGTH} characters).`;
    } else {
      const result = await sendSms({
        to: phone.value,
        message,
        contactName: clientName || undefined,
      });
      if (result.ok) status = "sent";
      else error = result.error;
    }

    if (status === "sent") sent++;
    else {
      failed++;
      firstError ??= error ?? undefined;
    }

    rows.push({
      to_number: phone.ok ? phone.value : recipient.phone,
      message,
      client_id: recipient.clientId || null,
      client_name: clientName,
      kind: "promotion",
      status,
      error,
      segments: countSmsSegments(message),
    });
  }

  for (let i = 0; i < recipients.length; i += PROMOTION_BATCH_SIZE) {
    await Promise.all(
      recipients.slice(i, i + PROMOTION_BATCH_SIZE).map((r) => deliver(r)),
    );
  }

  await supabase.from("sms_messages").insert(rows);

  revalidatePath("/sms");
  return { ok: true, sent, failed, firstError };
}

export async function deleteSmsMessage(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("sms_messages").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

// ---- Workflows -----------------------------------------------------------

export async function createSmsWorkflow(
  name: string,
): Promise<ActionResult<{ workflow: SmsWorkflow }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .from("sms_workflows")
    .insert({ name: name.trim() || "Untitled workflow" })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true, workflow: data as SmsWorkflow };
}

export async function renameSmsWorkflow(
  id: string,
  name: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("sms_workflows")
    .update({ name: name.trim() || "Untitled workflow" })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

export async function setSmsWorkflowActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("sms_workflows")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

export async function deleteSmsWorkflow(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Steps and runs cascade with the workflow.
  const { error } = await supabase.from("sms_workflows").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

export type WorkflowStepInput = {
  kind: SmsStepKind;
  message: string;
  wait_minutes: number;
};

/**
 * Replace a workflow's steps with the given ordered list. The builder edits
 * locally and saves the whole flow in one go (simple and conflict-free for
 * a single-workspace tool).
 */
export async function saveSmsWorkflowSteps(
  workflowId: string,
  steps: WorkflowStepInput[],
): Promise<ActionResult<{ steps: SmsWorkflowStep[] }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  for (const step of steps) {
    if (step.kind === "send_sms") {
      const message = step.message.trim();
      if (!message) return { ok: false, error: "Every SMS step needs a message." };
      if (message.length > SMS_MAX_LENGTH) {
        return {
          ok: false,
          error: `An SMS step is too long (${message.length}/${SMS_MAX_LENGTH} characters).`,
        };
      }
    } else if (!Number.isFinite(step.wait_minutes) || step.wait_minutes < 1) {
      return { ok: false, error: "Every wait step needs a delay of at least 1 minute." };
    }
  }

  const { error: deleteError } = await supabase
    .from("sms_workflow_steps")
    .delete()
    .eq("workflow_id", workflowId);
  if (deleteError) return { ok: false, error: deleteError.message };

  if (steps.length === 0) {
    revalidatePath("/sms");
    return { ok: true, steps: [] };
  }

  const { data, error } = await supabase
    .from("sms_workflow_steps")
    .insert(
      steps.map((step, position) => ({
        workflow_id: workflowId,
        position,
        kind: step.kind,
        message: step.kind === "send_sms" ? step.message.trim() : "",
        wait_minutes: step.kind === "wait" ? Math.floor(step.wait_minutes) : 0,
      })),
    )
    .select("*")
    .order("position", { ascending: true });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true, steps: (data ?? []) as SmsWorkflowStep[] };
}

// ---- Runs (enrollments) --------------------------------------------------

export type EnrollInput = {
  workflowId: string;
  clientId?: string | null;
  clientName: string;
  phone: string;
};

/**
 * Enroll a contact into a workflow and immediately execute its leading
 * send steps (until the first wait timer).
 */
export async function enrollInSmsWorkflow(
  input: EnrollInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, error: phone.error };

  const [{ data: workflow }, { count: stepCount }] = await Promise.all([
    supabase
      .from("sms_workflows")
      .select("id, is_active")
      .eq("id", input.workflowId)
      .single(),
    supabase
      .from("sms_workflow_steps")
      .select("id", { count: "exact", head: true })
      .eq("workflow_id", input.workflowId),
  ]);
  if (!workflow) return { ok: false, error: "Workflow not found." };
  if (!workflow.is_active) {
    return { ok: false, error: "Activate the workflow before enrolling contacts." };
  }
  if (!stepCount) {
    return { ok: false, error: "Add at least one step (and save) before enrolling." };
  }

  const { error } = await supabase.from("sms_workflow_runs").insert({
    workflow_id: input.workflowId,
    client_id: input.clientId || null,
    client_name: input.clientName.trim(),
    to_number: phone.value,
  });
  if (error) return { ok: false, error: error.message };

  // Fire the leading steps right away instead of waiting for the next tick.
  await processDueSmsRuns(supabase);

  revalidatePath("/sms");
  return { ok: true };
}

export async function cancelSmsRun(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("sms_workflow_runs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running");
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

export async function deleteSmsRun(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("sms_workflow_runs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/sms");
  return { ok: true };
}

/**
 * Process due automation timers. Called by the SMS page on an interval
 * while it's open; production deployments can also hit
 * /api/sms/automation/tick from a cron job.
 */
export async function tickSmsAutomation(): Promise<
  ActionResult<{ processed: number; sent: number }>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // No SMS provider, nothing to advance — same skip the cron route makes,
  // so an open SMS page doesn't run the queue scan every interval for a
  // feature that cannot send.
  if (!isSmsConfigured()) {
    return { ok: true, processed: 0, sent: 0 };
  }

  const result = await processDueSmsRuns(supabase);
  if (result.processed > 0) revalidatePath("/sms");
  return { ok: true, processed: result.processed, sent: result.sent };
}
