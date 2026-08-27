"use client";

/**
 * What Arcus is waiting to tell you (0102).
 *
 * The events feed, read from the browser: a count for the bubble's badge and
 * the single most important headline for its chip. Realtime keeps both live,
 * so an invoice that goes overdue while the app is open raises the badge
 * without a reload.
 *
 * Two deliberate limits. It reads only what the RLS policy already allows
 * (own rows plus workspace-wide ones), and it only ever surfaces `new`
 * events — anything the briefing or a nudge already covered has been marked
 * `surfaced` server-side, so the bubble never re-announces what has already
 * been said.
 *
 * Dismissing is local-first: the chip disappears immediately and the row is
 * updated behind it, because a dismissal that waits for the network feels
 * broken.
 */

import * as React from "react";

import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import { createClient } from "@/lib/supabase/client";

export type InboxEvent = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  importance: number;
};

export type AssistantInbox = {
  /** Unread `new` events — what the badge counts. */
  count: number;
  /** The one worth showing on the chip, highest importance first. */
  top: InboxEvent | null;
  dismiss: (id: string) => void;
};

/** Never show a chip for trivia; those are briefing material. */
const CHIP_MIN_IMPORTANCE = 2;

export function useAssistantInbox(enabled = true): AssistantInbox {
  const [events, setEvents] = React.useState<InboxEvent[]>([]);

  const load = React.useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("assistant_events")
        .select("id, title, body, href, importance")
        .eq("status", "new")
        .neq("source", "pulse-marker")
        .gte("importance", CHIP_MIN_IMPORTANCE)
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(20);
      setEvents((data ?? []) as InboxEvent[]);
    } catch {
      // The table may not exist yet (migration 0102 unrun) — an assistant
      // that still answers is better than one that crashes the shell.
      setEvents([]);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  useArcusRealtime("assistant_events", load, enabled);

  const dismiss = React.useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    void (async () => {
      try {
        const supabase = createClient();
        await supabase
          .from("assistant_events")
          .update({ status: "dismissed" })
          .eq("id", id);
      } catch {
        // Local dismissal already happened; a failed write just means the
        // chip returns on the next load, which is the safe direction.
      }
    })();
  }, []);

  return {
    count: events.length,
    top: events[0] ?? null,
    dismiss,
  };
}
