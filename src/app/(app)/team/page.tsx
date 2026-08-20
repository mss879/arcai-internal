import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { TeamView } from "./team-view";

export const metadata = { title: "Team & Access" };

export default async function TeamPage() {
  const profile = await requireAdmin();
  const supabase = await createClient();

  const [membersRes, invitesRes, commissionsRes, devicesRes, graceRes] =
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
    ]);

  return (
    <TeamView
      members={membersRes.data ?? []}
      invitations={invitesRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      trustedDevices={devicesRes.data ?? []}
      deviceGrace={graceRes.data ?? []}
      currentUserId={profile.id}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
