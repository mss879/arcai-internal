import { requireProfile } from "@/lib/auth";
import { getDeviceStatus, maskPhone } from "@/lib/device-trust";
import { createClient } from "@/lib/supabase/server";

import { ProfileView } from "./profile-view";

export const metadata = { title: "My Profile" };

export default async function ProfilePage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  const [{ data: commissions }, deviceStatus] = await Promise.all([
    supabase
      .from("commissions")
      .select("*, project:projects(id, name)")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false }),
    // The device lock applies to members only; admins see no card.
    profile.role === "member" ? getDeviceStatus(profile.id) : null,
  ]);

  const trustedDevices = deviceStatus
    ? deviceStatus.devices.map((d) => ({
        id: d.id,
        label: d.label,
        created_at: d.created_at,
        last_used_at: d.last_used_at,
        isCurrent: d.id === deviceStatus.currentDeviceId,
      }))
    : null;

  return (
    <ProfileView
      profile={profile}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissions ?? []) as any}
      trustedDevices={trustedDevices}
      phoneMask={profile.phone ? maskPhone(profile.phone) : null}
    />
  );
}
