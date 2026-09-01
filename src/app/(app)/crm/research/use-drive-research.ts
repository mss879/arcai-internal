"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { advanceResearch } from "./actions";

/** How often to nudge an in-progress report forward while the page is open.
 *  Every poll is a serverless invocation, so this is deliberately relaxed —
 *  steps take seconds anyway, and the cron tick advances things regardless. */
const POLL_MS = 15000;

/**
 * Drive in-progress prospect research to completion while the page is open.
 *
 * Research is a multi-step pipeline (discover → analyze → synthesize). In
 * production a Netlify scheduled function ticks every minute to advance it, but
 * local dev has NO such cron — so without this, a report can stall after the
 * initial in-process pass (e.g. the dev server restarts mid-run) and sit on
 * "Researching…" forever. This polls a research-scoped server action while any
 * report is in progress, so reports finish and orphaned rows resume on their
 * own. Realtime sync flips the card to "done" once the row completes.
 *
 * The poll is NON-OVERLAPPING: the synthesis step calls a reasoning model and
 * can run for a while, so we never fire a second poll until the previous one
 * resolves — that keeps a slow, still-running step from being re-claimed and
 * re-run. Ticks are also skipped in background tabs.
 */
export function useDriveResearch(active: boolean): void {
  const router = useRouter();

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await advanceResearch();
        // Realtime usually flips the UI, but refresh as a fallback so a report
        // still lands even if the realtime channel isn't delivering.
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
