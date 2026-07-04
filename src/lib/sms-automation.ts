import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendSms } from "@/lib/sms";
import { countSmsSegments, personalizeMessage } from "@/lib/sms-utils";

type Client = SupabaseClient<Database>;
type Run = Database["public"]["Tables"]["sms_workflow_runs"]["Row"];
type Step = Database["public"]["Tables"]["sms_workflow_steps"]["Row"];

/** How many due runs a single tick will process. */
const MAX_RUNS_PER_TICK = 25;

export type TickResult = {
  processed: number;
  sent: number;
  failed: number;
};

/**
 * Advance every due workflow run: execute send steps until the run hits a
 * wait step (which pushes `next_run_at` forward) or finishes. Called from
 * the SMS page while it's open and from the /api/sms/automation/tick cron
 * route, so timers fire without any extra infrastructure.
 */
export async function processDueSmsRuns(supabase: Client): Promise<TickResult> {
  const result: TickResult = { processed: 0, sent: 0, failed: 0 };

  const { data: dueRuns } = await supabase
    .from("sms_workflow_runs")
    .select("*")
    .eq("status", "running")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_RUNS_PER_TICK);

  if (!dueRuns || dueRuns.length === 0) return result;

  const workflowIds = Array.from(new Set(dueRuns.map((r) => r.workflow_id)));
  const [{ data: workflows }, { data: allSteps }] = await Promise.all([
    supabase.from("sms_workflows").select("id, is_active").in("id", workflowIds),
    supabase
      .from("sms_workflow_steps")
      .select("*")
      .in("workflow_id", workflowIds)
      .order("position", { ascending: true }),
  ]);

  const activeIds = new Set(
    (workflows ?? []).filter((w) => w.is_active).map((w) => w.id),
  );
  const stepsByWorkflow = new Map<string, Step[]>();
  for (const step of allSteps ?? []) {
    const list = stepsByWorkflow.get(step.workflow_id) ?? [];
    list.push(step);
    stepsByWorkflow.set(step.workflow_id, list);
  }

  for (const run of dueRuns) {
    // Paused workflows keep their runs frozen until reactivated.
    if (!activeIds.has(run.workflow_id)) continue;
    result.processed++;
    await advanceRun(supabase, run, stepsByWorkflow.get(run.workflow_id) ?? [], result);
  }

  return result;
}

async function advanceRun(
  supabase: Client,
  run: Run,
  steps: Step[],
  result: TickResult,
): Promise<void> {
  let index = run.step_index;

  // Hard cap so a mis-built workflow can never loop forever.
  for (let guard = 0; guard < 50; guard++) {
    if (index >= steps.length) {
      await supabase
        .from("sms_workflow_runs")
        .update({
          step_index: index,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      return;
    }

    const step = steps[index];

    if (step.kind === "wait") {
      const nextRunAt = new Date(
        Date.now() + Math.max(0, step.wait_minutes) * 60_000,
      ).toISOString();
      await supabase
        .from("sms_workflow_runs")
        .update({ step_index: index + 1, next_run_at: nextRunAt })
        .eq("id", run.id);
      return;
    }

    // send_sms
    const message = personalizeMessage(step.message, run.client_name).trim();
    const sendResult = message
      ? await sendSms({
          to: run.to_number,
          message,
          contactName: run.client_name || undefined,
        })
      : ({ ok: false, error: "Step has no message." } as const);

    await supabase.from("sms_messages").insert({
      to_number: run.to_number,
      message: message || step.message,
      client_id: run.client_id,
      client_name: run.client_name,
      kind: "automation",
      status: sendResult.ok ? "sent" : "failed",
      error: sendResult.ok ? null : sendResult.error,
      workflow_id: run.workflow_id,
      segments: countSmsSegments(message),
      created_by: run.created_by,
    });

    if (!sendResult.ok) {
      result.failed++;
      await supabase
        .from("sms_workflow_runs")
        .update({ step_index: index, status: "failed", error: sendResult.error })
        .eq("id", run.id);
      return;
    }

    result.sent++;
    index++;
    await supabase
      .from("sms_workflow_runs")
      .update({ step_index: index })
      .eq("id", run.id);
  }
}
