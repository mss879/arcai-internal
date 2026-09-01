"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { advanceCarousels } from "./actions";

/** How often to nudge an in-progress carousel forward while the page is open.
 *  Every poll is a serverless invocation, so this is deliberately relaxed —
 *  a slide render takes seconds anyway, and the cron tick advances posts
 *  regardless. */
const POLL_MS = 15000;

/**
 * Drive in-progress carousel generation to completion while the page is
 * open — the same pattern as `useDriveProspecting`: in production the
 * Netlify scheduled tick advances posts every minute, but local dev has no
 * cron, so this NON-OVERLAPPING, visibility-gated poll both finishes fresh
 * posts quickly and resumes any post orphaned by a dev-server restart.
 * Realtime flips the UI as rows change; the refresh is the fallback.
 */
export function useDriveCarousels(active: boolean): void {
  const router = useRouter();

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await advanceCarousels();
        if (!cancelled && res.ok) router.refresh();
      } catch {
        // transient — the next tick retries
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, router]);
}
