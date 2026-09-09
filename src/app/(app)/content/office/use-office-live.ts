"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import type {
  OfficeDelta,
  OfficeEventRow,
  OfficeMissionRow,
  OfficeSnapshot,
  OfficeTaskRow,
} from "@/lib/agents/office-types";

import { driveOffice } from "../office-actions";
import { useDriveCarousels } from "../use-drive-carousels";

/** How often the open page nudges the office forward. Every poll is one
 * serverless invocation that polls a couple of responses and may start one. */
const DRIVE_MS = 5_000;
const EVENTS_KEEP = 300;

/**
 * Keep the office snapshot alive while the page is open (0130).
 *
 * Three sources feed one local state: Supabase Realtime rows (instant),
 * the `driveOffice` heartbeat (which also advances the runtime and returns
 * what changed), and a fresh server render when the page refreshes. Nothing
 * here calls `router.refresh()` per event — that would re-mount the floor
 * mid-walk. One debounced refresh fires when a mission lands in review, so
 * the Calendar and Publishing tabs catch up.
 */
export function useOfficeLive(initial: OfficeSnapshot, enabled: boolean) {
  const router = useRouter();
  const [snapshot, setSnapshot] = React.useState(initial);
  const [nowMs, setNowMs] = React.useState(() => Date.parse(initial.loadedAt) || 0);

  // A fresh server render wins; realtime and the poll re-apply on top. This
  // is the "adjust state when a prop changes" shape, not an effect.
  const [seenInitial, setSeenInitial] = React.useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setSnapshot(initial);
  }

  // A one-second clock for elapsed timers and the filler robots.
  React.useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [enabled]);

  const mergeTask = React.useCallback((row: OfficeTaskRow) => {
    setSnapshot((prev) => {
      const tasks = prev.tasks.some((t) => t.id === row.id) ? prev.tasks.map((t) => (t.id === row.id ? row : t)) : [...prev.tasks, row];
      return { ...prev, tasks };
    });
  }, []);

  const mergeMission = React.useCallback((row: OfficeMissionRow) => {
    setSnapshot((prev) => {
      const missions = prev.missions.some((m) => m.id === row.id)
        ? prev.missions.map((m) => (m.id === row.id ? row : m))
        : [row, ...prev.missions];
      return { ...prev, missions };
    });
  }, []);

  const mergeEvents = React.useCallback((rows: OfficeEventRow[]) => {
    if (!rows.length) return;
    setSnapshot((prev) => {
      const seen = new Set(prev.events.map((e) => e.id));
      const fresh = rows.filter((e) => !seen.has(e.id));
      if (!fresh.length) return prev;
      const events = [...prev.events, ...fresh].sort((a, b) => a.id - b.id).slice(-EVENTS_KEEP);
      return { ...prev, events, lastEventId: Math.max(prev.lastEventId, ...fresh.map((e) => e.id)) };
    });
  }, []);

  useArcusRealtime(
    "office_events",
    (payload) => {
      const row = payload.new as OfficeEventRow | undefined;
      if (row && typeof row.id === "number") mergeEvents([row]);
    },
    enabled && snapshot.ready,
  );
  useArcusRealtime(
    "office_tasks",
    (payload) => {
      const row = payload.new as OfficeTaskRow | undefined;
      if (row?.id) mergeTask(row);
    },
    enabled && snapshot.ready,
  );
  useArcusRealtime(
    "office_missions",
    (payload) => {
      const row = payload.new as OfficeMissionRow | undefined;
      if (row?.id) mergeMission(row);
    },
    enabled && snapshot.ready,
  );

  // The heartbeat: non-overlapping, visibility-gated, and only while there is
  // something to drive (or a timer could be due — the server checks cheaply).
  const lastEventRef = React.useRef(snapshot.lastEventId);
  React.useEffect(() => {
    lastEventRef.current = snapshot.lastEventId;
  }, [snapshot.lastEventId]);

  const applyDelta = React.useCallback(
    (delta: OfficeDelta) => {
      setSnapshot((prev) => {
        const taskMap = new Map(prev.tasks.map((t) => [t.id, t] as const));
        for (const t of delta.tasks) taskMap.set(t.id, t);
        const missionMap = new Map(prev.missions.map((m) => [m.id, m] as const));
        for (const m of delta.missions) missionMap.set(m.id, m);
        const carouselMap = new Map(prev.carousels.map((c) => [c.id, c] as const));
        for (const c of delta.carousels) carouselMap.set(c.id, c);
        return {
          ...prev,
          tasks: [...taskMap.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
          missions: [...missionMap.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
          carousels: [...carouselMap.values()],
          spend: delta.spend,
        };
      });
      mergeEvents(delta.events);
    },
    [mergeEvents],
  );

  const active = snapshot.ready && snapshot.tasks.some((t) => ["queued", "ready", "running"].includes(t.status));
  const hasTimers = snapshot.ready && snapshot.schedules.some((s) => s.is_active);

  React.useEffect(() => {
    if (!enabled || (!active && !hasTimers)) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await driveOffice({ sinceEventId: lastEventRef.current });
        if (!cancelled && res.ok) applyDelta(res.delta);
      } catch {
        // transient — the next tick retries
      } finally {
        inFlight = false;
      }
    };
    void tick();
    // Timers alone need a much slower heartbeat than live work.
    const id = setInterval(() => void tick(), active ? DRIVE_MS : 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, active, hasTimers, applyDelta]);

  // Slides render through the existing carousel pipeline; keep it moving.
  useDriveCarousels(enabled && snapshot.carousels.some((c) => c.status === "rendering" || c.status === "copywriting"));

  // One refresh when a mission lands with a person, so the other tabs' props
  // (calendar, publishing) catch up without the floor re-mounting per event.
  const landedRef = React.useRef(new Set(initial.missions.filter((m) => m.status === "review" || m.status === "done").map((m) => m.id)));
  React.useEffect(() => {
    const landed = snapshot.missions.filter((m) => (m.status === "review" || m.status === "done") && !landedRef.current.has(m.id));
    if (!landed.length) return;
    for (const m of landed) landedRef.current.add(m.id);
    const id = setTimeout(() => router.refresh(), 800);
    return () => clearTimeout(id);
  }, [snapshot.missions, router]);

  return { snapshot, nowMs, setSnapshot };
}
