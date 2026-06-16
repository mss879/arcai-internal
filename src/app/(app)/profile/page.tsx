import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { ProfileView } from "./profile-view";

export const metadata = { title: "My Profile" };

export default async function ProfilePage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  const { data: commissions } = await supabase
    .from("commissions")
    .select("*, project:projects(id, name)")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false });

  return (
    <ProfileView
      profile={profile}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissions ?? []) as any}
    />
  );
}
