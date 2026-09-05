import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { targetsProgress, type TargetProgress } from "@/lib/targets";

type DB = SupabaseClient<Database>;

/**
 * One person's month on one card (0119).
 *
 * The team page had money and devices; what somebody actually DID in a month
 * — the hours, the tasks, the deals, how fast they picked up a hand-off —
 * lived in five screens. This is that, for one member and one month, built
 * from the same sources the rest of the app reads so no figure here can
 * disagree with the page it came from:
 *
 *   targets   → targetsProgress()      (the Team page and the dashboard tile)
 *   revenue   → inside targetsProgress (monthlyInflows, the one "money in")
 *   hours     → time_entries
 *   to-dos    → todos, by assignee
 *   deals     → leads.won_at, by assignee
 *   deliveries→ delivery_events 'assets_complete', by project owner
 *   replies   → conversation_meta.assigned_at → first outbound wa_messages
 *               by that person on that thread
 *
 * Nothing here is written back. It is a mirror, and it must stay one.
 */

export type MemberScorecard = {
  userId: string;
  /** `YYYY-MM-01`. */
  period: string;
  /** Only this member's targets; team-wide ones are not theirs to carry. */
  targets: TargetProgress[];
  hours: number;
  hoursByProject: { project: string; hours: number }[];
  todos: { done: number; open: number; overdue: number };
  dealsWon: number;
  leadsCreated: number;
  deliveries: number;
  /** Commission allocated in the month. Admin-only on the surface that shows it. */
  commissionAllocated: number;
  replies: {
    /** Threads handed to them in the month. */
    assigned: number;
    /** …that they wrote back on. */
    answered: number;
    /** Typical wait from hand-off to their first message, in minutes. */
    medianMinutes: number | null;
  };
};

function monthBounds(period: string): { start: string; end: string } {
  const start = `${period.slice(0, 7)}-01`;
  const next = new Date(`${start}T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: next.toISOString().slice(0, 10) };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function memberScorecard(
  db: DB,
  userId: string,
  period: string,
): Promise<MemberScorecard> {
  const { start, end } = monthBounds(period);
  const nowIso = new Date().toISOString();

  const [
    targets,
    timeRes,
    todosRes,
    wonRes,
    createdRes,
    ownedRes,
    commissionsRes,
    assignedRes,
  ] = await Promise.all([
    targetsProgress(db, start).catch(() => [] as TargetProgress[]),
    db
      .from("time_entries")
      .select("minutes, project_id, project:projects(name)")
      .eq("user_id", userId)
      .gte("worked_on", start)
      .lt("worked_on", end)
      .limit(2000),
    db
      .from("todos")
      .select("status, due_date, completed_at")
      .eq("assigned_to", userId)
      .or(`status.neq.done,completed_at.gte.${start}`)
      .limit(2000),
    db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("assigned_to", userId)
      .is("deleted_at", null)
      .gte("won_at", start)
      .lt("won_at", end),
    db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("assigned_to", userId)
      .is("deleted_at", null)
      .gte("created_at", start)
      .lt("created_at", end),
    db.from("projects").select("id").eq("created_by", userId).limit(2000),
    db
      .from("commissions")
      .select("amount")
      .eq("user_id", userId)
      .gte("created_at", start)
      .lt("created_at", end)
      .limit(1000),
    db
      .from("conversation_meta")
      .select("ref_id, assigned_at")
      .eq("channel", "whatsapp")
      .eq("assigned_to", userId)
      .gte("assigned_at", start)
      .lt("assigned_at", end)
      .limit(500)
      .then((r) => r, () => ({ data: null })),
  ]);

  // Hours, and where they went.
  const byProject = new Map<string, number>();
  let minutes = 0;
  for (const row of (timeRes.data ?? []) as unknown as {
    minutes: number;
    project: { name: string } | null;
  }[]) {
    minutes += Number(row.minutes ?? 0);
    const name = row.project?.name ?? "Unassigned";
    byProject.set(name, (byProject.get(name) ?? 0) + Number(row.minutes ?? 0));
  }
  const hoursByProject = [...byProject.entries()]
    .map(([project, m]) => ({ project, hours: Math.round((m / 60) * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 4);

  // To-dos: done in the month; open and overdue as of now.
  let done = 0;
  let open = 0;
  let overdue = 0;
  for (const t of todosRes.data ?? []) {
    if (t.status === "done") {
      if (t.completed_at && t.completed_at >= start && t.completed_at < end) done += 1;
      continue;
    }
    open += 1;
    if (t.due_date && t.due_date < nowIso) overdue += 1;
  }

  // Deliveries on projects they own.
  const ownedIds = (ownedRes.data ?? []).map((p) => p.id);
  let deliveries = 0;
  if (ownedIds.length) {
    const { count } = await db
      .from("delivery_events")
      .select("id", { count: "exact", head: true })
      .eq("kind", "assets_complete")
      .in("project_id", ownedIds)
      .gte("created_at", start)
      .lt("created_at", end);
    deliveries = count ?? 0;
  }

  // Hand-offs: how long until they wrote back.
  const assigned = (assignedRes.data ?? []).filter((a) => a.assigned_at) as {
    ref_id: string;
    assigned_at: string;
  }[];
  const replies = { assigned: assigned.length, answered: 0, medianMinutes: null as number | null };
  if (assigned.length) {
    const earliest = assigned.map((a) => a.assigned_at).sort()[0];
    const { data: outbound } = await db
      .from("wa_messages")
      .select("contact_id, created_at")
      .eq("author_id", userId)
      .eq("direction", "out")
      .in("contact_id", assigned.map((a) => a.ref_id))
      .gte("created_at", earliest)
      .order("created_at", { ascending: true })
      .limit(2000);
    const waits: number[] = [];
    for (const a of assigned) {
      const first = (outbound ?? []).find(
        (m) => m.contact_id === a.ref_id && m.created_at >= a.assigned_at,
      );
      if (!first) continue;
      replies.answered += 1;
      waits.push(
        (new Date(first.created_at).getTime() - new Date(a.assigned_at).getTime()) / 60_000,
      );
    }
    const med = median(waits);
    replies.medianMinutes = med === null ? null : Math.round(med);
  }

  return {
    userId,
    period: start,
    targets: targets.filter((t) => t.userId === userId),
    hours: Math.round((minutes / 60) * 10) / 10,
    hoursByProject,
    todos: { done, open, overdue },
    dealsWon: wonRes.count ?? 0,
    leadsCreated: createdRes.count ?? 0,
    deliveries,
    commissionAllocated: (commissionsRes.data ?? []).reduce(
      (s, c) => s + Number(c.amount ?? 0),
      0,
    ),
    replies,
  };
}
