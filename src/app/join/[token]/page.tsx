import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";

import { JoinForm } from "./join-form";

export const metadata = { title: "Join the workspace" };

type Reason = "invalid" | "used" | "expired" | "unconfigured";

const MESSAGES: Record<Reason, string> = {
  invalid: "This invite link is invalid or no longer exists.",
  used: "This invite has already been used or was revoked.",
  expired: "This invite has expired. Ask your admin for a fresh link.",
  unconfigured: "The workspace isn't fully configured yet. Contact your admin.",
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let email: string | null = null;
  let reason: Reason | null = null;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    reason = "unconfigured";
  } else {
    const admin = createAdminClient();
    const { data } = await admin
      .from("invitations")
      .select("email, status, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!data) reason = "invalid";
    else if (data.status !== "pending") reason = "used";
    else if (new Date(data.expires_at) < new Date()) reason = "expired";
    else email = data.email;
  }

  return (
    <AuthShell>
      {email ? (
        <JoinForm token={token} email={email} />
      ) : (
        <div className="space-y-5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Invite unavailable
          </h1>
          <Alert variant="error">{MESSAGES[reason ?? "invalid"]}</Alert>
          <Link href="/login" className={buttonStyles({ variant: "outline" })}>
            Go to login
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
