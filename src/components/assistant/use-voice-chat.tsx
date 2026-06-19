"use client";

import * as React from "react";
import { CheckCircle2, Eye, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The voice engine shared by both Arc surfaces — the desktop floating panel
 * and the full-screen mobile experience. It owns everything stateful about a
 * conversation: microphone capture, level metering + silence auto-stop,
 * transcription, the chat round-trip and spoken playback. The UIs that consume
 * it stay purely presentational.
 */

export type ToolEvent = {
  kind: "read" | "created" | "updated";
  label: string;
  href?: string;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  events?: ToolEvent[];
};

export type Status = "idle" | "listening" | "thinking" | "speaking";

const SILENCE_MS = 1500; // auto-stop this long after you STOP talking
const SPEECH_LEVEL = 0.04; // RMS above this counts as voice (gates out room noise)
const VOICE_FRAMES = 5; // need this many consecutive voiced frames to "arm"

// Phrases Whisper commonly invents from silence / room noise. If a whole
// transcript is just one of these, treat it as "nothing was said".
const HALLUCINATIONS = new Set([
  "",
  ".",
  "you",
  "bye",
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
]);

function looksLikeNoise(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[.!?,]+$/g, "").trim();
  return norm.length < 2 || HALLUCINATIONS.has(norm);
}

function pickMimeType(): { mime: string; ext: string } {
  const candidates: { mime: string; ext: string }[] = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "mp4" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  if (typeof MediaRecorder !== "undefined") {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    }
  }
  return { mime: "", ext: "webm" };
}

export type VoiceChat = {
  status: Status;
  messages: Message[];
  level: number;
  error: string | null;
  text: string;
  muted: boolean;
  busy: boolean;
  setText: (value: string) => void;
  setMuted: React.Dispatch<React.SetStateAction<boolean>>;
  toggleMic: () => void;
  sendText: (value: string) => void;
  stopListening: () => void;
  /** Stop capture + playback without wiping the transcript. */
  stop: () => void;
  /** Stop everything and clear the conversation. */
  reset: () => void;
};

export function useVoiceChat(): VoiceChat {
  const [status, setStatus] = React.useState<Status>("idle");
  const [muted, setMuted] = React.useState(false);
  const [text, setText] = React.useState("");
  const [level, setLevel] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);

  // Audio plumbing kept in refs so re-renders don't disturb capture.
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const hasSpokenRef = React.useRef(false);
  const lastLoudRef = React.useRef(0);
  const playerRef = React.useRef<HTMLAudioElement | null>(null);
  const mutedRef = React.useRef(muted);
  React.useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const busy = status === "thinking" || status === "speaking";

  const teardownCapture = React.useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  // Clean everything up on unmount.
  React.useEffect(() => {
    return () => {
      teardownCapture();
      playerRef.current?.pause();
    };
  }, [teardownCapture]);

  const speak = React.useCallback(async (reply: string) => {
    if (mutedRef.current || !reply.trim()) {
      setStatus("idle");
      return;
    }
    try {
      setStatus("speaking");
      const res = await fetch("/api/assistant/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      if (!res.ok) {
        setStatus("idle");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      playerRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setStatus("idle");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setStatus("idle");
      };
      await audio.play();
    } catch {
      setStatus("idle");
    }
  }, []);

  const runChat = React.useCallback(
    async (next: Message[]) => {
      setStatus("thinking");
      setError(null);
      try {
        const res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: next.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error || "Something went wrong.");
          setStatus("idle");
          return;
        }
        const reply: string = data.reply || "";
        const events: ToolEvent[] = data.events || [];
        setMessages([...next, { role: "assistant", content: reply, events }]);
        await speak(reply);
      } catch {
        setError("Could not reach the assistant.");
        setStatus("idle");
      }
    },
    [speak],
  );

  const sendText = React.useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || busy) return;
      setText("");
      const next: Message[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      void runChat(next);
    },
    [busy, messages, runChat],
  );

  const transcribeAndSend = React.useCallback(
    async (blob: Blob, ext: string) => {
      setStatus("thinking");
      try {
        const form = new FormData();
        form.append("audio", blob, `audio.${ext}`);
        const res = await fetch("/api/assistant/transcribe", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error || "Could not transcribe.");
          setStatus("idle");
          return;
        }
        const said: string = (data.text || "").trim();
        if (!said || looksLikeNoise(said)) {
          setStatus("idle");
          return;
        }
        const next: Message[] = [...messages, { role: "user", content: said }];
        setMessages(next);
        await runChat(next);
      } catch {
        setError("Could not transcribe audio.");
        setStatus("idle");
      }
    },
    [messages, runChat],
  );

  const stopListening = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const startListening = React.useCallback(async () => {
    setError(null);
    // Stop any in-progress playback first.
    playerRef.current?.pause();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked. Allow it in your browser.");
      return;
    }
    streamRef.current = stream;

    const { mime, ext } = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    );
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const spoke = hasSpokenRef.current;
      teardownCapture();
      const blob = new Blob(chunksRef.current, {
        type: mime || "audio/webm",
      });
      // Only transcribe if we actually detected speech — shipping silence is
      // exactly what makes Whisper invent text.
      if (spoke && blob.size > 0) void transcribeAndSend(blob, ext);
      else setStatus("idle");
    };

    // Level metering + silence auto-stop. If this fails, recording still
    // works — you just stop it yourself with the button.
    hasSpokenRef.current = false;
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      void ctx.resume(); // browsers often start it suspended after a click
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      lastLoudRef.current = Date.now();
      let voicedFrames = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(rms);

        const now = Date.now();
        if (rms > SPEECH_LEVEL) {
          // Sustained voice (not a one-frame clatter) counts as speech.
          voicedFrames++;
          lastLoudRef.current = now;
          if (voicedFrames >= VOICE_FRAMES) hasSpokenRef.current = true;
        } else {
          voicedFrames = 0;
        }

        // Only auto-stop AFTER you've actually started talking and then gone
        // quiet — never cut you off while you're still gathering your words.
        if (hasSpokenRef.current && now - lastLoudRef.current > SILENCE_MS) {
          stopListening();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Metering unavailable — let a manual stop send by assuming speech.
      hasSpokenRef.current = true;
    }

    recorder.start();
    setStatus("listening");
  }, [stopListening, teardownCapture, transcribeAndSend]);

  const toggleMic = React.useCallback(() => {
    if (status === "listening") stopListening();
    else if (!busy) void startListening();
  }, [status, busy, startListening, stopListening]);

  const stop = React.useCallback(() => {
    stopListening();
    playerRef.current?.pause();
    setStatus("idle");
  }, [stopListening]);

  const reset = React.useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
    setText("");
  }, [stop]);

  return {
    status,
    messages,
    level,
    error,
    text,
    muted,
    busy,
    setText,
    setMuted,
    toggleMic,
    sendText,
    stopListening,
    stop,
    reset,
  };
}

export function EventChip({ event }: { event: ToolEvent }) {
  const meta = {
    read: { icon: Eye, cls: "text-slate-500" },
    created: { icon: CheckCircle2, cls: "text-emerald-600" },
    updated: { icon: Pencil, cls: "text-primary-600" },
  }[event.kind];
  const Icon = meta.icon;
  const inner = (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.cls)}>
      <Icon className="h-3.5 w-3.5" />
      {event.label}
    </span>
  );
  return event.href ? (
    <a href={event.href} className="hover:underline">
      {inner}
    </a>
  ) : (
    inner
  );
}
