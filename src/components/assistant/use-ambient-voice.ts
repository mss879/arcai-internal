"use client";

/**
 * Arcus speaks unprompted (0104) — terminal only, off by default.
 *
 * The single most JARVIS behaviour in the app, and the one most capable of
 * getting the whole assistant muted forever, which is why every line here is
 * a brake:
 *
 *   • only importance ≥ 3 events, arriving over realtime, on the terminal,
 *     with the setting deliberately switched on;
 *   • never during quiet hours — the SAME `inQuietHours` the push nudges
 *     use, imported, not reimplemented;
 *   • a daily spoken budget separate from the push quota (a voice in the
 *     room and a phone buzz are different interruptions);
 *   • never re-speak: `surfaced_via` gains 'spoken' after the utterance, and
 *     only events born after this session mounted qualify, so a reload never
 *     replays the morning;
 *   • never over anyone: it waits for `status === "idle"`, holds at most ONE
 *     queued utterance, and drops the rest — a backlog of announcements is a
 *     answering machine, not a butler.
 *
 * The utterance itself goes through `chat.speak()`, which owns the player,
 * the meter and the status transition — so the wake word suspends itself
 * while Arcus talks, exactly as for any reply.
 */

import * as React from "react";

import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import type { Status } from "@/components/assistant/use-voice-chat";
import { inQuietHours } from "@/lib/assistant/quiet-hours";
import { createClient } from "@/lib/supabase/client";

const DAILY_SPOKEN_BUDGET = 6;

type SpokenEvent = {
  id: string;
  title: string;
  body: string | null;
  importance: number;
  created_at: string;
  surfaced_via: string[] | null;
};

export function useAmbientVoice({
  enabled,
  status,
  speak,
  timezone,
  quietStart,
  quietEnd,
  honorific,
}: {
  enabled: boolean;
  status: Status;
  speak: (text: string) => Promise<void>;
  timezone: string;
  quietStart: string;
  quietEnd: string;
  honorific: string;
}): void {
  // Only events born after this session started — a reload must not replay
  // the day's alerts to an empty room.
  const mountedAtRef = React.useRef(new Date().toISOString());
  const pendingRef = React.useRef<SpokenEvent | null>(null);
  const speakingRef = React.useRef(false);
  const statusRef = React.useRef(status);
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const trySpeak = React.useCallback(async () => {
    const event = pendingRef.current;
    if (!event || speakingRef.current) return;
    if (statusRef.current !== "idle") return;
    if (inQuietHours(timezone, quietStart, quietEnd)) return;

    const supabase = createClient();
    speakingRef.current = true;
    pendingRef.current = null;
    try {
      // Spend from the daily budget with a conditional-ish read-then-write;
      // a lost race here costs one extra utterance, not a runaway voice.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data: config } = await supabase
        .from("assistant_config")
        .select("ambient_spoken_on, ambient_spoken_count")
        .eq("user_id", user.id)
        .maybeSingle();
      const today = new Date().toISOString().slice(0, 10);
      const used =
        config?.ambient_spoken_on === today ? config.ambient_spoken_count : 0;
      if (used >= DAILY_SPOKEN_BUDGET) return;

      await supabase
        .from("assistant_config")
        .update({ ambient_spoken_on: today, ambient_spoken_count: used + 1 })
        .eq("user_id", user.id);

      // Mark BEFORE speaking: if playback dies midway the event stays
      // silenced, which is the safe direction for an interrupting feature.
      await supabase
        .from("assistant_events")
        .update({
          surfaced_via: [...(event.surfaced_via ?? []), "spoken"],
        })
        .eq("id", event.id);

      const address = honorific ? `${honorific}, ` : "";
      await speak(
        `${address}${event.title}${event.body ? `. ${event.body}` : ""}`,
      );
    } catch {
      // A silent alert is an alert the ambient stage still shows.
    } finally {
      speakingRef.current = false;
    }
  }, [speak, timezone, quietStart, quietEnd, honorific]);

  const onEvent = React.useCallback(
    (payload: { new?: unknown }) => {
      if (!enabled) return;
      const row = payload.new as SpokenEvent | undefined;
      if (!row?.id || !row.title) return;
      if ((row.importance ?? 0) < 3) return;
      if (row.created_at <= mountedAtRef.current) return;
      if (row.surfaced_via?.includes("spoken")) return;
      // One in the chamber, everything else dropped — the visual feed keeps
      // the overflow.
      if (!pendingRef.current) pendingRef.current = row;
      void trySpeak();
    },
    [enabled, trySpeak],
  );

  useArcusRealtime("assistant_events", onEvent, enabled);

  // The queued utterance waits for the room to go quiet.
  React.useEffect(() => {
    if (status === "idle" && pendingRef.current) void trySpeak();
  }, [status, trySpeak]);
}
