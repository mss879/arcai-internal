"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { driveOutreach } from "./actions";

/** How often to nudge an in-flight campaign forward while the page is open. */
const POLL_MS = 8000;

/**
 * Drive campaign drafting + auto-sending while the page is open — the same
 * pattern as `useDriveProspecting`/`useDriveResearch`. In production the
 * Netlify scheduled tick does this every minute; local dev has no cron at all,
 * so without this a campaign would look frozen. Realtime flips the counters as
 * rows change; the refresh is the fallback.
 *
 * The daily cap and the campaign's paused/running state are enforced server-side
 * in processAutoSendQueue, so polling faster here can NOT send more mail.
 *
 * Pass `leadId` to advance just that lead's row (the lead-detail card does), so
 * a manual draft doesn't wait behind a queue of campaign rows.
 */
export function useDriveOutreach(active: boolean, leadId?: string): void {
  const router = useRouter();

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await driveOutreach(leadId);
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
  }, [active, leadId, router]);
}
