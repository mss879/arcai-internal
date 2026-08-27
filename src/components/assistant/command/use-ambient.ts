"use client";

/**
 * The idle stage's data feed (0104).
 *
 * Fetches `/api/assistant/ambient` — vital signs, open events, today's
 * briefing headline — refreshed on a slow poll plus the events realtime
 * channel, so an invoice going overdue surfaces on the standby screen
 * within a heartbeat while the poll only pays for the stats.
 *
 * Dismissal is local-first, exactly like `use-assistant-inbox`: the ticker
 * disappears immediately and the row is updated behind it (the RLS update
 * policy allows it); a failed write just means the event returns on the
 * next load, which is the safe direction.
 */

import * as React from "react";

import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import { createClient } from "@/lib/supabase/client";

const POLL_MS = 3 * 60_000;

export type AmbientEvent = {
  id: string;
  kind: "info" | "warning" | "win" | "action";
  title: string;
  body: string | null;
  href: string | null;
  importance: number;
  created_at: string;
};

export type AmbientStats = {
  new_leads: number;
  going_cold: number;
  open_deal_value: number;
  won_this_week: number;
  unpaid_invoices: number;
  unpaid_value: number;
  revenue_month: number;
  expenses_month: number;
  overdue_tasks: number;
  cheques_due_week: number;
} | null;

export type Ambient = {
  stats: AmbientStats;
  events: AmbientEvent[];
  briefing: { threadId: string; headline: string } | null;
  dismiss: (id: string) => void;
  loaded: boolean;
};

export function useAmbient(enabled: boolean): Ambient {
  const [stats, setStats] = React.useState<AmbientStats>(null);
  const [events, setEvents] = React.useState<AmbientEvent[]>([]);
  const [briefing, setBriefing] = React.useState<Ambient["briefing"]>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/ambient", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats ?? null);
      setEvents(Array.isArray(data.events) ? data.events : []);
      setBriefing(data.briefing ?? null);
      setLoaded(true);
    } catch {
      // The poll returns in three minutes; standby can wait.
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, load]);

  useArcusRealtime("assistant_events", load, enabled);

  const dismiss = React.useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    void (async () => {
      try {
        await createClient()
          .from("assistant_events")
          .update({ status: "dismissed" })
          .eq("id", id);
      } catch {
        // Local dismissal already happened; the row returns next load.
      }
    })();
  }, []);

  return { stats, events, briefing, dismiss, loaded };
}
