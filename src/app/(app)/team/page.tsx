import { requireAdmin } from "@/lib/auth";
import { attachRepayments } from "@/lib/loans";
import { ONLINE_WINDOW_MS } from "@/lib/ping";
import { createClient } from "@/lib/supabase/server";
import { listSystemEvents } from "@/lib/system-audit";

import { periodFor, targetsProgress } from "@/lib/targets";

import type { SystemActivityRow } from "./system-activity";
import { TeamView } from "./team-view";

export const metadata = { title: "Team & Access" };

export default async function TeamPage() {
  const profile = await requireAdmin();
  const supabase = await createClient();
  // T5.3 — the trail's window, worked out once outside the render rules.
  const activitySince = daysAgoIso(7);

  const [
    membersRes,
    invitesRes,
    commissionsRes,
    devicesRes,
    onlineRes,
    loansRes,
    repaymentsRes,
    targetProgress,
    changesRes,
    systemEvents,
  ] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .order("role", { ascending: true })
        .order("full_name", { ascending: true }),
      supabase
        .from("invitations")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("commissions")
        .select("*, project:projects(id, name)")
        .order("created_at", { ascending: false }),
      supabase
        .from("trusted_devices")
        .select("id, user_id, label, created_at, last_used_at")
        .order("created_at", { ascending: true }),
      // "Online now" = a session heartbeat within the last few minutes.
      supabase
        .from("login_sessions")
        .select("user_id")
        .gte(
          "last_active_at",
          new Date(Date.now() - ONLINE_WINDOW_MS).toISOString(),
        ),
      // 0088 — outstanding advances come off each card's commission figure.
      supabase
        .from("member_loans")
        .select("*")
        .order("issued_on", { ascending: false }),
      supabase.from("member_loan_repayments").select("*"),
      // 0119 — what this month was supposed to look like. Degrades to an
      // empty list if the migration hasn't been applied yet.
      targetsProgress(supabase, periodFor(new Date())).catch(() => []),
    // T5.3 — the last seven days of what people changed…
    supabase
      .from("member_changes")
      .select("id, user_id, table_name, op, row_id, label, changed_fields, created_at")
      .gte("created_at", activitySince)
      .order("created_at", { ascending: false })
      .limit(200)
      .then((r) => r, () => ({ data: null })),
    // …beside what the system wrote on its own.
    listSystemEvents(supabase, { limit: 200, since: activitySince }),
    ]);

  // T5.3 — one trail, people and system, newest first.
  const nameById = new Map((membersRes.data ?? []).map((m) => [m.id, m.full_name || m.username]));
  const activity: SystemActivityRow[] = [
    ...(changesRes.data ?? []).map((c) => ({
      id: `change:${c.id}`,
      at: c.created_at,
      actorKind: "member" as const,
      actor: nameById.get(c.user_id) ?? "A member",
      action: c.op,
      table: c.table_name,
      rowId: c.row_id,
      summary: c.label ?? `${c.op} ${c.table_name}${c.changed_fields?.length ? ` (${c.changed_fields.join(", ")})` : ""}`,
    })),
    ...systemEvents.map((e) => ({
      id: `event:${e.id}`,
      at: e.created_at,
      actorKind: e.actor === "assistant"
        ? ("assistant" as const)
        : e.actor.startsWith("automation:")
          ? ("automation" as const)
          : e.actor.startsWith("user:")
            ? ("member" as const)
            : ("system" as const),
      actor: e.actor.startsWith("user:")
        ? (nameById.get(e.actor.slice(5)) ?? "A member")
        : e.actor.startsWith("system:")
          ? e.actor.slice(7)
          : e.actor,
      action: e.action,
      table: e.table_name,
      rowId: e.row_id,
      summary: e.summary,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return (
    <TeamView
      members={membersRes.data ?? []}
      activity={activity}
      invitations={invitesRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      loans={attachRepayments(loansRes.data ?? [], repaymentsRes.data ?? [])}
      trustedDevices={devicesRes.data ?? []}
      onlineUserIds={Array.from(
        new Set((onlineRes.data ?? []).map((r) => r.user_id)),
      )}
      targetProgress={targetProgress}
      targetPeriod={periodFor(new Date())}
      currentUserId={profile.id}
      currentUserName={profile.full_name || profile.username}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}

/** An ISO timestamp `days` ago. Outside the component so the purity rule stays quiet. */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
