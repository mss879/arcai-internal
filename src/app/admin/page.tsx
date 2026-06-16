import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { Alert } from "@/components/ui/alert";
import { getProfile, isSupabaseConfigured } from "@/lib/auth";

import { LoginForm } from "@/app/login/login-form";

export const metadata = { title: "Admin sign in" };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  const configured = isSupabaseConfigured();

  if (configured) {
    const profile = await getProfile();
    if (profile?.role === "admin") redirect("/team");
    if (profile) redirect("/dashboard");
  }

  return (
    <AuthShell>
      {!configured ? (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Almost there
          </h1>
          <Alert variant="info">
            Supabase isn&apos;t configured yet. Add your keys to{" "}
            <code className="font-mono text-xs">.env.local</code> and run the
            migrations first.
          </Alert>
        </div>
      ) : (
        <LoginForm
          redirectTo="/team"
          title="Admin sign in"
          subtitle="Log in to manage your workspace and team."
          footerNote="Admin accounts are created in Supabase. Members should use the invite link."
        />
      )}
    </AuthShell>
  );
}
