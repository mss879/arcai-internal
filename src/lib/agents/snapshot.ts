import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { colomboDay } from "@/lib/ai-projects/time-core";
import type { CarouselSlide, Database } from "@/lib/database.types";
import { listActiveSocialAccounts } from "@/lib/social/queue";
import { isSocialCryptoConfigured } from "@/lib/social/crypto";

import type { OfficeCarouselLite, OfficeDelta, OfficeSnapshot, OfficeSpend } from "./office-types";
import { dailyOfficeSpend, loadOfficeSettings, loadRoster, monthlyOfficeSpend } from "./runtime";

type DB = SupabaseClient<Database>;

/**
 * Everything the Office view needs, in one object (0130).
 *
 * Every query is tolerant: on a database without 0130 the floor still
 * renders (robots idle at their desks) with `ready: false`, and every other
 * Content tab is untouched.
 */

const MISSIONS_LIMIT = 20;
const EVENTS_LIMIT = 150;
const ACTIVE_WINDOW_MS = 48 * 60 * 60_000;

async function safe<T>(run: () => PromiseLike<{ data: T | null }>, fallback: T): Promise<T> {
  try {
    const { data } = await run();
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadCarousels(db: DB, missionIds: string[]): Promise<OfficeCarouselLite[]> {
  if (!missionIds.length) return [];
  const posts = await safe(
    () =>
      db
        .from("carousel_posts")
        .select("id, mission_id, office_task_id, topic, status, scheduled_for, caption, hashtags, chosen_option_id, client_status")
        .in("mission_id", missionIds)
        .order("scheduled_for", { ascending: true })
        .limit(60),
    [] as {
      id: string;
      mission_id: string | null;
      office_task_id: string | null;
      topic: string;
      status: string;
      scheduled_for: string;
      caption: string;
      hashtags: string[];
      chosen_option_id: string | null;
      client_status: string;
    }[],
  );
  if (!posts.length) return [];
  const options = await safe(
    () =>
      db
        .from("carousel_options")
        .select("post_id, slides")
        .in(
          "post_id",
          posts.map((p) => p.id),
        ),
    [] as { post_id: string; slides: CarouselSlide[] }[],
  );
  const counts = new Map<string, { rendered: number; total: number }>();
  for (const o of options) {
    const slides = (o.slides ?? []) as CarouselSlide[];
    const c = counts.get(o.post_id) ?? { rendered: 0, total: 0 };
    c.rendered += slides.filter((s) => s.image_url).length;
    c.total += slides.length;
    counts.set(o.post_id, c);
  }
  return posts.map((p) => ({
    ...p,
    hashtags: p.hashtags ?? [],
    rendered: counts.get(p.id)?.rendered ?? 0,
    total: counts.get(p.id)?.total ?? 0,
  }));
}

async function loadSpend(db: DB): Promise<OfficeSpend> {
  const day = colomboDay();
  const [todayUsd, monthUsd, settings] = await Promise.all([
    dailyOfficeSpend(db, day),
    monthlyOfficeSpend(db, day),
    loadOfficeSettings(db),
  ]);
  return { todayUsd, monthUsd, capUsd: settings.dailyCapUsd };
}

export async function loadOfficeSnapshot(
  db: DB,
  opts: { isAdmin: boolean; missionId?: string | null; dryRun: boolean },
): Promise<OfficeSnapshot> {
  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();

  // `ready` is decided by the one table every other query needs.
  const probe = await db.from("office_missions").select("id").limit(1).then((r) => r, () => ({ data: null, error: { message: "missing" } }));
  const ready = !("error" in probe && probe.error);

  const [agents, missions, schedules, brandProfiles, spend, accounts, clients] = await Promise.all([
    loadRoster(db),
    safe(
      () => db.from("office_missions").select("*").order("created_at", { ascending: false }).limit(MISSIONS_LIMIT),
      [] as OfficeSnapshot["missions"],
    ),
    safe(() => db.from("office_schedules").select("*").order("created_at", { ascending: false }).limit(50), [] as OfficeSnapshot["schedules"]),
    safe(() => db.from("office_brand_profiles").select("*").order("is_default", { ascending: false }).order("name"), [] as OfficeSnapshot["brandProfiles"]),
    loadSpend(db),
    listActiveSocialAccounts(db),
    safe(() => db.from("clients").select("id, name").order("name").limit(500), [] as { id: string; name: string }[]),
  ]);

  // The opened mission is always included, even if it fell off the list.
  if (opts.missionId && !missions.some((m) => m.id === opts.missionId)) {
    const extra = await safe(() => db.from("office_missions").select("*").eq("id", opts.missionId!).limit(1), [] as OfficeSnapshot["missions"]);
    missions.push(...extra);
  }

  const activeMissionIds = missions
    .filter((m) => ["planning", "running", "review", "paused"].includes(m.status) || m.updated_at >= activeSince || m.id === opts.missionId)
    .map((m) => m.id);

  const [tasks, events, carousels] = await Promise.all([
    activeMissionIds.length
      ? safe(() => db.from("office_tasks").select("*").in("mission_id", activeMissionIds).order("created_at"), [] as OfficeSnapshot["tasks"])
      : Promise.resolve([] as OfficeSnapshot["tasks"]),
    safe(() => db.from("office_events").select("*").order("id", { ascending: false }).limit(EVENTS_LIMIT), [] as OfficeSnapshot["events"]),
    loadCarousels(db, activeMissionIds),
  ]);
  events.reverse();

  return {
    ready,
    isAdmin: opts.isAdmin,
    agents,
    missions,
    tasks,
    events,
    schedules,
    brandProfiles,
    carousels,
    spend,
    social: {
      accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, clientId: a.clientId })),
      dryRun: opts.dryRun,
      tokenKeySet: isSocialCryptoConfigured(),
    },
    clients,
    lastEventId: events.length ? Math.max(...events.map((e) => e.id)) : 0,
    loadedAt: new Date().toISOString(),
  };
}

/** What changed since the page last asked. */
export async function loadOfficeDelta(
  db: DB,
  sinceEventId: number,
  stepped: OfficeDelta["stepped"],
): Promise<OfficeDelta> {
  const recent = new Date(Date.now() - 90_000).toISOString();
  const [events, tasks, missions] = await Promise.all([
    safe(() => db.from("office_events").select("*").gt("id", sinceEventId).order("id", { ascending: true }).limit(200), [] as OfficeDelta["events"]),
    safe(() => db.from("office_tasks").select("*").gte("updated_at", recent).order("updated_at"), [] as OfficeDelta["tasks"]),
    safe(() => db.from("office_missions").select("*").gte("updated_at", recent).order("updated_at"), [] as OfficeDelta["missions"]),
  ]);
  const missionIds = [...new Set([...tasks.map((t) => t.mission_id), ...missions.map((m) => m.id)])];
  const [carousels, spend] = await Promise.all([loadCarousels(db, missionIds), loadSpend(db)]);
  return {
    events,
    tasks,
    missions,
    carousels,
    spend,
    lastEventId: events.length ? Math.max(sinceEventId, ...events.map((e) => e.id)) : sinceEventId,
    stepped,
  };
}
