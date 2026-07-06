"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * One trailing debounce shared by every subscription on the page: a burst
 * of row changes (e.g. a drag re-positioning a whole kanban column writes
 * one row per card) coalesces into a single router.refresh() that lands
 * after the last write, instead of N full-page refetches racing the save.
 */
const REFRESH_DEBOUNCE_MS = 400;
const refreshers = new Set<() => void>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // Every registered refresher is the same app router — one call is enough.
    const refresh = refreshers.values().next().value;
    refresh?.();
  }, REFRESH_DEBOUNCE_MS);
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
