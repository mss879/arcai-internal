"use client";

import Link from "next/link";
import { useActionState } from "react";
import { CheckCircle2 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

import { acceptInviteAction } from "./actions";

export function JoinForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, undefined);

  if (state?.success) {
    return (
      <div>
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-50 text-emerald-500">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Account created
        </h1>
        <p className="mt-1.5 text-sm text-slate-500">
          You can now log in with{" "}
          <span className="font-medium text-slate-700">
            {state.success.email}
          </span>{" "}
          and the password you just set.
        </p>
        <Link
          href="/login"
          className={buttonStyles({ size: "lg", className: "mt-6 w-full" })}
        >
          Continue to login
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Join ARC AI
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">
        Set up your account to join the workspace.
      </p>

      <form action={action} className="mt-7 space-y-4">
        {state?.error && <Alert variant="error">{state.error}</Alert>}
        <input type="hidden" name="token" value={token} />

        <Field label="Full name" required>
          <Input name="full_name" placeholder="Jane Doe" autoFocus />
        </Field>

        <Field label="Email">
          <Input
            name="email"
            type="email"
            value={email}
            readOnly
            className="bg-slate-50 text-slate-500"
          />
        </Field>

        <Field label="Password" required hint="At least 8 characters.">
          <Input
            name="password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
          />
        </Field>

        <Button type="submit" loading={pending} className="w-full" size="lg">
          Create account
        </Button>
      </form>
    </div>
  );
}
