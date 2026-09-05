"use client";

import * as React from "react";

/**
 * The root layout itself broke (T5.5).
 *
 * Rendered with no layout around it, so it carries its own <html> and
 * <body>. Reports like error.tsx; styles are inline because the global
 * stylesheet may be the very thing that failed.
 */
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <div style={{ maxWidth: 440, margin: "18vh auto 0", padding: "0 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>ARC AI couldn&apos;t load</h1>
          <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 20px" }}>
            It has been reported. Reload to try again.
          </p>
          {error.digest && (
            <p style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", margin: "0 0 16px" }}>
              ref {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              background: "#0f172a",
              color: "#fff",
              border: 0,
              borderRadius: 12,
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
