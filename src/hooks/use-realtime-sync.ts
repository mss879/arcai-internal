"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Reusable hook to subscribe to Supabase Postgres Realtime changes on a specific table
 * and trigger a router refresh to fetch the latest server data.
 */
export function useRealtimeSync(table: string) {
  const router = useRouter();

  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`realtime:${table}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          router.refresh();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table, router]);
}

/**
 * Subscribe to multiple tables simultaneously and refresh data.
 */
export function useRealtimeSyncTables(tables: string[]) {
  const router = useRouter();

  React.useEffect(() => {
    const supabase = createClient();
    const channels = tables.map((table) => {
      return supabase
        .channel(`realtime:${table}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          () => {
            router.refresh();
          },
        )
        .subscribe();
    });

    return () => {
      channels.forEach((channel) => {
        supabase.removeChannel(channel);
      });
    };
  }, [tables, router]);
}
