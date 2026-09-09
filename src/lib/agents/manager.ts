import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { openaiResponsesCancel } from "@/lib/ai/responses";
import { STORAGE_BUCKETS } from "@/lib/constants";
import type {
  CarouselSlide,
  Database,
  OfficeAgentKey,
  OfficeMissionMode,
  OfficeMissionOptions,
  OfficePlan,
} from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";
import { logSystemWrite } from "@/lib/system-audit";

import { emitOfficeEvent } from "./events";
import {
  MAX_REVISION_ROUNDS,
  canRequestRevision,
  defaultDeliverableFor,
  missionCost,
  missionProgress,
  validateManagerReview,
  validatePlan,
  validateQaVerdict,
  type OfficeOutputKind,
} from "./office-core";
import type { OfficeMissionRow, OfficeTaskRow } from "./office-types";
import { agentByKey, isAgentKey } from "./roster";

type DB = SupabaseClient<Database>;

/**
 * Missions: the Director's side of the office (0130).
 *
 * A mission is one goal. In `manager` mode the first task is the Director
 * planning; the plan becomes tasks with dependencies; QA verdicts can open
 * a bounded revision chain; when every leaf is done the Director reviews and
 * the mission lands in `review` for a person. In `direct` mode there is one
 * task, for one agent, and the mission is done when it is.
 *
 * Nothing here calls a model. The runtime (`runtime.ts`) does, and calls
 * back into `onTaskDone` / `onTaskFailed` as tasks settle.
 */

export type CreateMissionInput = {
  goal: string;
  mode: OfficeMissionMode;
  options: OfficeMissionOptions;
  clientId?: string | null;
  brandProfileId?: string | null;
  scheduleId?: string | null;
  createdBy: string | null;
  /** Direct mode: who gets the task. */
  agentKey?: OfficeAgentKey | null;
  title?: string;
};

export type CreateMissionResult =
  | { ok: true; mission: OfficeMissionRow; task: OfficeTaskRow }
  | { ok: false; error: string };

const clipTitle = (s: string, max = 80): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function agentName(key: string): string {
  return agentByKey(key)?.name ?? key;
}

