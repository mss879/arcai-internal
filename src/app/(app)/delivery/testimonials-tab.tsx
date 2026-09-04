"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Quote, Star } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

import { publishTestimonial, unpublishTestimonial } from "./actions";

/**
 * What clients said, and whether the world can see it.
 *
 * Reviews were collected on the portal and then sat in a table: putting one
 * on the website meant copying the words across by hand, so most of the
 * praise this agency earned was never used. Publishing is now one button, and
 * a failure says so rather than looking like it worked.
 */

export type TestimonialRow = {
  id: string;
  projectId: string;
  projectName: string;
  clientName: string | null;
  clientCompany: string | null;
  rating: number | null;
  headline: string | null;
  body: string | null;
  publishable: boolean;
  status: string;
  publishStatus: string;
  publishError: string | null;
  submittedAt: string | null;
};

export function TestimonialsTab({ reviews }: { reviews: TestimonialRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const submitted = reviews.filter((r) => r.status === "submitted");

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(id);
    const res = await fn();
    setBusy(null);
    if (res.ok) router.refresh();
    else toast.error(res.error ?? "That didn't work.");
  }

  if (submitted.length === 0) {
    return (
      <EmptyState
        icon={<Quote className="h-6 w-6" />}
        title="No reviews back yet"
        description="Ask for one from a delivered project's Client tab — it comes back here, and one button puts it on the website."
      />
    );
  }

  return (
    <div className="space-y-3">
      {submitted.map((r) => (
        <div
          key={r.id}
          className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  {r.clientName ?? "A client"}
                </p>
                {r.rating != null && (
                  <span className="flex items-center gap-0.5 text-amber-500">
                    {Array.from({ length: r.rating }).map((_, i) => (
                      <Star key={i} className="h-3.5 w-3.5 fill-current" />
                    ))}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">{r.projectName}</p>
            </div>
            <div className="flex items-center gap-2">
              {!r.publishable && (
                <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
                  Not for public use
                </Badge>
              )}
              {r.publishStatus === "published" && (
                <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                  On the website
                </Badge>
              )}
              {r.publishStatus === "failed" && (
                <Badge className="bg-rose-50 text-rose-600 ring-rose-200">
                  Publish failed
                </Badge>
              )}
            </div>
          </div>

          {r.headline && (
            <p className="mt-3 text-sm font-medium text-slate-800">{r.headline}</p>
          )}
          {r.body && (
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {r.body}
            </p>
          )}

          {r.publishError && (
            <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">
              {r.publishError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {r.body && (
              <CopyButton
                value={[r.headline, r.body].filter(Boolean).join("\n\n")}
                label="Copy the quote"
              />
            )}
            {/* Consent is the gate: a review the client didn't agree to
                publish has no publish button at all, not a disabled one. */}
            {r.publishable &&
              (r.publishStatus === "published" ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === r.id}
                    onClick={() => run(r.id, () => unpublishTestimonial(r.id))}
                  >
                    Take it down
                  </Button>
                  <a
                    href="https://www.arcai.agency/success-stories"
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-medium",
                      "text-primary-600 hover:underline",
                    )}
                  >
                    <ExternalLink className="h-3 w-3" /> See it live
                  </a>
                </>
              ) : (
                <Button
                  size="sm"
                  loading={busy === r.id}
                  onClick={() =>
                    run(r.id, () => publishTestimonial(r.id, r.clientCompany))
                  }
                >
                  {r.publishStatus === "failed"
                    ? "Try publishing again"
                    : "Publish to the website"}
                </Button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
