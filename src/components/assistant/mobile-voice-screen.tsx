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
import { VoiceVisualizer } from "@/components/assistant/voice-visualizer";

/**
 * Full-screen, voice-first Arc experience for phones. Auto-opens once per
 * session (i.e. after sign-in) so you can talk to add and edit things hands
 * free, and collapses to a floating mic you can tap to bring it back.
 *
 * Rendered only on small screens by <AppShell>.
 */
export function MobileVoiceScreen() {
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
    stop,
  } = useVoiceChat();

  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // The reactive backdrop is drawn around this orb's live position.
  const orbRef = React.useRef<HTMLButtonElement | null>(null);

  // This surface is phones-only. Track it in JS too (not just the CSS gate in
  // AppShell) so its side effects never fire on desktop.
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // On mobile the voice agent leads: open it as soon as we land in the app
  // (after login or a fresh load). The (app) layout persists across in-app
  // navigation, so this fires once per real page load — not on every click.
  React.useEffect(() => {
    if (isMobile) setOpen(true);
  }, [isMobile]);

  // Lock background scroll while the overlay is up.
  React.useEffect(() => {
    if (!open || !isMobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, isMobile]);

  // Keep the latest exchange in view.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

  const close = React.useCallback(() => {
    stop();
    setOpen(false);
  }, [stop]);

  // Tapping the orb: interrupt playback, otherwise start/stop listening.
  const onOrbTap = React.useCallback(() => {
    if (status === "speaking") {
      stop();
      return;
    }
    toggleMic();
  }, [status, stop, toggleMic]);

  const amp = status === "listening" ? Math.min(level * 5, 1) : 0;

  if (!isMobile) return null;

  return (
    <>
      {/* Floating mic launcher (mobile) */}
      <AnimatePresence>
        {!open && (
          <motion.button
            key="mic-launcher"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onClick={() => setOpen(true)}
            aria-label="Open Arc voice assistant"
            className="fixed bottom-6 right-6 z-50 grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lift ring-1 ring-white/30 active:scale-95"
          >
            <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary-500/40" />
            <Mic className="h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Full-screen voice surface */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="voice-screen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[60] overflow-hidden bg-[#07060b] text-white"
          >
            {/* Living, audio-reactive backdrop */}
            <VoiceVisualizer status={status} level={level} targetRef={orbRef} />

            <div className="relative z-10 flex h-full flex-col">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 text-white shadow-lg shadow-primary-900/40">
                  <Sparkles className="h-4.5 w-4.5" />
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-semibold">Arc</p>
                  <p className="text-[11px] font-medium text-white/55">
                    Voice assistant
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setMuted((m) => !m)}
                  aria-label={muted ? "Unmute voice" : "Mute voice"}
                  className="grid h-10 w-10 place-items-center rounded-xl text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
                <button
                  onClick={close}
                  aria-label="Close voice assistant"
                  className="grid h-10 w-10 place-items-center rounded-xl text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Hero orb — centred inside the reactive ring */}
            <div
              className={cn(
                "flex items-center justify-center px-6",
                messages.length === 0 ? "flex-1" : "shrink-0 pt-3 pb-1",
              )}
            >
              <button
                ref={orbRef}
                onClick={onOrbTap}
                aria-label={
                  status === "listening" ? "Stop recording" : "Start talking"
                }
                className="relative grid h-44 w-44 place-items-center"
              >
                {/* Reactive outer rings */}
                <span
                  className={cn(
                    "absolute inset-0 rounded-full transition-transform duration-100",
                    status === "speaking" && "animate-ping",
                  )}
                  style={{
                    transform: `scale(${1 + amp * 0.55})`,
                    background:
                      "radial-gradient(circle, rgba(249,115,22,0.35), transparent 70%)",
                  }}
                />
                <span
                  className="absolute inset-6 rounded-full transition-transform duration-100"
                  style={{
                    transform: `scale(${1 + amp * 0.35})`,
                    background:
                      "radial-gradient(circle, rgba(251,146,60,0.45), transparent 72%)",
                  }}
                />

                {/* Core */}
                <motion.span
                  animate={
                    status === "listening"
                      ? { scale: 1 + amp * 0.14 }
                      : status === "idle"
                        ? { scale: [1, 1.04, 1] }
                        : status === "speaking"
                          ? { scale: [1, 1.07, 1] }
                          : { scale: 1 }
                  }
                  transition={
                    status === "idle"
                      ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" }
                      : status === "speaking"
                        ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" }
                        : { duration: 0.12 }
                  }
                  className={cn(
                    "relative grid h-28 w-28 place-items-center rounded-full text-white shadow-2xl ring-1 ring-white/20",
                    status === "listening"
                      ? "bg-gradient-to-br from-rose-500 to-primary-600 shadow-rose-900/50"
                      : "bg-gradient-to-br from-primary-400 to-primary-600 shadow-primary-900/50",
                  )}
                >
                  {status === "listening" ? (
                    <Square className="h-9 w-9" fill="currentColor" />
                  ) : status === "thinking" ? (
                    <Loader2 className="h-10 w-10 animate-spin" />
                  ) : status === "speaking" ? (
                    <Volume2 className="h-10 w-10" />
                  ) : (
                    <Mic className="h-10 w-10" />
                  )}
                </motion.span>
              </button>
            </div>

            {/* Conversation transcript (only once there's something to show) */}
            {messages.length > 0 && (
              <div
                ref={scrollRef}
                className="flex-1 min-h-0 space-y-3 overflow-y-auto px-5 pb-2"
              >
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
                          : "border border-white/10 bg-white/10 text-white/90 backdrop-blur-md",
                      )}
                    >
                      {m.content}
                      {m.events && m.events.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5 border-t border-white/15 pt-2">
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
                    <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-3.5 py-2.5 text-sm text-white/70 backdrop-blur-md">
                      <Loader2 className="h-4 w-4 animate-spin" /> Working on it…
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mx-5 mb-1 shrink-0 rounded-xl bg-rose-500/15 px-3.5 py-2.5 text-sm text-rose-200 ring-1 ring-rose-400/30">
                {error}
              </div>
            )}

            {/* Type fallback */}
            <div className="px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
              <form
                className="flex items-center gap-2"
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
                  className="h-12 w-full rounded-2xl border border-white/15 bg-white/10 px-4 text-sm text-white outline-none backdrop-blur-md transition placeholder:text-white/45 focus:border-primary-400/60 focus:bg-white/15 disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!text.trim() || busy}
                  aria-label="Send message"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-slate-900 transition active:scale-95 disabled:opacity-40"
                >
                  <Send className="h-5 w-5" />
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
