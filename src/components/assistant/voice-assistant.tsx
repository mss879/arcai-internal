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
} from "lucide-react";

import { cn } from "@/lib/utils";
import { EventChip, useVoiceChat } from "@/components/assistant/use-voice-chat";

export function VoiceAssistant({ firstName }: { firstName: string }) {
  const [open, setOpen] = React.useState(false);
  const {
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
    reset,
  } = useVoiceChat();

  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-scroll the transcript.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

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
                    reset();
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
