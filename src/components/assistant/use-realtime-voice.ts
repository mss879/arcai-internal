"use client";

/**
 * The live voice session (0104) — talking WITH Arcus, not at it.
 *
 * Browser↔OpenAI WebRTC: the server mints an ephemeral credential
 * (`/api/assistant/realtime/session`) and everything else happens here — the
 * microphone goes up as a track, Arcus's voice comes back as one, and the
 * data channel carries events both ways. Latency drops from four round trips
 * (record → transcribe → chat → speak) to a conversation with interruptions.
 *
 * Two rules keep it honest:
 *
 *   • TOOLS RUN AT HOME. A function_call arriving over the data channel is
 *     relayed to `/api/assistant/execute-tool`, which runs it on the user's
 *     own RLS session; only the JSON result travels back. The ephemeral key
 *     can talk to OpenAI, never to the database.
 *   • THE THREAD IS STILL THE THREAD. Finished exchanges are committed into
 *     the same conversation store the classic pipeline writes
 *     (`onTurn`), and artifacts surface mid-conversation through the same
 *     upsert-by-id path (`onArtifacts`) — the stage cannot tell which engine
 *     produced a panel, which is the point.
 *
 * Any failure tears down cleanly and reports through `error`; the classic
 * whisper→chat→TTS loop is untouched and takes the very next interaction.
 */

import * as React from "react";

import type { Artifact } from "@/lib/assistant-artifacts";
import type { AssistantCard } from "@/lib/assistant-cards";

export type RealtimeVoice = {
  live: boolean;
  connecting: boolean;
  error: string | null;
  /** Arcus's live output level, 0..1ish — drives the core while live. */
  level: number;
  /** True while Arcus is audibly responding. */
  speaking: boolean;
  start: () => Promise<void>;
  stop: () => void;
};

type ServerEvent = {
  type: string;
  // The envelope varies by event; only the fields used below are typed.
  name?: string;
  call_id?: string;
  arguments?: string;
  transcript?: string;
  delta?: string;
  item?: { id?: string; role?: string };
  error?: { message?: string };
};

const BASE = "https://api.openai.com/v1";

