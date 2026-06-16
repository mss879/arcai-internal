import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

async function AuthenticatedShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireProfile();
  const supabase = await createClient();

  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <AppShell profile={profile} notifications={notifications ?? []}>
      {children}
    </AppShell>
  );
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </Suspense>
  );
}
