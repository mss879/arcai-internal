import { notFound } from "next/navigation";
import { format } from "date-fns";

import { requireAdmin } from "@/lib/auth";
import { attachRepayments } from "@/lib/loans";
import { ONLINE_WINDOW_MS } from "@/lib/ping";
import { memberScorecard } from "@/lib/scorecards";
import { createClient } from "@/lib/supabase/server";
import { periodFor } from "@/lib/targets";

import { MemberDashboard } from "./member-dashboard";

export const metadata = { title: "Member" };

/** Keep in sync with GRACE_HOURS in src/lib/device-trust.ts. */
const DEVICE_GRACE_HOURS = 48;

export default async function MemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireAdmin();
  const supabase = await createClient();

  const [
    memberRes,
    commissionsRes,
    loansRes,
    repaymentsRes,
    devicesRes,
    onlineRes,
    graceRes,
    scorecards,
    payoutsRes,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("commissions")
      .select("*, project:projects(id, name)")
      .eq("user_id", id)
      .order("created_at", { ascending: false }),
    // 0088 — advances, newest first.
    supabase
      .from("member_loans")
      .select("*")
      .eq("user_id", id)
      .order("issued_on", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("member_loan_repayments")
      .select("*")
      .eq("user_id", id)
      .order("paid_on", { ascending: false }),
    supabase
      .from("trusted_devices")
      .select("id, user_id, label, created_at, last_used_at")
      .eq("user_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("login_sessions")
      .select("user_id")
      .eq("user_id", id)
      .gte(
        "last_active_at",
        new Date(Date.now() - ONLINE_WINDOW_MS).toISOString(),
      )
      .limit(1),
    // When their 48-hour device-registration window started (0079).
    supabase
      .from("device_grace")
      .select("started_at")
      .eq("user_id", id)
      .maybeSingle(),
    // 0119 — this month and last, newest first. A month that fails to load
    // (a table not yet migrated) is simply absent from the picker.
    Promise.all(
      [0, 1].map((back) => {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - back);
        return memberScorecard(supabase, id, periodFor(d)).catch(() => null);
      }),
    ).then((cards) => cards.filter((c) => c !== null)),
    // 0120 — payout runs, newest first. Absent until the migration lands.
    supabase
      .from("commission_payouts")
      .select("*")
      .eq("user_id", id)
      .order("paid_at", { ascending: false })
      .limit(50)
      .then((r) => r, () => ({ data: null })),
  ]);

  const member = memberRes.data;
  if (!member) notFound();

  const devices = devicesRes.data ?? [];
  // Where they stand against the two-device lock (0079). Worked out here
  // rather than in the client so the wording is stable for a given render.
  const graceStartedAt = graceRes.data?.started_at ?? null;
  const deviceStatus =
    member.role !== "member"
      ? null
      : devices.length >= 2
        ? "Locked to their 2 registered devices."
        : devices.length === 1
          ? "1 of 2 devices registered — the second joins via SMS code at login."
          : !graceStartedAt
            ? "Registration window hasn't started — it begins at their next sign-in."
            : Date.now() <
                new Date(graceStartedAt).getTime() +
                  DEVICE_GRACE_HOURS * 3_600_000
              ? `Must trust a device by ${format(
                  new Date(graceStartedAt).getTime() +
                    DEVICE_GRACE_HOURS * 3_600_000,
                  "MMM d, h:mm a",
                )}.`
              : "Locked out — reset their devices from the Team board to grant a new 48-hour window.";

  return (
    <MemberDashboard
      member={member}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      loans={attachRepayments(loansRes.data ?? [], repaymentsRes.data ?? [])}
      devices={devices}
      deviceStatus={deviceStatus}
      isOnline={
        member.role === "member" && (onlineRes.data ?? []).length > 0
      }
      isYou={member.id === me.id}
      scorecards={scorecards}
      payouts={payoutsRes.data ?? []}
    />
  );
}
