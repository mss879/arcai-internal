"use server";

import { revalidatePath } from "next/cache";

import { colomboDay } from "@/lib/ai-projects/time-core";
import { selectableModels } from "@/lib/ai-projects/pricing-core";
import { loadPriceCatalog } from "@/lib/ai-projects/usage";
import { assertAdmin, assertCapability } from "@/lib/auth";
import type { OfficeAgentKey, OfficeCadence, OfficeMissionMode, OfficeMissionOptions, SocialPlatform } from "@/lib/database.types";
import {
  approveMission as approveMissionCore,
  cancelMission as cancelMissionCore,
  createMission,
  requestMissionRevision as requestRevisionCore,
  retryTask as retryTaskCore,
} from "@/lib/agents/manager";
import { nextRunAt } from "@/lib/agents/office-core";
import type { OfficeDelta, OfficeSnapshot } from "@/lib/agents/office-types";
import { agentByKey, isAgentKey, isOfficeEffort } from "@/lib/agents/roster";
import { runOfficeStep } from "@/lib/agents/runtime";
import { loadOfficeDelta, loadOfficeSnapshot } from "@/lib/agents/snapshot";
import { logSystemWrite } from "@/lib/system-audit";
import { queueSocialPost } from "@/lib/social/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult, Profile } from "@/lib/types";

/**
 * The Content Office's server actions (0130).
 *
 * Every write goes through the service-role client AFTER the capability
 * check, because the run tables have no write policy for the anon key: a
 * task row is a paid model call and the anon key ships to the browser.
 * Anything that changes cost or can publish (agent models, schedules with
 * auto-publish, the daily cap, brand profiles) is admin-only.
 */

/**
 * Directing the office — briefing, assigning, approving, scheduling,
 * retrying, cancelling — is ADMIN ONLY (0132).
 *
 * A member with the marketing capability can open the office, walk the
 * floor, read every mission, deliverable and event, and watch the team
 * work. They cannot put the agents to work: every one of those doors spends
 * real money on model calls, and two of them (approve & schedule,
 * auto-publish) reach the outside world. The capability check runs first so
 * a member without marketing still gets the capability's own message.
 */
async function assertDirector(): Promise<{ ok: true; profile: Profile } | { ok: false; error: string }> {
  const gate = await assertCapability("marketing");
  if (!gate.ok) return gate;
  if (gate.profile.role !== "admin") {
    return { ok: false, error: "The Content Office is view-only for your account. Ask an admin to brief the team." };
  }
  return gate;
}

const PLATFORMS: readonly SocialPlatform[] = ["instagram", "facebook"];
const CADENCES: readonly OfficeCadence[] = ["daily", "weekly", "monthly", "every_n_days"];

function cleanOptions(raw: OfficeMissionOptions | undefined, isAdmin: boolean): OfficeMissionOptions {
  const o = raw ?? {};
  const platforms = (o.platforms ?? []).filter((p): p is SocialPlatform => (PLATFORMS as readonly string[]).includes(p));
  const postCount = Number(o.postCount);
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    platforms,
    postCount: Number.isFinite(postCount) && postCount >= 1 ? Math.min(6, Math.floor(postCount)) : undefined,
    dateFrom: day(o.dateFrom),
    dateTo: day(o.dateTo),
    // Only an admin may let the office publish on its own.
    autoPublish: isAdmin && Boolean(o.autoPublish),
    accountIds: (o.accountIds ?? []).filter((a) => typeof a === "string").slice(0, 10),
  };
}

// ---- Briefs and tasks ------------------------------------------------------------

export async function briefManager(input: {
  goal: string;
  options?: OfficeMissionOptions;
  clientId?: string | null;
  brandProfileId?: string | null;
}): Promise<ActionResult<{ missionId: string }>> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const res = await createMission(db, {
    goal: input.goal,
    mode: "manager",
    options: cleanOptions(input.options, gate.profile.role === "admin"),
    clientId: input.clientId ?? null,
    brandProfileId: input.brandProfileId ?? null,
    createdBy: gate.profile.id,
  });
  if (!res.ok) return res;
  // Get the Director thinking before the page even re-renders.
  await runOfficeStep(db, { budgetMs: 8_000, maxPolls: 0, maxStarts: 1 }).catch(() => null);
  revalidatePath("/content");
  return { ok: true, missionId: res.mission.id };
}

