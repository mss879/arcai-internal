"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { ExternalLink, RotateCcw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { SocialPlatform, SocialPostStatus } from "@/lib/database.types";
import { cn } from "@/lib/utils";

import { cancelSocialPost, retrySocialPost } from "./actions";

/**
 * The publish queue (0118): what is going out, what went, what didn't.
 *
 * Scheduling happens on the post itself (the Calendar tab); this is the one
 * place to see the queue as a whole and to pull something back before it
 * posts, or push a failed one again once the token is fixed.
 */

export type SocialPostRow = {
  id: string;
  platform: SocialPlatform;
  accountName: string | null;
  topic: string | null;
  caption: string;
  mediaCount: number;
  scheduledFor: string;
  status: SocialPostStatus;
  permalink: string | null;
  error: string | null;
  attempts: number;
};

const STATUS: Record<SocialPostStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  scheduled: { label: "Scheduled", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  publishing: { label: "Publishing…", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  published: { label: "Published", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-600 ring-rose-200" },
  cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-400 ring-slate-200" },
};

type Filter = "upcoming" | "done" | "problems" | "all";

function bucket(row: SocialPostRow): Filter {
  if (row.status === "scheduled" || row.status === "publishing" || row.status === "draft")
    return "upcoming";
  if (row.status === "failed") return "problems";
  return "done";
}

export function PublishingTab({
  posts,
  dryRun,
}: {
  posts: SocialPostRow[];
  /** SOCIAL_DRY_RUN=1 — the queue runs without calling Meta. */
  dryRun: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("upcoming");
  const [busy, setBusy] = React.useState<string | null>(null);

  const counts = React.useMemo(() => {
    const c: Record<Filter, number> = { upcoming: 0, done: 0, problems: 0, all: posts.length };
    for (const p of posts) c[bucket(p)] += 1;
    return c;
  }, [posts]);

  const visible = posts.filter((p) => filter === "all" || bucket(p) === filter);

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusy(id);
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      toast.success(done);
      router.refresh();
    } else toast.error(res.error ?? "That didn't work.");
  }

  if (posts.length === 0) {
    return (
      <EmptyState
        icon={<Send className="h-6 w-6" />}
        title="Nothing queued yet"
        description="Pick a design on a calendar post and tap “Schedule it” — it lands here, and goes out on time."
      />
    );
  }

  return (
    <div className="space-y-4">
      {dryRun && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          Dry run is on (SOCIAL_DRY_RUN=1): posts move to “Published” without
          reaching Instagram or Facebook. Turn it off once Meta has approved the app.
        </p>
      )}

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {(
          [
            ["upcoming", "Upcoming"],
            ["problems", "Problems"],
            ["done", "Done"],
            ["all", "All"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              filter === key
                ? "bg-primary-600 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-800",
            )}
          >
            {label}
            {counts[key] > 0 && (
              <span className="ml-1 opacity-70">{counts[key]}</span>
            )}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="px-1 text-sm text-slate-500">Nothing in this view.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Post</th>
                <th className="px-4 py-3 font-semibold">Where</th>
                <th className="px-4 py-3 font-semibold">When</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {visible.map((p) => {
                const status = STATUS[p.status] ?? STATUS.draft;
                const canCancel =
                  p.status === "scheduled" || p.status === "draft" || p.status === "failed";
                const canRetry = p.status === "failed" || p.status === "cancelled";
                return (
                  <tr key={p.id} className="align-top hover:bg-slate-50/60">
                    <td className="max-w-[28rem] px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {p.topic ?? "Post"}
                        <span className="ml-1.5 text-xs font-normal text-slate-400">
                          {p.mediaCount} image{p.mediaCount === 1 ? "" : "s"}
                        </span>
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{p.caption}</p>
                      {p.error && (
                        <p className="mt-1 text-xs text-rose-600">
                          {p.error}
                          {p.attempts > 0 ? ` (after ${p.attempts} attempt${p.attempts === 1 ? "" : "s"})` : ""}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {p.platform === "instagram" ? "Instagram" : "Facebook"}
                      {p.accountName && (
                        <span className="block text-xs text-slate-400">{p.accountName}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {format(parseISO(p.scheduledFor), "d MMM, h:mm a")}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={status.className}>{status.label}</Badge>
                      {p.permalink && (
                        <a
                          href={p.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> View post
                        </a>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {canCancel && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === p.id}
                          onClick={() =>
                            run(p.id, () => cancelSocialPost(p.id), "Taken off the queue.")
                          }
                        >
                          <XCircle className="h-4 w-4" /> Cancel
                        </Button>
                      )}
                      {canRetry && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === p.id}
                          onClick={() =>
                            run(p.id, () => retrySocialPost(p.id), "Back on the queue.")
                          }
                        >
                          <RotateCcw className="h-4 w-4" /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
