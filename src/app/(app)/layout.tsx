import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { requireProfile } from "@/lib/auth";
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

  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, type, title, body, link, read, created_at")
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
    <Suspense fallback={<ShellFallback />}>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </Suspense>
  );
}