export async function assignAgentTask(input: {
  agentKey: string;
  instructions: string;
  options?: OfficeMissionOptions;
  clientId?: string | null;
  brandProfileId?: string | null;
}): Promise<ActionResult<{ missionId: string }>> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  if (!isAgentKey(input.agentKey)) return { ok: false, error: "Pick one of the agents." };
  const db = createAdminClient();
  const res = await createMission(db, {
    goal: input.instructions,
    mode: "direct",
    options: cleanOptions(input.options, gate.profile.role === "admin"),
    clientId: input.clientId ?? null,
    brandProfileId: input.brandProfileId ?? null,
    createdBy: gate.profile.id,
    agentKey: input.agentKey,
  });
  if (!res.ok) return res;
  await runOfficeStep(db, { budgetMs: 8_000, maxPolls: 0, maxStarts: 1 }).catch(() => null);
  revalidatePath("/content");
  return { ok: true, missionId: res.mission.id };
}

/**
 * The open page's heartbeat: advance the office by one bounded step and
 * return what changed. Never throws — a poll that fails is just skipped.
 */
export async function driveOffice(input: { sinceEventId: number }): Promise<ActionResult<{ delta: OfficeDelta }>> {
  const gate = await assertCapability("marketing");
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const canDrive = gate.profile.role === "admin";
  try {
    // A member's open page reads; it never starts a paid model call. The
    // five-minute tick (and any admin with the page open) drives the work.
    const stepped = canDrive
      ? await runOfficeStep(db, { budgetMs: 10_000 })
      : { polled: 0, started: 0, advanced: 0, failed: 0, busy: 0 };
    const delta = await loadOfficeDelta(db, Math.max(0, Math.floor(input.sinceEventId) || 0), {
      polled: stepped.polled,
      started: stepped.started,
      advanced: stepped.advanced,
      failed: stepped.failed,
      busy: stepped.busy,
    });
    return { ok: true, delta };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function loadOfficeSnapshotAction(missionId?: string | null): Promise<ActionResult<{ snapshot: OfficeSnapshot }>> {
  const gate = await assertCapability("marketing");
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const snapshot = await loadOfficeSnapshot(db, {
    isAdmin: gate.profile.role === "admin",
    missionId: missionId ?? null,
    dryRun: process.env.SOCIAL_DRY_RUN === "1",
  });
  return { ok: true, snapshot };
}

export async function getTaskTranscript(taskId: string): Promise<ActionResult<{ items: unknown[]; responses: unknown[] }>> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const { data } = await db.from("office_task_transcripts").select("items, responses").eq("task_id", taskId).maybeSingle();
  return { ok: true, items: data?.items ?? [], responses: data?.responses ?? [] };
}

// ---- Deciding ----------------------------------------------------------------------

export async function approveMissionOutput(missionId: string): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const res = await approveMissionCore(createAdminClient(), missionId, gate.profile.id);
  if (!res.ok) return res;
  revalidatePath("/content");
  revalidatePath("/approvals");
  return { ok: true };
}

export async function requestMissionRevision(missionId: string, note: string): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const res = await requestRevisionCore(db, missionId, note, gate.profile.id);
  if (!res.ok) return res;
  await runOfficeStep(db, { budgetMs: 8_000, maxPolls: 0, maxStarts: 1 }).catch(() => null);
  revalidatePath("/content");
  return { ok: true };
}

export async function cancelMission(missionId: string): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const res = await cancelMissionCore(createAdminClient(), missionId, gate.profile.id);
  if (!res.ok) return res;
  revalidatePath("/content");
  return { ok: true };
}

export async function retryTask(taskId: string): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const res = await retryTaskCore(createAdminClient(), taskId);
  if (!res.ok) return res;
  revalidatePath("/content");
  return { ok: true };
}

/**
 * "Approve & schedule": the human's door onto the publish queue. Each item
 * goes through `queueSocialPost`, which still insists on a chosen design,
 * rendered slides, an approved client and connected accounts.
 */
export async function scheduleFromProposal(
  missionId: string,
  items: { carouselPostId: string; accountIds: string[]; scheduledFor: string }[],
): Promise<ActionResult<{ queued: number; problems: string[] }>> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  if (!items.length) return { ok: false, error: "Nothing to schedule." };
  const db = createAdminClient();
  const { data: posts } = await db.from("carousel_posts").select("id, topic").eq("mission_id", missionId);
  const allowed = new Set((posts ?? []).map((p) => p.id));
  let queued = 0;
  const problems: string[] = [];
  for (const item of items.slice(0, 12)) {
    if (!allowed.has(item.carouselPostId)) {
      problems.push("A post in the list is not part of this mission.");
      continue;
    }
    const res = await queueSocialPost(db, {
      postId: item.carouselPostId,
      accountIds: item.accountIds,
      scheduledFor: item.scheduledFor,
      createdBy: gate.profile.id,
    });
    if (res.ok) queued += res.queued;
    else problems.push(`${(posts ?? []).find((p) => p.id === item.carouselPostId)?.topic ?? "Post"}: ${res.error}`);
  }
  if (queued) {
    await logSystemWrite(db, {
      job: "contentOffice",
      actor: `user:${gate.profile.id}`,
      table: "social_posts",
      rowId: missionId,
      action: "created",
      summary: `${queued} post(s) scheduled from the office's proposal`,
    });
  }
  revalidatePath("/content");
  return { ok: true, queued, problems };
}

