"use client";

/**
 * The voice settings the browser needs to know about (0101 → 0104).
 *
 * `assistant_config` is read server-side for the prompt, but hands-free, the
 * wake word, the honorific and the ack phrase are decisions the CLIENT acts
 * on — one keeps the microphone open after a reply, one keeps a recogniser
 * running, two shape what Arcus says out loud the moment it is opened or
 * called by name.
 *
 * Two-step select, and the order matters: the 0104 columns are asked for
 * first, and if that select errors (migration not yet run) the 0101 subset
 * is asked for instead. Without the fallback, a workspace one migration
 * behind loses its wake word entirely — a select naming a missing column
 * fails as a whole, not per column. Silent on total failure, as ever: an
 * assistant that will not load because it could not read a preference is a
 * worse trade than one that needs a tap.
 */

import * as React from "react";

import { createClient } from "@/lib/supabase/client";

export type ArcusVoiceConfig = {
  handsFree: boolean;
  wakeWord: boolean;
  personaName: string;
  /** "sir" — what the spoken lines address the user as. Empty for none. */
  honorific: string;
  /** What it says the instant the wake word lands. */
  wakeAck: string;
  /** The standby dashboard on the idle stage — opt-in. */
  ambientStage: boolean;
  /** Spoken alerts on the terminal (0104) — off by default, deliberately. */
  ambientVoice: boolean;
  /** Which voice loop: the classic pipeline, or the live WebRTC session. */
  voiceEngine: "classic" | "realtime";
  timezone: string;
  quietStart: string;
  quietEnd: string;
  loaded: boolean;
};

const DEFAULTS: ArcusVoiceConfig = {
  handsFree: false,
  wakeWord: false,
  personaName: "Arcus",
  honorific: "",
  wakeAck: "Yes, sir?",
  ambientStage: false,
  ambientVoice: false,
  voiceEngine: "classic",
  timezone: "Asia/Colombo",
  quietStart: "21:30",
  quietEnd: "07:30",
  loaded: false,
};

export function useArcusConfig(enabled = true): ArcusVoiceConfig {
  const [config, setConfig] = React.useState<ArcusVoiceConfig>(DEFAULTS);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        // Full 0104 shape first…
        const full = await supabase
          .from("assistant_config")
          .select(
            "hands_free, wake_word, persona_name, honorific, wake_ack, ambient_stage, ambient_voice, voice_engine, timezone, quiet_start, quiet_end",
          )
          .eq("user_id", user.id)
          .maybeSingle();

        // …then the 0101 subset when the new columns don't exist yet.
        const data = full.error
          ? (
              await supabase
                .from("assistant_config")
                .select(
                  "hands_free, wake_word, persona_name, timezone, quiet_start, quiet_end",
                )
                .eq("user_id", user.id)
                .maybeSingle()
            ).data
          : full.data;

        if (cancelled) return;
        const row = (data ?? null) as
          | (Partial<
              Record<
                | "honorific"
                | "wake_ack"
                | "persona_name"
                | "timezone"
                | "quiet_start"
                | "quiet_end",
                string
              >
            > &
              Partial<
                Record<"hands_free" | "wake_word" | "ambient_stage" | "ambient_voice", boolean>
              > &
              Partial<Record<"voice_engine", string>>)
          | null;
        setConfig({
          handsFree: row?.hands_free ?? false,
          wakeWord: row?.wake_word ?? false,
          personaName: row?.persona_name || "Arcus",
          honorific: row?.honorific?.trim() ?? "",
          wakeAck: row?.wake_ack?.trim() || "Yes, sir?",
          ambientStage: row?.ambient_stage ?? false,
          ambientVoice: row?.ambient_voice ?? false,
          voiceEngine: row?.voice_engine === "realtime" ? "realtime" : "classic",
          timezone: row?.timezone || "Asia/Colombo",
          quietStart: row?.quiet_start || "21:30",
          quietEnd: row?.quiet_end || "07:30",
          loaded: true,
        });
      } catch {
        setConfig({ ...DEFAULTS, loaded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return config;
}