export async function createMission(db: DB, input: CreateMissionInput): Promise<CreateMissionResult> {
  const goal = input.goal.trim();
  if (goal.length < 8) return { ok: false, error: "Say a little more about what you want made." };
  if (goal.length > 4_000) return { ok: false, error: "That brief is too long — keep it under 4,000 characters." };

  const direct = input.mode === "direct";
  const agentKey = direct ? input.agentKey : "manager";
  if (!agentKey || !isAgentKey(agentKey)) return { ok: false, error: "Pick an agent for a direct task." };
  const agent = agentByKey(agentKey)!;

  const options: OfficeMissionOptions = {
    platforms: input.options.platforms ?? [],
    postCount: input.options.postCount ?? undefined,
    dateFrom: input.options.dateFrom ?? null,
    dateTo: input.options.dateTo ?? null,
    autoPublish: Boolean(input.options.autoPublish),
    agentKey: direct ? agentKey : null,
    accountIds: input.options.accountIds ?? [],
  };

  const { data: mission, error } = await db
    .from("office_missions")
    .insert({
      title: clipTitle(input.title?.trim() || goal),
      goal,
      mode: input.mode,
      status: direct ? "running" : "planning",
      options,
      client_id: input.clientId ?? null,
      brand_profile_id: input.brandProfileId ?? null,
      schedule_id: input.scheduleId ?? null,
      created_by: input.createdBy,
      started_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !mission) return { ok: false, error: error?.message ?? "Could not open the mission." };

  const kind: OfficeOutputKind = direct ? defaultDeliverableFor(agentKey) : "plan";
  const { data: task, error: taskErr } = await db
    .from("office_tasks")
    .insert({
      mission_id: mission.id,
      key: direct ? "direct" : "plan",
      agent_key: agentKey,
      kind: direct ? "work" : "plan",
      title: direct ? clipTitle(goal, 100) : "Plan the brief",
      instructions: direct ? goal : "",
      status: "ready",
      input: { deliverable: kind },
    })
    .select("*")
    .single();
  if (taskErr || !task) {
    await db.from("office_missions").update({ status: "failed", error: taskErr?.message ?? "no task" }).eq("id", mission.id);
    return { ok: false, error: taskErr?.message ?? "Could not open the first task." };
  }

  await emitOfficeEvent(db, {
    missionId: mission.id,
    taskId: task.id,
    agentKey,
    kind: "handoff",
    message: direct
      ? `${agent.name} was handed a task: “${clipTitle(goal, 60)}”`
      : `${agent.name} received a brief: “${clipTitle(goal, 60)}”`,
    meta: { mode: input.mode, schedule_id: input.scheduleId ?? null },
  });
  await logSystemWrite(db, {
    job: "contentOffice",
    actor: input.createdBy ? `user:${input.createdBy}` : "system:contentOffice",
    table: "office_missions",
    rowId: mission.id,
    action: "created",
    summary: `Mission opened (${input.mode}): ${clipTitle(goal, 80)}`,
  });

  return { ok: true, mission, task };
}

/**
 * Turn the Director's plan into task rows. Ids are minted here so
 * `depends_on` can be written in one pass. Tasks with no dependencies start
 * `ready`; the rest wait as `queued`.
 */
export async function applyPlan(db: DB, mission: OfficeMissionRow, plan: OfficePlan, revision = false): Promise<void> {
  const ids = new Map(plan.tasks.map((t) => [t.key, randomUUID()] as const));
  // A revision plan may reuse a key from the first plan: suffix it.
  const suffix = revision ? `-r${mission.revision_round}` : "";
  const rows = plan.tasks.map((t) => ({
    id: ids.get(t.key)!,
    mission_id: mission.id,
    key: `${t.key}${suffix}`,
    agent_key: t.agent,
    kind: revision ? ("revise" as const) : ("work" as const),
    title: t.title,
    instructions: t.instructions,
    depends_on: t.depends_on.map((d) => ids.get(d)!).filter(Boolean),
    status: t.depends_on.length ? ("queued" as const) : ("ready" as const),
    input: { deliverable: t.deliverable },
    revision_round: revision ? mission.revision_round : 0,
  }));
  const { error } = await db.from("office_tasks").insert(rows);
  if (error) throw new Error(`Could not write the plan's tasks: ${error.message}`);

  await db
    .from("office_missions")
    .update({
      title: revision ? mission.title : clipTitle(plan.title || mission.title),
      plan: revision
        ? { ...(mission.plan as Record<string, unknown>), revisions: [...(((mission.plan as Record<string, unknown>).revisions as unknown[]) ?? []), plan] }
        : (plan as unknown as Record<string, unknown>),
      status: "running",
      started_at: mission.started_at ?? new Date().toISOString(),
    })
    .eq("id", mission.id);

  for (const t of plan.tasks) {
    await emitOfficeEvent(db, {
      missionId: mission.id,
      taskId: ids.get(t.key)!,
      agentKey: "manager",
      kind: "handoff",
      message: `Astra briefed ${agentName(t.agent)}: ${t.title}`,
      meta: { to: t.agent, deliverable: t.deliverable, depends_on: t.depends_on },
    });
  }
}

async function loadMission(db: DB, id: string): Promise<OfficeMissionRow | null> {
  const { data } = await db.from("office_missions").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

async function loadTasks(db: DB, missionId: string): Promise<OfficeTaskRow[]> {
  const { data } = await db.from("office_tasks").select("*").eq("mission_id", missionId).order("created_at");
  return data ?? [];
}

/** Sum the tasks' cost onto the mission. */
export async function refreshMissionCost(db: DB, missionId: string): Promise<void> {
  const { data } = await db.from("office_tasks").select("cost_usd").eq("mission_id", missionId);
  await db.from("office_missions").update({ cost_usd: missionCost(data ?? []) }).eq("id", missionId);
}

/** Remove a draft the office made (a revision replaces it). */
async function removeCarouselPost(db: DB, postId: string): Promise<void> {
  const { data: options } = await db.from("carousel_options").select("slides").eq("post_id", postId);
  const paths = (options ?? [])
    .flatMap((o) => (o.slides ?? []) as CarouselSlide[])
    .map((s) => s.image_path)
    .filter((p): p is string => Boolean(p));
  await db.from("carousel_posts").delete().eq("id", postId);
  if (paths.length) {
    try {
      await db.storage.from(STORAGE_BUCKETS.carouselSlides).remove(paths);
    } catch {
      // Orphaned files are cheap; a failed delete must not fail the revision.
    }
  }
}

/**
 * A QA task said "revise": open a writer → designer → qa chain for that
 * draft, carrying the fixes, and retire the old draft. Bounded by
 * MAX_REVISION_ROUNDS per mission.
 */
async function openRevisionChain(
  db: DB,
  mission: OfficeMissionRow,
  qaTask: OfficeTaskRow,
  tasks: OfficeTaskRow[],
  fixes: { target: string; instruction: string }[],
  notes: string,
): Promise<boolean> {
  if (!canRequestRevision(mission.revision_round)) return false;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // The draft QA looked at, and the copy that fed it.
  const designer = qaTask.depends_on.map((d) => byId.get(d)).find((t) => t?.agent_key === "designer");
  const writer = designer?.depends_on.map((d) => byId.get(d)).find((t) => t?.agent_key === "writer");
  if (!designer || !writer) return false;

  const round = mission.revision_round + 1;
  const writerId = randomUUID();
  const designerId = randomUUID();
  const qaId = randomUUID();
  const fixText = fixes.map((f, i) => `${i + 1}. [${f.target}] ${f.instruction}`).join("\n");
  const revisionNotes = `QA asked for these changes${notes ? ` (${notes})` : ""}:\n${fixText}`;

  const { error } = await db.from("office_tasks").insert([
    {
      id: writerId,
      mission_id: mission.id,
      key: `${writer.key}-r${round}`,
      agent_key: "writer",
      kind: "revise",
      title: `Revise copy — ${writer.title}`,
      instructions: `${writer.instructions}\n\n${revisionNotes}`,
      depends_on: writer.depends_on,
      status: "ready",
      input: { deliverable: "post_copy", revision_notes: revisionNotes, previous_output: writer.output },
      revision_of: writer.id,
      revision_round: round,
    },
    {
      id: designerId,
      mission_id: mission.id,
      key: `${designer.key}-r${round}`,
      agent_key: "designer",
      kind: "revise",
      title: `Re-draft — ${designer.title}`,
      instructions: designer.instructions,
      depends_on: [writerId],
      status: "queued",
      input: { deliverable: "carousel_draft", revision_notes: revisionNotes },
      revision_of: designer.id,
      revision_round: round,
    },
    {
      id: qaId,
      mission_id: mission.id,
      key: `${qaTask.key}-r${round}`,
      agent_key: "qa",
      kind: "revise",
      title: `Re-check — ${qaTask.title}`,
      instructions: qaTask.instructions,
      depends_on: [designerId],
      status: "queued",
      input: { deliverable: "qa_report", revision_notes: revisionNotes },
      revision_of: qaTask.id,
      revision_round: round,
    },
  ]);
  if (error) return false;

  // Retire the old draft so the calendar does not show two versions.
  const oldPostId = (designer.output as Record<string, unknown> | null)?.post_id;
  if (typeof oldPostId === "string" && oldPostId) await removeCarouselPost(db, oldPostId);

  // Anything that depended on the old QA now waits for the new one.
  for (const t of tasks) {
    if (t.status === "queued" && t.depends_on.includes(qaTask.id)) {
      const deps = t.depends_on.map((d) => (d === qaTask.id ? qaId : d));
      await db.from("office_tasks").update({ depends_on: deps }).eq("id", t.id);
    }
  }

  await db.from("office_missions").update({ revision_round: round }).eq("id", mission.id);
  await emitOfficeEvent(db, {
    missionId: mission.id,
    taskId: qaTask.id,
    agentKey: "qa",
    kind: "revision",
    message: `Audit sent “${writer.title}” back to Quill (round ${round})`,
    meta: { fixes: fixes.length, round },
  });
  return true;
}

/** Open the Director's review once every leaf is done. */
async function openReview(db: DB, mission: OfficeMissionRow): Promise<void> {
  const { data: existing } = await db
    .from("office_tasks")
    .select("id")
    .eq("mission_id", mission.id)
    .eq("kind", "review")
    .in("status", ["queued", "ready", "running"])
    .limit(1)
    .maybeSingle();
  if (existing) return;
  const { data: task } = await db
    .from("office_tasks")
    .insert({
      mission_id: mission.id,
      key: `review-${Date.now().toString(36)}`,
      agent_key: "manager",
      kind: "review",
      title: "Review the team's work",
      instructions: "Read every deliverable, weigh the QA reports, and decide.",
      status: "ready",
      input: { deliverable: "review" },
      revision_round: mission.revision_round,
    })
    .select("id")
    .single();
  await emitOfficeEvent(db, {
    missionId: mission.id,
    taskId: task?.id ?? null,
    agentKey: "manager",
    kind: "review",
    message: "Astra is reviewing the finished work",
  });
}

/** Land the mission with a person. */
async function finishForReview(db: DB, mission: OfficeMissionRow, summary: Record<string, unknown>): Promise<void> {
  await db
    .from("office_missions")
    .update({ status: "review", summary, finished_at: new Date().toISOString() })
    .eq("id", mission.id);
  await refreshMissionCost(db, mission.id);
  await emitOfficeEvent(db, {
    missionId: mission.id,
    agentKey: "manager",
    kind: "done",
    message: `Astra finished “${mission.title}” — waiting for your approval`,
  });
  if (mission.created_by) {
    await notifyUsers(db, {
      userIds: [mission.created_by],
      type: "approval",
      title: "Content plan ready for review",
      body: mission.title,
      link: `/content?mission=${mission.id}`,
    });
  }
}

/**
 * Called by the runtime when a task's output has been validated and stored.
 * Decides what the mission does next.
 */
export async function onTaskDone(db: DB, task: OfficeTaskRow): Promise<void> {
  const mission = await loadMission(db, task.mission_id);
  if (!mission || ["cancelled", "failed", "done"].includes(mission.status)) return;
  const output = (task.output ?? {}) as Record<string, unknown>;

  // Direct mode: one task, one answer.
  if (mission.mode === "direct") {
    await db
      .from("office_missions")
      .update({ status: "review", summary: { direct: true, deliverable: task.input.deliverable, output }, finished_at: new Date().toISOString() })
      .eq("id", mission.id);
    await refreshMissionCost(db, mission.id);
    await emitOfficeEvent(db, {
      missionId: mission.id,
      taskId: task.id,
      agentKey: task.agent_key,
      kind: "done",
      message: `${agentName(task.agent_key)} finished “${task.title}”`,
    });
    if (mission.created_by) {
      await notifyUsers(db, {
        userIds: [mission.created_by],
        type: "approval",
        title: `${agentName(task.agent_key)} finished a task`,
        body: task.title,
        link: `/content?mission=${mission.id}`,
      });
    }
    return;
  }

  // The Director planned (or re-planned): make the tasks.
  if (task.agent_key === "manager" && (task.kind === "plan" || (task.kind === "revise" && task.input.deliverable === "plan"))) {
    const checked = validatePlan(output, mission.options);
    if (!checked.ok) {
      await failMission(db, mission, `The plan could not be used: ${checked.error}`);
      return;
    }
    await applyPlan(db, mission, checked.value, task.kind === "revise");
    return;
  }

  // The Director reviewed.
  if (task.kind === "review") {
    const checked = validateManagerReview(output);
    const review = checked.ok
      ? checked.value
      : { decision: "approve" as const, summary: "Review could not be read; approving for a human look.", highlights: [], concerns: [], revision_instructions: null };
    if (review.decision === "revise" && review.revision_instructions && canRequestRevision(mission.revision_round)) {
      const round = mission.revision_round + 1;
      await db.from("office_missions").update({ revision_round: round, status: "running" }).eq("id", mission.id);
      await db.from("office_tasks").insert({
        mission_id: mission.id,
        key: `replan-r${round}`,
        agent_key: "manager",
        kind: "revise",
        title: "Plan the revisions",
        instructions: `Your review asked for changes. Plan ONLY the tasks needed to make them:\n${review.revision_instructions}`,
        status: "ready",
        input: { deliverable: "plan", revision_notes: review.revision_instructions },
        revision_round: round,
      });
      await emitOfficeEvent(db, {
        missionId: mission.id,
        agentKey: "manager",
        kind: "revision",
        message: `Astra asked for another pass (round ${round})`,
        meta: { concerns: review.concerns },
      });
      return;
    }
    await finishForReview(db, { ...mission, revision_round: mission.revision_round }, {
      ...review,
      decision: review.decision === "revise" ? "approve" : review.decision,
      note:
        review.decision === "revise"
          ? `Astra wanted a ${MAX_REVISION_ROUNDS + 1}th pass; the limit is ${MAX_REVISION_ROUNDS}, so this is with you as is.`
          : undefined,
    });
    return;
  }

  const tasks = await loadTasks(db, mission.id);

  // QA said revise → bounded revision chain.
  if (task.agent_key === "qa") {
    const verdict = validateQaVerdict(output);
    if (verdict.ok && verdict.value.verdict === "revise") {
      const opened = await openRevisionChain(db, mission, task, tasks, verdict.value.fixes, verdict.value.notes);
      if (opened) return;
      await emitOfficeEvent(db, {
        missionId: mission.id,
        taskId: task.id,
        agentKey: "qa",
        kind: "note",
        message: `Audit still has concerns, but the revision limit (${MAX_REVISION_ROUNDS}) is reached — flagged for you`,
        meta: { fixes: verdict.value.fixes },
      });
    }
  }

  await emitOfficeEvent(db, {
    missionId: mission.id,
    taskId: task.id,
    agentKey: task.agent_key,
    kind: "done",
    message: `${agentName(task.agent_key)} finished “${task.title}”`,
  });

  // Everything settled → the Director reviews.
  const fresh = await loadTasks(db, mission.id);
  const progress = missionProgress(fresh.filter((t) => t.kind !== "review"));
  const reviewOpen = fresh.some((t) => t.kind === "review" && ["queued", "ready", "running"].includes(t.status));
  if (progress.allDone && !reviewOpen) {
    await openReview(db, mission);
  }
}

async function failMission(db: DB, mission: OfficeMissionRow, error: string): Promise<void> {
  await db
    .from("office_missions")
    .update({ status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() })
    .eq("id", mission.id);
  await db
    .from("office_tasks")
    .update({ status: "cancelled" })
    .eq("mission_id", mission.id)
    .in("status", ["queued", "ready"]);
  await refreshMissionCost(db, mission.id);
  await emitOfficeEvent(db, {
    missionId: mission.id,
    agentKey: "manager",
    kind: "failed",
    message: `“${mission.title}” stopped: ${error.slice(0, 160)}`,
  });
}

/** Called by the runtime when a task is out of attempts. */
export async function onTaskFailed(db: DB, task: OfficeTaskRow, error: string): Promise<void> {
  const mission = await loadMission(db, task.mission_id);
  if (!mission || ["cancelled", "failed", "done"].includes(mission.status)) return;
  await failMission(db, mission, `${agentName(task.agent_key)} could not finish “${task.title}”: ${error}`);
}

/** Called by the runtime when the daily cap blocks a task. */
export async function onMissionBlocked(db: DB, missionId: string, reason: string): Promise<void> {
  await db.from("office_missions").update({ status: "paused", error: reason.slice(0, 500) }).eq("id", missionId);
}

export async function approveMission(db: DB, missionId: string, byUserId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const mission = await loadMission(db, missionId);
  if (!mission) return { ok: false, error: "That mission no longer exists." };
  if (!["review", "approved"].includes(mission.status)) return { ok: false, error: "That mission is not waiting for approval." };
  await db
    .from("office_missions")
    .update({ status: "done", finished_at: new Date().toISOString() })
    .eq("id", missionId);
  await emitOfficeEvent(db, {
    missionId,
    agentKey: "manager",
    kind: "done",
    message: `“${mission.title}” was approved`,
  });
  await logSystemWrite(db, {
    job: "contentOffice",
    actor: byUserId ? `user:${byUserId}` : null,
    table: "office_missions",
    rowId: missionId,
    action: "updated",
    summary: `Mission approved: ${mission.title}`,
  });
  return { ok: true };
}

export async function requestMissionRevision(
  db: DB,
  missionId: string,
  note: string,
  byUserId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mission = await loadMission(db, missionId);
  if (!mission) return { ok: false, error: "That mission no longer exists." };
  if (!["review", "paused", "failed"].includes(mission.status)) return { ok: false, error: "That mission is still running." };
  const clean = note.trim();
  if (clean.length < 4) return { ok: false, error: "Say what should change." };
  const round = mission.revision_round + 1;
  if (mission.mode === "direct") {
    const { data: first } = await db.from("office_tasks").select("*").eq("mission_id", missionId).order("created_at").limit(1).maybeSingle();
    if (!first) return { ok: false, error: "That mission has no task to revise." };
    await db.from("office_tasks").insert({
      mission_id: missionId,
      key: `direct-r${round}`,
      agent_key: first.agent_key,
      kind: "revise",
      title: `Revise — ${first.title}`,
      instructions: `${first.instructions}\n\nThe owner asked for these changes:\n${clean}`,
      status: "ready",
      input: { deliverable: first.input.deliverable, revision_notes: clean, previous_output: first.output },
      revision_of: first.id,
      revision_round: round,
    });
  } else {
    await db.from("office_tasks").insert({
      mission_id: missionId,
      key: `replan-r${round}`,
      agent_key: "manager",
      kind: "revise",
      title: "Plan the owner's changes",
      instructions: `The owner reviewed the work and asked for changes. Plan ONLY the tasks needed to make them:\n${clean}`,
      status: "ready",
      input: { deliverable: "plan", revision_notes: clean },
      revision_round: round,
    });
  }
  await db
    .from("office_missions")
    .update({ status: "running", revision_round: round, error: null, finished_at: null })
    .eq("id", missionId);
  await emitOfficeEvent(db, {
    missionId,
    agentKey: "manager",
    kind: "revision",
    message: `You asked for changes (round ${round}): ${clipTitle(clean, 80)}`,
    meta: { by: byUserId },
  });
  return { ok: true };
}

export async function cancelMission(db: DB, missionId: string, byUserId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const mission = await loadMission(db, missionId);
  if (!mission) return { ok: false, error: "That mission no longer exists." };
  if (["done", "cancelled"].includes(mission.status)) return { ok: false, error: "That mission is already closed." };
  const tasks = await loadTasks(db, missionId);
  for (const t of tasks) {
    if (t.status === "running" && t.openai_response_id) await openaiResponsesCancel(t.openai_response_id);
  }
  await db
    .from("office_tasks")
    .update({ status: "cancelled", lease_until: null })
    .eq("mission_id", missionId)
    .in("status", ["queued", "ready", "running", "blocked"]);
  await db
    .from("office_missions")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", missionId);
  await refreshMissionCost(db, missionId);
  await emitOfficeEvent(db, {
    missionId,
    agentKey: "manager",
    kind: "failed",
    message: `“${mission.title}” was cancelled`,
    meta: { by: byUserId },
  });
  return { ok: true };
}

/** Put a failed or blocked task back on the floor. */
export async function retryTask(db: DB, taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: task } = await db.from("office_tasks").select("*").eq("id", taskId).maybeSingle();
  if (!task) return { ok: false, error: "That task no longer exists." };
  if (!["failed", "blocked", "cancelled"].includes(task.status)) return { ok: false, error: "That task is not stopped." };
  await db
    .from("office_tasks")
    .update({
      status: "ready",
      attempts: 0,
      killed: 0,
      rounds: 0,
      openai_response_id: null,
      pending_create_at: null,
      lease_until: null,
      run_after: null,
      error: null,
      phase: "",
      step: "",
    })
    .eq("id", taskId);
  await db
    .from("office_missions")
    .update({ status: "running", error: null, finished_at: null })
    .eq("id", task.mission_id)
    .in("status", ["failed", "paused"]);
  await emitOfficeEvent(db, {
    missionId: task.mission_id,
    taskId,
    agentKey: task.agent_key,
    kind: "note",
    message: `${agentName(task.agent_key)} is retrying “${task.title}”`,
  });
  return { ok: true };
}