// ---- Admin: agents, brand, budget -----------------------------------------------

export async function pauseAgent(key: string, paused: boolean): Promise<ActionResult> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  if (!isAgentKey(key)) return { ok: false, error: "No such agent." };
  const def = agentByKey(key)!;
  const db = createAdminClient();
  // Update the seeded row; only insert when the seed is somehow missing —
  // an upsert here would overwrite the agent's chosen name with its key.
  const { data, error } = await db
    .from("office_agents")
    .update({ enabled: !paused, updated_by: gate.profile.id })
    .eq("key", key)
    .select("key");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) {
    const { error: insErr } = await db
      .from("office_agents")
      .insert({ key, name: def.name, title: def.title, enabled: !paused, updated_by: gate.profile.id });
    if (insErr) return { ok: false, error: insErr.message };
  }
  revalidatePath("/content");
  return { ok: true };
}

export type AgentSettingsInput = {
  name: string;
  title: string;
  model: string | null;
  reasoningEffort: string | null;
  instructions: string;
  color: string | null;
  enabled: boolean;
};

export async function saveAgentSettings(key: string, input: AgentSettingsInput): Promise<ActionResult> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  if (!isAgentKey(key)) return { ok: false, error: "No such agent." };
  const db = createAdminClient();

  const model = input.model?.trim() || null;
  if (model) {
    const catalog = await loadPriceCatalog(db);
    const allowed = selectableModels(catalog, colomboDay()).map((m) => m.model);
    if (!allowed.includes(model)) {
      return { ok: false, error: `${model} is not in the model catalog. Add its price under AI Projects → Models first.` };
    }
  }
  const effort = input.reasoningEffort?.trim() || null;
  if (effort && !isOfficeEffort(effort)) return { ok: false, error: "Pick a reasoning effort from the list." };
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: "Give the agent a name." };
  const color = input.color?.trim() || null;
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) return { ok: false, error: "Colour must be a hex value like #f97316." };

  const { error } = await db.from("office_agents").upsert(
    {
      key: key as OfficeAgentKey,
      name,
      title: input.title.trim().slice(0, 60),
      model,
      reasoning_effort: effort,
      instructions: input.instructions.trim().slice(0, 4_000),
      color,
      enabled: input.enabled,
      updated_by: gate.profile.id,
    },
    { onConflict: "key" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}

export type BrandProfileInput = {
  id?: string | null;
  clientId: string | null;
  name: string;
  persona: string;
  tone: string[];
  dos: string[];
  donts: string[];
  pillars: string[];
  audience: string;
  bannedWords: string[];
  hashtagSets: { name: string; tags: string[] }[];
  notes: string;
};

export async function saveBrandProfile(input: BrandProfileInput): Promise<ActionResult<{ id: string }>> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: "Give the profile a name." };
  const clean = (arr: string[], max: number, len = 120) =>
    (arr ?? []).map((s) => String(s).trim().slice(0, len)).filter(Boolean).slice(0, max);
  const row = {
    client_id: input.clientId || null,
    name,
    voice: {
      persona: input.persona.trim().slice(0, 600),
      tone: clean(input.tone, 12, 40),
      do: clean(input.dos, 12, 200),
      dont: clean(input.donts, 12, 200),
    },
    pillars: clean(input.pillars, 12, 80),
    audience: input.audience.trim().slice(0, 600),
    banned_words: clean(input.bannedWords, 60, 40),
    hashtag_sets: (input.hashtagSets ?? [])
      .map((h) => ({ name: String(h.name ?? "").trim().slice(0, 40), tags: clean(h.tags ?? [], 30, 40) }))
      .filter((h) => h.name && h.tags.length)
      .slice(0, 10),
    notes: input.notes.trim().slice(0, 2_000),
  };
  if (input.id) {
    const { error } = await db.from("office_brand_profiles").update(row).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/content");
    return { ok: true, id: input.id };
  }
  const { data, error } = await db.from("office_brand_profiles").insert(row).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save." };
  revalidatePath("/content");
  return { ok: true, id: data.id };
}

export async function deleteBrandProfile(id: string): Promise<ActionResult> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const { data } = await db.from("office_brand_profiles").select("is_default").eq("id", id).maybeSingle();
  if (data?.is_default) return { ok: false, error: "The house brand profile cannot be deleted — edit it instead." };
  const { error } = await db.from("office_brand_profiles").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}

