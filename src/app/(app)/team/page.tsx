import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { TeamView } from "./team-view";

export const metadata = { title: "Team & Access" };

export default async function TeamPage() {
  const profile = await requireAdmin();
  const supabase = await createClient();

  const [membersRes, invitesRes, commissionsRes] = await Promise.all([
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
  ]);

  return (
    <TeamView
      members={membersRes.data ?? []}
      invitations={invitesRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      currentUserId={profile.id}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
