import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { Alert } from "@/components/ui/alert";
import { getProfile, isSupabaseConfigured } from "@/lib/auth";

import { LoginForm } from "./login-form";

export const metadata = { title: "Log in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const configured = isSupabaseConfigured();

  if (configured && (await getProfile())) {
    redirect("/dashboard");
  }

  return (
    <AuthShell>
      {!configured ? (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Almost there
          </h1>
          <Alert variant="info">
            Supabase isn&apos;t configured yet. Add{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{" "}
            and{" "}
            <code className="font-mono text-xs">SUPABASE_SERVICE_ROLE_KEY</code>{" "}
            to <code className="font-mono text-xs">.env.local</code>, run the
            migrations, then reload.
          </Alert>
        </div>
      ) : (
        <LoginForm />
      )}
    </AuthShell>
  );
}
