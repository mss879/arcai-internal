"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { requestAudit } from "./actions";

/**
 * Two fields and an honest wait.
 *
 * The report takes minutes to produce, so the form says so rather than
 * pretending to work instantly and then going quiet. Campaign parameters are
 * read off the URL of this page, which for a magnet IS the landing page.
 */
export function AuditForm() {
  const [url, setUrl] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const params = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
    ]) {
      const value = params.get(key);
      if (value) utm[key] = value.slice(0, 200);
    }

    const res = await requestAudit({
      url,
      email,
      name,
      utm,
      referrer:
        document.referrer && !document.referrer.includes(window.location.host)
          ? document.referrer
          : undefined,
      landingUrl: window.location.href,
      ref: params.get("ref") ?? undefined,
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError(res.error);
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6">
        <p className="text-base font-semibold text-emerald-300">
          On its way.
        </p>
        <p className="mt-1 text-sm text-emerald-100/80">
          We&apos;re running it now — the report lands in your inbox within a few
          minutes. If it doesn&apos;t, check your spam folder and then tell us.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
        placeholder="yourwebsite.lk"
        aria-label="Your website address"
        className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-orange-400 focus:outline-none"
      />
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        type="email"
        placeholder="Where should we send it?"
        aria-label="Your email address"
        className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-orange-400 focus:outline-none"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name (optional)"
        aria-label="Your name"
        className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-orange-400 focus:outline-none"
      />

      {error && <p className="text-sm text-rose-300">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-6 py-3.5 text-base font-semibold text-white transition hover:bg-orange-400 disabled:opacity-60"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? "Queueing it…" : "Send me the audit"}
      </button>
    </form>
  );
}
