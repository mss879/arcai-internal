"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Mic,
  Square,
  X,
  Sparkles,
  Loader2,
  Send,
  Volume2,
  VolumeX,
  CheckCircle2,
  Eye,
  Pencil,
} from "lucide-react";

import { cn } from "@/lib/utils";

type ToolEvent = {
  kind: "read" | "created" | "updated";
  label: string;
  href?: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  events?: ToolEvent[];
};

type Status = "idle" | "listening" | "thinking" | "speaking";

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

export function VoiceAssistant({ firstName }: { firstName: string }) {
  const [open, setOpen] = React.useState(false);
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
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const mutedRef = React.useRef(muted);
  React.useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const busy = status === "thinking" || status === "speaking";

  // Auto-scroll the transcript.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

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

  const greeting = `Hi ${firstName}, I'm Arc. Tap the mic and ask me anything about your workspace — or to add a task or reminder.`;

  return (
    <>
      {/* Floating launcher */}
      <AnimatePresence>
        {!open && (
          <motion.button
            key="launcher"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onClick={() => setOpen(true)}
            aria-label="Open Arc voice assistant"
            className="fixed bottom-6 right-6 z-50 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lift ring-1 ring-white/30 transition hover:scale-105 active:scale-95"
          >
            <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary-500/40" />
            <Sparkles className="h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
            className="glass fixed bottom-6 right-6 z-50 flex max-h-[min(80vh,640px)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-white/40 shadow-lift"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 bg-white/60 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm">
                  <Sparkles className="h-4.5 w-4.5" />
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-semibold text-slate-900">Arc Assistant</p>
                  <p className="text-[11px] font-medium text-slate-500">
                    {status === "listening"
                      ? "Listening…"
                      : status === "thinking"
                        ? "Thinking…"
                        : status === "speaking"
                          ? "Speaking…"
                          : "Voice + workspace AI"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setMuted((m) => !m)}
                  aria-label={muted ? "Unmute voice" : "Mute voice"}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                >
                  {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => {
                    stopListening();
                    playerRef.current?.pause();
                    setStatus("idle");
                    setMessages([]);
                    setError(null);
                    setText("");
                    setOpen(false);
                  }}
                  aria-label="Close assistant"
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Transcript */}
            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
            >
              {messages.length === 0 && (
                <div className="rounded-2xl bg-white/70 p-4 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200/70">
                  {greeting}
                </div>
              )}

              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                      m.role === "user"
                        ? "bg-primary-600 text-white"
                        : "bg-white text-slate-700 ring-1 ring-slate-200/70",
                    )}
                  >
                    {m.content}
                    {m.events && m.events.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1.5 border-t border-slate-200/70 pt-2">
                        {m.events.map((ev, j) => (
                          <EventChip key={j} event={ev} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {status === "thinking" && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-sm text-slate-500 ring-1 ring-slate-200/70">
                    <Loader2 className="h-4 w-4 animate-spin" /> Working on it…
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-600 ring-1 ring-rose-200">
                  {error}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="border-t border-slate-200/70 bg-white/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMic}
                  disabled={busy}
                  aria-label={status === "listening" ? "Stop recording" : "Start talking"}
                  className={cn(
                    "relative grid h-12 w-12 shrink-0 place-items-center rounded-full text-white shadow-sm transition disabled:opacity-50",
                    status === "listening"
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "bg-gradient-to-br from-primary-500 to-primary-700 hover:brightness-110",
                  )}
                >
                  {status === "listening" ? (
                    <>
                      <span
                        className="absolute inset-0 rounded-full bg-rose-500/40"
                        style={{ transform: `scale(${1 + Math.min(level * 4, 1)})` }}
                      />
                      <Square className="relative h-5 w-5" fill="currentColor" />
                    </>
                  ) : status === "thinking" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Mic className="h-5 w-5" />
                  )}
                </button>

                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendText(text);
                  }}
                >
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={
                      status === "listening" ? "Listening…" : "Or type a message…"
                    }
                    disabled={status === "listening"}
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-primary-300 focus:ring-2 focus:ring-primary-100 disabled:bg-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={!text.trim() || busy}
                    aria-label="Send message"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700 disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function EventChip({ event }: { event: ToolEvent }) {
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
