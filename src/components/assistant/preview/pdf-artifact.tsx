"use client";

/**
 * The `invoice` and `proposal` artifacts — rendered as the REAL PDF, not a
 * hand-built HTML lookalike.
 *
 * This is the thing the whole workspace exists for: ask Arc for a proposal and
 * the branded file the client will receive appears beside the conversation;
 * say "make it 140 thousand" and the same tab re-renders with the new figure.
 * It follows `proposals/proposal-pdf-frame.tsx` exactly — same endpoints, same
 * bytes, same debounce — because a preview that only approximates the file is
 * a preview the user learns to distrust.
 *
 * The blob cache is module-level and deliberately outlives the component:
 * `@react-pdf` renders are slow, and tab switching must not re-render a PDF
 * that has not changed. Object URLs are created in exactly one place here and
 * revoked in exactly two (LRU eviction and `clearPdfCache`), so nothing leaks
 * and nothing is revoked while another tab still points at it.
 */

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";

import type { ProposalPdfPayload } from "@/app/(app)/proposals/download-pdf";
import type { ArtifactOf } from "./artifact-format";

/** How long we wait after a payload change before spending a render. */
const DEBOUNCE_MS = 400;
/** Enough for the tabs a single conversation realistically opens. */
const MAX_CACHE = 6;

const pdfCache = new Map<string, string>();
/** Keys a mounted view is currently showing; never evicted underneath it. */
const pinned = new Set<string>();

function getPdf(key: string): string | undefined {
  const url = pdfCache.get(key);
  if (url) {
    // Re-insert so Map iteration order stays least-recently-used first.
    pdfCache.delete(key);
    pdfCache.set(key, url);
  }
  return url;
}

function putPdf(key: string, url: string): void {
  pdfCache.set(key, url);
  while (pdfCache.size > MAX_CACHE) {
    let victim: string | null = null;
    for (const candidate of pdfCache.keys()) {
      if (!pinned.has(candidate)) {
        victim = candidate;
        break;
      }
    }
    if (!victim) break; // everything on screen — grow rather than thrash
    const dead = pdfCache.get(victim);
    pdfCache.delete(victim);
    if (dead) URL.revokeObjectURL(dead);
  }
}

/** Drop one entry, e.g. before a Retry. */
function dropPdf(key: string): void {
  const url = pdfCache.get(key);
  pdfCache.delete(key);
  if (url) URL.revokeObjectURL(url);
}

/**
 * Free every cached PDF. Called when the workspace unmounts — that is the only
 * moment we know no tab can still be pointing at one of these URLs.
 */
export function clearPdfCache(): void {
  for (const url of pdfCache.values()) URL.revokeObjectURL(url);
  pdfCache.clear();
  pinned.clear();
}

type PdfArtifact = ArtifactOf<"invoice"> | ArtifactOf<"proposal">;

/** The exact JSON each PDF route expects. Also used by the download button. */
export function pdfRequest(artifact: PdfArtifact): {
  url: string;
  payload: ProposalPdfPayload | Record<string, unknown>;
  filename: string;
} {
  if (artifact.kind === "proposal") {
    const p = artifact.proposal;
    const safe =
      (p.client_name || "proposal").replace(/[^a-zA-Z0-9._-]/g, "") ||
      "proposal";
    return {
      url: "/api/proposals/pdf",
      payload: {
        client_name: p.client_name,
        project_name: p.project_name,
        proposal_date: p.proposal_date,
        selection: p.selection,
        content: p.content,
      } satisfies ProposalPdfPayload,
      filename: `Proposal-${safe}.pdf`,
    };
  }
  const inv = artifact.invoice;
  const safe = inv.invoice_number.replace(/[^a-zA-Z0-9._-]/g, "") || "invoice";
  return {
    url: "/api/invoices/pdf",
    payload: {
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      bill_to_name: inv.bill_to_name,
      bill_to_details: inv.bill_to_details,
      items: inv.items,
      grand_total: inv.grand_total,
      due_today: inv.due_today,
    },
    filename: `Invoice-${safe}.pdf`,
  };
}

export type PdfArtifactProps = {
  artifact: PdfArtifact;
  /** False while the tab is not selected — no fetch, no render cost. */
  active: boolean;
};

/**
 * Renders an invoice or proposal artifact as the actual PDF the client
 * receives, in an iframe, with the app's own loading badge.
 */
export function PdfArtifact({
  artifact,
  active,
}: PdfArtifactProps): React.ReactElement {
  const request = React.useMemo(() => pdfRequest(artifact), [artifact]);
  // The cache key is the SERIALISED payload, never the object identity: the
  // artifact object is rebuilt on every stream event, and keying on identity
  // would re-render the PDF on each one.
  const key = React.useMemo(
    () => JSON.stringify(request.payload),
    [request.payload],
  );

  const [url, setUrl] = React.useState<string | null>(() => getPdf(key) ?? null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  // Keep the mounted key pinned so the LRU can never revoke what is on screen.
  React.useEffect(() => {
    pinned.add(key);
    return () => {
      pinned.delete(key);
    };
  }, [key]);

  React.useEffect(() => {
    if (!active) return;

    const cached = getPdf(key);
    if (cached) {
      setUrl(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${request.url}?preview=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: ctrl.signal,
          body: key,
        });
        if (!res.ok) throw new Error("Preview failed to render.");
        // An expired session does NOT come back as an error. The proxy
        // 307s an unauthenticated API call to /login, fetch follows it, and
        // the result is 200 OK with the login page's HTML — which the iframe
        // below would happily render as if it were the document. Check what
        // actually arrived instead of trusting the status.
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("application/pdf")) {
          throw new Error(
            type.includes("text/html")
              ? "Your session has expired — sign in again to see the preview."
              : "That didn't come back as a PDF.",
          );
        }
        const blob = await res.blob();
        if (ctrl.signal.aborted) return;
        const next = URL.createObjectURL(blob);
        putPdf(key, next);
        setUrl(next);
        setError(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Preview failed to render.");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
    // `attempt` is in the deps so Retry re-runs this effect.
  }, [active, key, request.url, attempt]);

  const retry = React.useCallback(() => {
    dropPdf(key);
    setUrl(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, [key]);

  const title =
    artifact.kind === "invoice"
      ? `Invoice ${artifact.invoice.invoice_number} — exactly as the client receives it`
      : `Proposal for ${artifact.proposal.client_name} — exactly as the client receives it`;

  return (
    <div className="relative h-full min-h-[520px] p-3">
      {url && !error ? (
        // Never `sandbox` a PDF iframe: it disables the browser's built-in
        // viewer in Chrome and Safari and the user gets a blank grey box.
        <iframe
          src={`${url}#toolbar=0&navpanes=0&view=FitH`}
          title={title}
          className="h-full w-full rounded-xl bg-slate-100 ring-1 ring-slate-200"
        />
      ) : (
        <div className="grid h-full place-items-center rounded-xl bg-slate-100 p-6 text-center ring-1 ring-slate-200">
          {error ? (
            <div>
              <p className="text-sm text-slate-500">{error}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Rendering preview…</p>
          )}
        </div>
      )}

      {loading && (
        <div className="absolute right-5 top-5 flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-medium text-slate-500 shadow-sm ring-1 ring-slate-200">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating preview…
        </div>
      )}
    </div>
  );
}
