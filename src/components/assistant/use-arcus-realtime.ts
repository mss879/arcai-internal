"use client";

/**
 * One safe way to subscribe Arcus's surfaces to Postgres changes.
 *
 * The bug this exists to prevent, because it is not obvious and it only shows
 * up in development:
 *
 *   `createBrowserClient` (@supabase/ssr) is a SINGLETON, and a Supabase
 *   client caches its channels BY TOPIC. So `supabase.channel("x")` returns
 *   the channel that already exists for "x" rather than a new one. React's
 *   StrictMode mounts every effect twice — mount, clean up, mount again — and
 *   `removeChannel()` is asynchronous, so the second mount gets back the
 *   first mount's channel, which has already had `.subscribe()` called on it.
 *   Adding a listener to a subscribed channel throws:
 *
 *     "cannot add `postgres_changes` callbacks for realtime:… after
 *      `subscribe()`"
 *
 * The fix is to never reuse a topic. Every subscription gets its own suffix
 * from a monotonic counter, so a channel still tearing down can never be
 * handed to the effect that is starting up. Cleanup removes the exact channel
 * instance it created, so nothing leaks.
 *
 * Two smaller rules come along for free:
 *   - `onChange` is read through a ref, so a caller can pass an inline
 *     function without re-subscribing on every render.
 *   - `enabled` gates the whole thing, which is how a framed copy of the app
 *     (the preview canvas) avoids opening a second socket behind the first.
 */

import * as React from "react";

import { createClient } from "@/lib/supabase/client";

/** Monotonic, so two mounts of the same hook never share a topic. */
let channelSeq = 0;

export function useArcusRealtime(
  table: string,
  onChange: (payload: { new?: unknown; old?: unknown }) => void,
  enabled = true,
): void {
  const handlerRef = React.useRef(onChange);
  React.useEffect(() => {
    handlerRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    channelSeq += 1;
    const topic = `arcus:${table}:${channelSeq}`;
    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) => handlerRef.current(payload),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [table, enabled]);
}
