"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgreementPdfPayload } from "./download-pdf";

/**
 * The agreement preview IS the agreement: this renders the actual PDF (same
 * endpoint, same bytes as the download and the filed signed copy) in an
 * iframe, debounced as the form changes.
 *
 * Lifted wholesale from the proposal generator's preview, and for the same
 * reason — a hand-built HTML replica of a PDF can only ever approximate it,
 * and the two drift. Here what you see is literally the document the client
 * reads before they sign.
 */
export function AgreementPdfFrame({
  payload,
  className,
  debounceMs = 900,
}: {
  payload: AgreementPdfPayload;
  className?: string;
  debounceMs?: number;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Re-render only when the payload MEANINGFULLY changes.
  const body = React.useMemo(() => JSON.stringify(payload), [payload]);
  const empty = !payload.bodyMd.trim();

  React.useEffect(() => {
    // Nothing to render yet — the placeholder below covers this state, and
    // the badge is hidden on `empty`, so no flag needs setting here.
    if (empty) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/agreements/pdf?preview=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) throw new Error("Preview failed to render.");
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return next;
        });
        setError(null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Preview failed to render.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [body, debounceMs, empty]);

  // Free the last blob URL when the preview unmounts.
  React.useEffect(
    () => () => {
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    },
    [],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-slate-100 shadow-[var(--shadow-lift)] ring-1 ring-slate-200",
        className,
      )}
    >
      {url && !empty && !error ? (
        <iframe
          src={`${url}#toolbar=0&navpanes=0&view=FitH`}
          title="Agreement preview — exactly as the client receives it"
          className="h-full w-full"
        />
      ) : (
        <div className="grid h-full min-h-[420px] place-items-center p-6 text-center text-sm text-slate-400">
          {empty
            ? "Start from a template, or write the agreement — the real PDF appears here."
            : (error ?? "Rendering preview…")}
        </div>
      )}
      {loading && !empty && (
        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-medium text-slate-500 shadow-sm ring-1 ring-slate-200">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating preview…
        </div>
      )}
    </div>
  );
}
