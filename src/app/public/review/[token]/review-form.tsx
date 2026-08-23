"use client";

import * as React from "react";
import { Heart, Loader2, Star } from "lucide-react";

import { portalCopy } from "@/lib/portal-copy";
import type { PortalLanguage } from "@/lib/types";
import { cn } from "@/lib/utils";

import { submitReview } from "./actions";

/**
 * "How did we do?" on a phone (0094).
 *
 * Five taps for the rating, and everything below it optional. The one thing
 * that must not be assumed is permission to publish, so that's an explicit
 * tick — unticked by default.
 */
export function ReviewForm({
  token,
  projectName,
  clientName,
  language,
  alreadyDone,
  existing,
}: {
  token: string;
  projectName: string;
  clientName: string | null;
  /** Code, not dictionary — see PortalClient. */
  language: PortalLanguage;
  alreadyDone: boolean;
  existing: { rating: number; headline: string | null; body: string | null } | null;
}) {
  const copy = portalCopy(language);
  const [rating, setRating] = React.useState(existing?.rating ?? 0);
  const [hover, setHover] = React.useState(0);
  const [headline, setHeadline] = React.useState("");
  const [body, setBody] = React.useState("");
  const [publishable, setPublishable] = React.useState(false);
  const [name, setName] = React.useState(clientName ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(alreadyDone);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating || busy) return;
    setBusy(true);
    setError(null);
    const res = await submitReview(token, {
      rating,
      headline,
      body,
      publishable,
      name,
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError(res.error);
  }

  if (done) {
    return (
      <div className="app-bg flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px] rounded-3xl border border-white/30 bg-white/80 p-8 text-center shadow-lg backdrop-blur-xl">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500">
            <Heart className="h-7 w-7 fill-rose-500" />
          </span>
          <h1 className="mt-4 text-lg font-bold text-slate-900">
            {copy.pulseThanks}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            It genuinely helps a small team like ours.
          </p>
          <p className="mt-6 text-xs text-slate-400">ARC AI</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-bg flex min-h-screen items-center justify-center px-4 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-[460px] rounded-3xl border border-white/30 bg-white/80 p-7 shadow-lg backdrop-blur-xl"
      >
        <h1 className="text-center text-xl font-bold text-slate-900">
          How did we do?
        </h1>
        <p className="mt-1.5 text-center text-sm text-slate-500">
          {projectName}
        </p>

        {/* Stars */}
        <div
          className="mt-6 flex justify-center gap-1.5"
          onMouseLeave={() => setHover(0)}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              className="p-1 transition hover:scale-110"
            >
              <Star
                className={cn(
                  "h-9 w-9 transition-colors",
                  n <= (hover || rating)
                    ? "fill-amber-400 text-amber-400"
                    : "text-slate-300",
                )}
              />
            </button>
          ))}
        </div>

        {rating > 0 && (
          <div className="mt-6 space-y-4">
            <input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="In a few words…"
              maxLength={140}
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
            />
            <textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Anything you'd like to say — what went well, what we could do better."
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
            />

            <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3">
              <input
                type="checkbox"
                checked={publishable}
                onChange={(e) => setPublishable(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
              />
              <span className="text-sm text-slate-700">
                You may share this publicly
                <span className="block text-xs text-slate-500">
                  On our website or social media, with your name. Leave it
                  unticked and it stays between us.
                </span>
              </span>
            </label>
          </div>
        )}

        {error && (
          <p className="mt-4 text-center text-sm font-medium text-rose-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!rating || busy}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Send
        </button>

        <p className="mt-4 text-center text-xs text-slate-400">ARC AI</p>
      </form>
    </div>
  );
}
