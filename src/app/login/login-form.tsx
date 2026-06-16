"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

import { loginAction } from "./actions";

export function LoginForm({
  redirectTo,
  title = "Welcome back",
  subtitle = "Log in to your ARC AI workspace.",
  footerNote = "Access is invite-only. Ask your workspace admin for an invitation.",
}: {
  redirectTo?: string;
  title?: string;
  subtitle?: string;
  footerNote?: string;
}) {
  const [state, action, pending] = useActionState(loginAction, undefined);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        {title}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>

      <form action={action} className="mt-7 space-y-4">
        {state?.error && <Alert variant="error">{state.error}</Alert>}
        {redirectTo && (
          <input type="hidden" name="redirectTo" value={redirectTo} />
        )}

        <Field label="Username or email">
          <Input
            name="identifier"
            placeholder="you@example.com"
            autoComplete="username"
            autoFocus
          />
        </Field>

        <Field label="Password">
          <Input
            name="password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </Field>

        <Button type="submit" loading={pending} className="w-full" size="lg">
          Log in
        </Button>
      </form>

      {footerNote && (
        <p className="mt-6 text-center text-xs text-slate-400">{footerNote}</p>
      )}
    </div>
  );
}
