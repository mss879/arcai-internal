import { requireAdmin } from "@/lib/auth";
import { ONLINE_WINDOW_MS } from "@/lib/ping";
import { createClient } from "@/lib/supabase/server";

import { TeamView } from "./team-view";

export const metadata = { title: "Team & Access" };

export default async function TeamPage() {
  const profile = await requireAdmin();
  const supabase = await createClient();

  const [membersRes, invitesRes, commissionsRes, devicesRes, graceRes, onlineRes] =
    await Promise.all([
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
      supabase.from("device_grace").select("user_id, started_at"),
      // "Online now" = a session heartbeat within the last few minutes.
      supabase
        .from("login_sessions")
        .select("user_id")
        .gte(
          "last_active_at",
          new Date(Date.now() - ONLINE_WINDOW_MS).toISOString(),
        ),
    ]);

  return (
    <TeamView
      members={membersRes.data ?? []}
      invitations={invitesRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      trustedDevices={devicesRes.data ?? []}
      deviceGrace={graceRes.data ?? []}
      onlineUserIds={Array.from(
        new Set((onlineRes.data ?? []).map((r) => r.user_id)),
      )}
      currentUserId={profile.id}
      currentUserName={profile.full_name || profile.username}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
