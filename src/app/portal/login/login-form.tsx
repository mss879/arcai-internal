"use client";

/**
 * Two steps: a number, then the six digits texted to it (BIG-1).
 *
 * Deliberately says nothing about whether the number matched a client — an
 * unknown number gets the same "check your phone" screen. Otherwise this form
 * is a way to find out who ARC AI's clients are.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Phone, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

import { sendLoginCode, verifyLoginCode } from "../actions";

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = React.useState<"phone" | "code">("phone");
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [sentTo, setSentTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function handleSend() {
    if (!phone.trim()) {
      toast.error("Enter your mobile number.");
      return;
    }
    setBusy(true);
    const res = await sendLoginCode(phone);
    setBusy(false);
    if (res.ok) {
      setSentTo(res.sentTo);
      setStep("code");
    } else {
      toast.error(res.error);
    }
  }

  async function handleVerify() {
    setBusy(true);
    const res = await verifyLoginCode(phone, code);
    setBusy(false);
    if (res.ok) {
      router.replace("/portal");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      {step === "phone" ? (
        <div className="space-y-4">
          <Field label="Mobile number">
            <div className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSend();
                }}
                placeholder="077 185 2522"
                type="tel"
                autoComplete="tel"
                className="pl-9"
                autoFocus
              />
            </div>
          </Field>
          <Button className="w-full" onClick={handleSend} loading={busy}>
            Send me a code
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-800">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              If that number is on our records, a 6-digit code is on its way to{" "}
              <span className="font-semibold">{sentTo}</span>. It expires in ten
              minutes.
            </p>
          </div>

          <Field label="Your code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.length === 6) handleVerify();
              }}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-2xl tracking-[0.4em]"
              autoFocus
            />
          </Field>

          <Button
            className="w-full"
            onClick={handleVerify}
            loading={busy}
            disabled={code.length !== 6}
          >
            Sign in
          </Button>

          <button
            type="button"
            onClick={() => {
              setStep("phone");
              setCode("");
            }}
            className="inline-flex w-full items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Use a different number
          </button>
        </div>
      )}
    </div>
  );
}
