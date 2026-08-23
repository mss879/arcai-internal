import { redirect } from "next/navigation";

import { currentClientId } from "@/lib/client-auth";

import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · ARC AI" };

export default async function ClientLoginPage() {
  // Already signed in — no reason to ask again.
  if (await currentClientId()) redirect("/portal");

  return (
    <main className="grid min-h-dvh place-items-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-extrabold tracking-tight text-slate-900">
            ARC AI
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Sign in to see your projects, invoices and files.
          </p>
        </div>
        <LoginForm />
        <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
          Use the mobile number you gave us. If it isn&apos;t working, message us
          on WhatsApp and we&apos;ll sort it out.
        </p>
      </div>
    </main>
  );
}
