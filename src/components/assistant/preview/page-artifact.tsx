"use client";

/**
 * The `page` artifact — a real route of this app, rendered inside the preview
 * canvas.
 *
 * This is the difference between Arc *describing* the CRM board and Arc
 * *showing* it. The route is loaded with `?embed=1`, which makes `AppShell`
 * drop the sidebar, the topbar and — critically — the assistant itself, so a
 * page artifact can never mount a second Studio inside the first.
 *
 * `toEmbedHref()` is the security boundary: same-origin paths only, no auth
 * surfaces, no hash. Anything it refuses renders as a "can't preview" state
 * with a plain link instead of a frame.
 */

import * as React from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { toEmbedHref, type ArtifactOf } from "./artifact-format";

export type PageArtifactProps = {
  artifact: ArtifactOf<"page">;
  /** False while the tab is not selected — the iframe is not mounted at all. */
  active: boolean;
  /** Bumped by the toolbar's Reload button to force a fresh load. */
  reloadKey?: number;
};

/**
 * Renders an in-app route inside the canvas.
 *
 * Only mounts the iframe while `active`: an unselected tab holding a live
 * document would keep polling, keep its realtime subscriptions open, and cost
 * memory for a page nobody is looking at.
 */
export function PageArtifact({
  artifact,
  active,
  reloadKey = 0,
}: PageArtifactProps): React.ReactElement {
  const src = React.useMemo(
    () => toEmbedHref(artifact.href),
    [artifact.href],
  );
  const [loaded, setLoaded] = React.useState(false);

  // A reload or a different route means "not loaded" again, otherwise the
  // skeleton would never come back for the second load.
  React.useEffect(() => {
    setLoaded(false);
  }, [src, reloadKey]);

  if (!src) {
    return (
      <div className="grid h-full min-h-[320px] place-items-center p-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-600">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <p className="text-sm font-semibold text-slate-900">
            This page can&apos;t be previewed here
          </p>
          <p className="mt-1 text-[13px] text-slate-500">
            Sign-in and external pages are never rendered inside Arcus. Open it in
            a tab of its own instead.
          </p>
          <a
            href={artifact.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open {artifact.title}
          </a>
        </div>
      </div>
    );
  }

  if (!active) return <div className="h-full w-full bg-white" />;

  return (
    <div className="relative h-full min-h-[480px] w-full">
      {!loaded && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-slate-100 motion-reduce:animate-none"
        />
      )}
      <iframe
        key={reloadKey}
        src={src}
        title={`${artifact.title} — embedded page`}
        referrerPolicy="same-origin"
        onLoad={() => setLoaded(true)}
        className={cn(
          "h-full w-full border-0 bg-white transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