export async function saveOfficeSettings(input: { dailyCapUsd: number }): Promise<ActionResult> {
  const gate = await assertAdmin();
  if (!gate.ok) return gate;
  const cap = Number(input.dailyCapUsd);
  if (!Number.isFinite(cap) || cap < 0 || cap > 10_000) return { ok: false, error: "The daily cap must be between 0 and 10,000 USD." };
  const db = createAdminClient();
  const { error } = await db
    .from("app_settings")
    .upsert({ key: "content_office", value: { daily_cap_usd: cap }, updated_at: new Date().toISOString() });
  if (error) return { ok: false, error: error.message };
  await logSystemWrite(db, {
    job: "contentOffice",
    actor: `user:${gate.profile.id}`,
    table: "app_settings",
    rowId: "content_office",
    action: "updated",
    summary: `Content Office daily cap set to $${cap}`,
  });
  revalidatePath("/content");
  return { ok: true };
}

// ---- Schedules -------------------------------------------------------------------------

export type ScheduleInput = {
  name: string;
  goal: string;
  mode: OfficeMissionMode;
  agentKey: string | null;
  cadence: OfficeCadence;
  everyN: number | null;
  runTime: string;
  weekdays: number[];
  dayOfMonth: number | null;
  timezone: string;
  options: OfficeMissionOptions;
  clientId: string | null;
  brandProfileId: string | null;
  isActive: boolean;
};

function checkSchedule(input: ScheduleInput, isAdmin: boolean) {
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false as const, error: "Give the timer a name." };
  const goal = input.goal.trim();
  if (goal.length < 8) return { ok: false as const, error: "Say what the timer should ask for." };
  if (!CADENCES.includes(input.cadence)) return { ok: false as const, error: "Pick a cadence." };
  if (input.mode === "direct" && (!input.agentKey || !isAgentKey(input.agentKey))) {
    return { ok: false as const, error: "A direct timer needs an agent." };
  }
  if (!/^\d{2}:\d{2}$/.test(input.runTime)) return { ok: false as const, error: "Run time must be HH:MM." };
  const options = cleanOptions(input.options, isAdmin);
  if (input.options?.autoPublish && !isAdmin) return { ok: false as const, error: "Only an admin can turn auto-publish on." };
  return {
    ok: true as const,
    row: {
      name,
      goal,
      mode: input.mode,
      agent_key: input.mode === "direct" ? (input.agentKey as OfficeAgentKey) : null,
      cadence: input.cadence,
      every_n: input.cadence === "every_n_days" ? Math.max(1, Math.min(60, Math.floor(Number(input.everyN) || 2))) : null,
      run_time: input.runTime,
      weekdays: (input.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
      day_of_month: input.cadence === "monthly" ? Math.max(1, Math.min(31, Math.floor(Number(input.dayOfMonth) || 1))) : null,
      timezone: input.timezone?.trim() || "Asia/Colombo",
      options,
      client_id: input.clientId || null,
      brand_profile_id: input.brandProfileId || null,
      is_active: input.isActive,
    },
  };
}

export async function createSchedule(input: ScheduleInput): Promise<ActionResult<{ id: string }>> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const checked = checkSchedule(input, true);
  if (!checked.ok) return checked;
  const db = createAdminClient();
  const nowIso = new Date().toISOString();
  const next = checked.row.is_active ? nextRunAt({ ...checked.row, last_run_at: null }, nowIso) : null;
  const { data, error } = await db
    .from("office_schedules")
    .insert({ ...checked.row, next_run_at: next, created_by: gate.profile.id })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the timer." };
  revalidatePath("/content");
  return { ok: true, id: data.id };
}

export async function updateSchedule(id: string, input: ScheduleInput): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const checked = checkSchedule(input, true);
  if (!checked.ok) return checked;
  const db = createAdminClient();
  const { data: existing } = await db.from("office_schedules").select("last_run_at, options").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "That timer no longer exists." };
  const nowIso = new Date().toISOString();
  const next = checked.row.is_active ? nextRunAt({ ...checked.row, last_run_at: existing.last_run_at }, nowIso) : null;
  const { error } = await db.from("office_schedules").update({ ...checked.row, next_run_at: next }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}

export async function toggleSchedule(id: string, active: boolean): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const { data: sched } = await db.from("office_schedules").select("*").eq("id", id).maybeSingle();
  if (!sched) return { ok: false, error: "That timer no longer exists." };
  const next = active ? nextRunAt(sched, new Date().toISOString()) : null;
  const { error } = await db.from("office_schedules").update({ is_active: active, next_run_at: next }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}

export async function deleteSchedule(id: string): Promise<ActionResult> {
  const gate = await assertDirector();
  if (!gate.ok) return gate;
  const db = createAdminClient();
  const { error } = await db.from("office_schedules").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}
