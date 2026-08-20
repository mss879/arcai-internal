"use client";

import { useActionState, useState } from "react";
import { MessageSquareLock } from "lucide-react";

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
  // Controlled so values survive the extra round-trips of the device-code
  // flow (React resets uncontrolled fields after each form action).
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [deviceCode, setDeviceCode] = useState("");

  const showDeviceCode = !!state?.deviceCodePrompt;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        {title}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>

      <form action={action} className="mt-7 space-y-4">
        {state?.error && <Alert variant="error">{state.error}</Alert>}
        {state?.info && <Alert variant="info">{state.info}</Alert>}
        {redirectTo && (
          <input type="hidden" name="redirectTo" value={redirectTo} />
        )}

        <Field label="Username or email">
          <Input
            name="identifier"
            placeholder="you@example.com"
            autoComplete="username"
            autoFocus
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </Field>

        <Field label="Password">
          <Input
            name="password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {showDeviceCode && (
          <div className="space-y-3 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3.5">
            <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
              <MessageSquareLock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              This device isn&apos;t trusted yet. We&apos;ll text a one-time
              code to {state?.phoneMask ?? "the phone number on your account"}{" "}
              so this device can be registered.
            </p>
            <Field label="Device code">
              <Input
                name="deviceCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6-digit code"
                value={deviceCode}
                onChange={(e) =>
                  setDeviceCode(e.target.value.replace(/\D/g, ""))
                }
              />
            </Field>
            <Button
              type="submit"
              name="intent"
              value="send-code"
              variant="outline"
              className="w-full"
              loading={pending}
            >
              Text me a code
            </Button>
          </div>
        )}

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