export function useRealtimeVoice({
  enabled,
  onArtifacts,
  onTurn,
}: {
  enabled: boolean;
  onArtifacts: (artifacts: Artifact[]) => void;
  onTurn: (turn: {
    user: string;
    assistant: string;
    artifacts: Artifact[];
    cards: AssistantCard[];
  }) => void;
}): RealtimeVoice {
  const [live, setLive] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [speaking, setSpeaking] = React.useState(false);

  const pcRef = React.useRef<RTCPeerConnection | null>(null);
  const micRef = React.useRef<MediaStream | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const meterRafRef = React.useRef<number | null>(null);
  const meterCtxRef = React.useRef<AudioContext | null>(null);

  // The exchange being assembled from transcript events.
  const turnRef = React.useRef({
    user: "",
    assistant: "",
    artifacts: [] as Artifact[],
    cards: [] as AssistantCard[],
  });

  const stop = React.useCallback(() => {
    if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    void meterCtxRef.current?.close().catch(() => {});
    meterCtxRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    setLive(false);
    setConnecting(false);
    setSpeaking(false);
    setLevel(0);
  }, []);

  // The surface disabling itself (settings toggle, unmount) ends the call.
  React.useEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled, stop]);

  const start = React.useCallback(async () => {
    if (!enabled || pcRef.current) return;
    setConnecting(true);
    setError(null);
    try {
      // 1. The credential, with the current page for the situational line.
      const sessionRes = await fetch("/api/assistant/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            pathname: window.location.pathname,
            title: document.title,
          },
        }),
      });
      const session = await sessionRes.json();
      if (!sessionRes.ok || !session?.clientSecret) {
        throw new Error(session?.error || "Could not start the live session.");
      }

      // 2. The peer connection: mic up, Arcus back, events both ways.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      if (!audioRef.current) {
        const el = new Audio();
        el.autoplay = true;
        audioRef.current = el;
      }
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream || !audioRef.current) return;
        audioRef.current.srcObject = stream;
        void audioRef.current.play().catch(() => {});

        // Meter Arcus's own voice so the core moves with it — the same
        // honesty rule as the classic player's analyser.
        try {
          const ctx = new AudioContext();
          meterCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          const tick = () => {
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sum += v * v;
            }
            setLevel(Math.sqrt(sum / buf.length));
            meterRafRef.current = requestAnimationFrame(tick);
          };
          meterRafRef.current = requestAnimationFrame(tick);
        } catch {
          // The call works unmetered.
        }
      };

      const channel = pc.createDataChannel("oai-events");
      channel.onmessage = (message) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        void handleEvent(event, channel);
      };

      const handleEvent = async (
        event: ServerEvent,
        ch: RTCDataChannel,
      ): Promise<void> => {
        switch (event.type) {
          case "response.created":
            setSpeaking(true);
            break;
          case "response.done": {
            setSpeaking(false);
            const turn = turnRef.current;
            if (turn.user || turn.assistant) {
              onTurn({ ...turn });
              turnRef.current = {
                user: "",
                assistant: "",
                artifacts: [],
                cards: [],
              };
            }
            break;
          }
          case "conversation.item.input_audio_transcription.completed":
            if (event.transcript) {
              turnRef.current.user = [turnRef.current.user, event.transcript]
                .filter(Boolean)
                .join(" ");
            }
            break;
          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done":
            if (event.transcript) {
              turnRef.current.assistant = [
                turnRef.current.assistant,
                event.transcript,
              ]
                .filter(Boolean)
                .join(" ");
            }
            break;
          case "response.function_call_arguments.done": {
            // The whole reason the live session can DO anything: relay home,
            // run under RLS, return the result over the channel.
            const name = event.name ?? "";
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(event.arguments || "{}");
            } catch {
              // Malformed arguments read as empty; the tool will say so.
            }
            let output: unknown = { ok: false, error: "Tool relay failed." };
            try {
              const res = await fetch("/api/assistant/execute-tool", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, args }),
              });
              const data = await res.json();
              output = data.content ?? output;
              if (Array.isArray(data.artifacts) && data.artifacts.length) {
                turnRef.current.artifacts.push(...data.artifacts);
                onArtifacts(data.artifacts);
              }
              if (data.card) turnRef.current.cards.push(data.card);
            } catch {
              // The failure text goes back to the model as the output.
            }
            ch.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify(output),
                },
              }),
            );
            ch.send(JSON.stringify({ type: "response.create" }));
            break;
          }
          case "error":
            setError(event.error?.message ?? "The live session hit an error.");
            break;
        }
      };

      // 3. SDP exchange. GA path first, beta fallback — mirroring the mint.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpHeaders = {
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp",
      };
      let answerRes = await fetch(
        `${BASE}/realtime/calls?model=${encodeURIComponent(session.model)}`,
        { method: "POST", headers: sdpHeaders, body: offer.sdp },
      );
      if (!answerRes.ok) {
        answerRes = await fetch(
          `${BASE}/realtime?model=${encodeURIComponent(session.model)}`,
          {
            method: "POST",
            headers: { ...sdpHeaders, "OpenAI-Beta": "realtime=v1" },
            body: offer.sdp,
          },
        );
      }
      if (!answerRes.ok) {
        throw new Error("The voice service refused the connection.");
      }
      await pc.setRemoteDescription({
        type: "answer",
        sdp: await answerRes.text(),
      });

      setConnecting(false);
      setLive(true);
    } catch (err) {
      stop();
      setError(
        err instanceof Error ? err.message : "Could not start the live session.",
      );
    }
  }, [enabled, onArtifacts, onTurn, stop]);

  return { live, connecting, error, level, speaking, start, stop };
}
