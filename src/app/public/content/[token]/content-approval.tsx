"use client";

import * as React from "react";
import Image from "next/image";
import { Check, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { approveContent, requestContentChanges } from "./actions";

/**
 * "Here's your post — happy with it?"
 *
 * Deliberately one screen and two buttons. The client is looking at this on a
 * phone, probably between other things, and every extra step is a post that
 * doesn't get approved today.
 */
export function ContentApproval({
  token,
  topic,
  caption,
  hashtags,
  scheduledFor,
  clientName,
  status: initialStatus,
  feedback: initialFeedback,
  slides,
  company,
}: {
  token: string;
  topic: string;
  caption: string;
  hashtags: string[];
  scheduledFor: string;
  clientName: string | null;
  status: string;
  feedback: string | null;
  slides: { id: string; url: string }[];
  company: { name: string; email: string; phones: string };
}) {
  const [status, setStatus] = React.useState(initialStatus);
  const [feedback, setFeedback] = React.useState(initialFeedback ?? "");
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function approve() {
    setBusy(true);
    const res = await approveContent(token);
    setBusy(false);
    if (res.ok) setStatus("approved");
    else toast.error(res.error);
  }

  async function requestChanges() {
    setBusy(true);
    const res = await requestContentChanges(token, feedback);
    setBusy(false);
    if (res.ok) {
      setStatus("changes_requested");
      setAsking(false);
    } else toast.error(res.error);
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          <div className="bg-gradient-to-br from-primary-500 to-primary-700 px-6 py-6 text-white sm:px-10">
            <p className="text-lg font-bold tracking-tight">{company.name}</p>
            <p className="mt-0.5 text-xs text-white/70">
              {clientName ? `For ${clientName} · ` : ""}
              Scheduled for {scheduledFor}
            </p>
          </div>

          <div className="space-y-5 px-6 py-6 sm:px-10 sm:py-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                The post
              </p>
              <h1 className="mt-1 text-xl font-bold text-slate-900">{topic}</h1>
            </div>

            {status === "approved" && (
              <div className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                Approved — thank you. We&apos;ll get it scheduled.
              </div>
            )}
            {status === "changes_requested" && (
              <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                You asked for changes. We&apos;re on it — we&apos;ll send the new
                version here.
                {initialFeedback && (
                  <p className="mt-1 text-xs text-amber-700">
                    “{initialFeedback}”
                  </p>
                )}
              </div>
            )}

            {slides.length > 0 && (
              <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
                {slides.map((s) => (
                  <div
                    key={s.id}
                    className="relative aspect-square w-64 shrink-0 snap-start overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200"
                  >
                    {/* Meta fetches these same public URLs when it posts, so
                        what the client approves is what goes out. */}
                    <Image
                      src={s.url}
                      alt=""
                      fill
                      sizes="256px"
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Caption
              </p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                {caption}
              </p>
              {hashtags.length > 0 && (
                <p className="mt-2 text-sm text-primary-600">
                  {hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}
                </p>
              )}
            </div>
          </div>
        </div>

        {status !== "approved" &&
          (asking ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
              <h2 className="text-base font-bold text-slate-900">
                What should we change?
              </h2>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={4}
                placeholder="The caption, an image, the timing — anything."
                className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              />
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  onClick={() => setAsking(false)}
                  disabled={busy}
                  className="rounded-xl px-5 py-2.5 text-sm font-semibold text-slate-500 hover:bg-slate-100"
                >
                  Go back
                </button>
                <button
                  onClick={requestChanges}
                  disabled={busy || !feedback.trim()}
                  className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  Send it over
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                onClick={approve}
                disabled={busy}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-6 py-3.5 text-base font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60 sm:flex-none"
              >
                <Check className="h-5 w-5" />
                Looks good — post it
              </button>
              <button
                onClick={() => setAsking(true)}
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-3.5 text-base font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
              >
                <MessageSquare className="h-5 w-5" />
                Ask for a change
              </button>
            </div>
          ))}

        <p className="pb-6 text-center text-xs text-slate-400">
          {company.name} · {company.email} · {company.phones}
        </p>
      </div>
    </div>
  );
}
