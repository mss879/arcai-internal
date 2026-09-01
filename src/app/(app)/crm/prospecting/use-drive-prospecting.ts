"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { advanceProspecting } from "./actions";

/** How often to nudge an in-progress scan forward while the page is open.
 *  Every poll is a serverless invocation, so this is deliberately relaxed —
 *  steps take seconds anyway, and the cron tick advances things regardless. */
const POLL_MS = 15000;

/**
 * Drive in-progress prospecting scans to completion while the page is open —
 * the same pattern as `useDriveResearch`: in production the Netlify scheduled
 * tick advances scans every minute, but local dev has no cron, so this
 * NON-OVERLAPPING, visibility-gated poll both finishes fresh scans quickly
 * and resumes any scan orphaned by a dev-server restart. Realtime flips the
 * UI as rows change; the refresh is the fallback.
 */
export function useDriveProspecting(active: boolean): void {
  const router = useRouter();

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await advanceProspecting();
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
