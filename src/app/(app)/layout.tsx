import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DeviceTrustBanner } from "@/components/layout/device-trust-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { bumpActivity } from "@/lib/activity";
import { requireProfile } from "@/lib/auth";
import { getDeviceStatus } from "@/lib/device-trust";
import { createClient } from "@/lib/supabase/server";

/** Static shell painted while the profile + notifications resolve, so a
 *  hard page load shows chrome immediately instead of a blank screen. */
function ShellFallback() {
  return (
    <div className="app-bg flex min-h-screen">
      <aside className="hidden w-[260px] shrink-0 border-r border-slate-200/70 bg-white/60 lg:block" />
      <div className="min-w-0 flex-1">
        <div className="h-16 border-b border-slate-200/70 bg-white/70" />
        <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

async function AuthenticatedShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireProfile();
  const supabase = await createClient();

  const [{ data: notifications }, deviceStatus] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, title, body, link, read, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    // Members see the device-registration warning; admins are exempt.
    profile.role === "member" ? getDeviceStatus(profile.id) : null,
    // Activity heartbeat for the admin login monitor (members only) —
    // stretches the current login session's last_active_at, max once/minute.
    profile.role === "member" ? bumpActivity(profile.id) : null,
  ]);

  return (
    <AppShell profile={profile} notifications={notifications ?? []}>
      {deviceStatus && (
        <DeviceTrustBanner
          devicesCount={deviceStatus.devices.length}
          currentDeviceTrusted={deviceStatus.currentDeviceTrusted}
          graceDeadline={deviceStatus.graceDeadline}
          withinGrace={deviceStatus.withinGrace}
          phoneOnFile={!!profile.phone}
        />
      )}
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
    <Suspense fallback={<ShellFallback />}>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </Suspense>
  );
}
