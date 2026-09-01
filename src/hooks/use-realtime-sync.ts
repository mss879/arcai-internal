"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * One trailing debounce shared by every subscription on the page: a burst
 * of row changes (e.g. a drag re-positioning a whole kanban column writes
 * one row per card) coalesces into a single router.refresh() that lands
 * after the last write, instead of N full-page refetches racing the save.
 *
 * On top of the debounce sits a refresh-rate floor. The debounce alone only
 * merges writes that land within 400ms of each other — a server-side batch
 * job trickling rows (the hourly analytics mirror writes thousands, seconds
 * apart) slips between debounce windows and turns an open tab into a
 * continuous stream of full RSC refetches. Each refresh is a serverless
 * render, so the floor is what keeps a background sync from billing a
 * refresh per row.
 */
const REFRESH_DEBOUNCE_MS = 400;
const MIN_REFRESH_GAP_MS = 5_000;
const refreshers = new Set<() => void>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const wait = Math.max(
    REFRESH_DEBOUNCE_MS,
    lastRefreshAt + MIN_REFRESH_GAP_MS - Date.now(),
  );
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefreshAt = Date.now();
    // Every registered refresher is the same app router — one call is enough.
    const refresh = refreshers.values().next().value;
    refresh?.();
  }, wait);
}

function useDebouncedRefresh(): void {
  const router = useRouter();
  React.useEffect(() => {
    const refresh = () => router.refresh();
    refreshers.add(refresh);
    return () => {
      refreshers.delete(refresh);
      if (refreshers.size === 0 && refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };
  }, [router]);
}

/**
 * Reusable hook to subscribe to Supabase Postgres Realtime changes on a specific table
 * and trigger a (debounced) router refresh to fetch the latest server data.
 */
export function useRealtimeSync(table: string) {
  useDebouncedRefresh();

  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`realtime:${table}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table]);
}

/**
 * Subscribe to multiple tables over a single channel and refresh data.
 * Keyed on the joined table names so callers can pass inline array
 * literals without tearing the subscription down on every render.
 */
export function useRealtimeSyncTables(tables: string[]) {
  useDebouncedRefresh();

  const key = tables.join(",");
  React.useEffect(() => {
    const supabase = createClient();
    let channel = supabase.channel(`realtime:${key}`);
    for (const table of key.split(",")) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        scheduleRefresh,
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [key]);
}
