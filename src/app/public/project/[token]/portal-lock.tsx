"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";

import { portalCopy } from "@/lib/portal-copy";
import type { PortalLanguage } from "@/lib/types";

import { unlockPortal } from "./actions";

/**
 * The passcode screen (0094).
 *
 * Deliberately says nothing about the project — not its name, not the client's
 * name, not the company. Someone who has the link but not the code learns
 * only that a code exists. Numeric input mode so a phone shows a keypad.
 */
export function PortalLock({
  token,
  language,
  /** Set when the link itself is dead — no point offering the code box. */
  blocked,
}: {
  token: string;
  /**
   * The language code, not the dictionary. The copy object holds functions
   * (plurals, percentages) and functions cannot cross the server → client
   * boundary — so the client resolves it, which also keeps the whole
   * dictionary out of the page payload.
   */
  language: PortalLanguage;
  blocked?: "expired" | "revoked" | "locked";
}) {
  const copy = portalCopy(language);
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const deadMessage =
    blocked === "expired"
      ? copy.expired
      : blocked === "revoked"
        ? copy.revoked
        : blocked === "locked"
          ? copy.lockedOut
          : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await unlockPortal(token, code);
    setBusy(false);
    if (res.ok) {
      router.refresh();
    } else {
      setError(res.error);
      setCode("");
    }
  }

  return (
    <div className="app-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="rounded-3xl border border-white/30 bg-white/80 p-7 shadow-lg backdrop-blur-xl">
          <div className="flex flex-col items-center text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-50 text-primary-500">
              {deadMessage ? (
                <ShieldCheck className="h-7 w-7" />
              ) : (
                <KeyRound className="h-7 w-7" />
              )}
            </span>
            <h1 className="mt-4 text-lg font-bold text-slate-900">
              {deadMessage ? "ARC AI" : copy.lockedTitle}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              {deadMessage ?? copy.lockedBlurb}
            </p>
          </div>

          {!deadMessage && (
            <form onSubmit={submit} className="mt-6 space-y-3">
              <label className="block">
                <span className="sr-only">{copy.passcodeLabel}</span>
                <input
                  autoFocus
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 8))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  aria-label={copy.passcodeLabel}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] text-slate-900 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                />
              </label>

              {error && (
                <p className="text-center text-sm font-medium text-rose-600">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || code.length < 4}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {copy.openButton}
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">ARC AI</p>
      </div>
    </div>
  );
}
