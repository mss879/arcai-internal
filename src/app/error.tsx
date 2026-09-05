"use client";

import * as React from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

/**
 * A page broke (T5.5).
 *
 * Next renders this in place of the page tree when a server or client
 * error escapes a route. What broke is reported to /api/errors so an admin
 * sees it on Settings; the person sees a plain way back, not a stack.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    void fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        path: typeof window !== "undefined" ? window.location.pathname : null,
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-rose-50 text-rose-500">
        <TriangleAlert className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">Something went wrong on this page</h1>
      <p className="mt-2 text-sm text-slate-500">
        It has been reported. Try again — if it keeps happening, the team will already have the details.
      </p>
      {error.digest && <p className="mt-2 font-mono text-[11px] text-slate-400">ref {error.digest}</p>}
      <button
        onClick={reset}
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        <RefreshCw className="h-4 w-4" /> Try again
      </button>
    </div>
  );
}
