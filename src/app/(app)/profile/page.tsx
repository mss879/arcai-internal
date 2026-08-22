import { requireProfile } from "@/lib/auth";
import { getDeviceStatus, maskPhone } from "@/lib/device-trust";
import { attachRepayments } from "@/lib/loans";
import { createClient } from "@/lib/supabase/server";

import { ProfileView } from "./profile-view";

export const metadata = { title: "My Profile" };

export default async function ProfilePage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  const [{ data: commissions }, deviceStatus, loansRes, repaymentsRes] =
    await Promise.all([
      supabase
        .from("commissions")
        .select("*, project:projects(id, name)")
        .eq("user_id", profile.id)
        .order("created_at", { ascending: false }),
      // The device lock applies to members only; admins see no card.
      profile.role === "member" ? getDeviceStatus(profile.id) : null,
      // 0088 — their own advances. RLS already limits these to their rows;
      // the filter just saves the round-trip from being wider than it needs.
      supabase
        .from("member_loans")
        .select("*")
        .eq("user_id", profile.id)
        .order("issued_on", { ascending: false }),
      supabase
        .from("member_loan_repayments")
        .select("*")
        .eq("user_id", profile.id)
        .order("paid_on", { ascending: false }),
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
      loans={attachRepayments(loansRes.data ?? [], repaymentsRes.data ?? [])}
      trustedDevices={trustedDevices}
      phoneMask={profile.phone ? maskPhone(profile.phone) : null}
    />
  );
}
