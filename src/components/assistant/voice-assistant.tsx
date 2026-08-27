"use client";

/**
 * Arc Studio's host — the thing that decides which shape the assistant takes.
 *
 * Three modes, one engine:
 *   bubble  the draggable launcher (unchanged, including where you left it)
 *   dock    the corner panel for a quick question — now resizable, remembered
 *   full    the full-screen workspace
 *
 * Clicking the bubble opens FULL by default. That is the whole point: the old
 * behaviour — a tiny panel you can't read your conversation in — is what the
 * user complained about. Dock is still there, but it is now a deliberate
 * choice, and whichever you last used is what the bubble reopens.
 *
 * `useVoiceChat()` is called EXACTLY ONCE here and passed down. Two instances
 * would mean two microphones and two histories, so changing mode must never
 * remount the engine — it only changes what is rendered around it.
 *
 * Everything global (hotkeys, portals, the body-scroll lock) is gated on a
 * real `matchMedia` check, because `AppShell` hides this component with
 * `hidden lg:block` — which is CSS, so it is still MOUNTED on phones.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useMotionValue } from "motion/react";
import {
  Loader2,
  Maximize2,
  Mic,
  Send,
  Settings2,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { EventChip, useVoiceChat } from "@/components/assistant/use-voice-chat";
import { AssistantCardView } from "@/components/assistant/assistant-card";
import { AssistantWorkspace } from "@/components/assistant/assistant-workspace";
import { StudioSettings } from "@/components/assistant/studio-settings";
import { useAssistantInbox } from "@/components/assistant/use-assistant-inbox";
import { useArcusConfig } from "@/components/assistant/use-arcus-config";
import { useAmbientVoice } from "@/components/assistant/use-ambient-voice";
import { useRealtimeVoice } from "@/components/assistant/use-realtime-voice";
import { useTerminal } from "@/components/assistant/use-terminal";
import { toast } from "sonner";

import { useVoiceClip } from "@/components/assistant/use-voice-clips";
import {
  requestMicrophone,
  useWakeWord,
} from "@/components/assistant/use-wake-word";
import { inQuietHours } from "@/lib/assistant/quiet-hours";
import { artifactIcon } from "@/components/assistant/preview/artifact-format";
import {
  DESKTOP_QUERY,
  DOCK_MAX_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  clamp,
  readLayout,
  readPref,
  STUDIO_KEYS,
  useIsEmbedded,
  useMediaQuery,
  writePref,
  type StudioMode,
} from "@/components/assistant/studio-store";

/**
 * Studio claims Cmd/Ctrl+K on `window` in the CAPTURE phase.
 *
 * Global search already binds the same chord on `document` during bubbling
 * (`global-search.tsx`), so capturing here and calling `stopPropagation()`
 * means it never sees the event. Kept as a constant so the binding can be
 * handed back to search in one edit if that is ever the preference.
 */
const STUDIO_HOTKEY = "k";

export function VoiceAssistant({
  firstName,
  isTerminal = false,
}: {
  firstName: string;
  /** This browser is the registered Arcus terminal (0104). */
  isTerminal?: boolean;
}) {
  const chat = useVoiceChat();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const embedded = useIsEmbedded();
  // Never inside the preview canvas: a framed copy of the app would raise a
  // second badge for the same events behind the one already on screen.
  const inbox = useAssistantInbox(desktop && !embedded);
  const arcus = useArcusConfig(desktop && !embedded);

  // The two lines that must be INSTANT, synthesised ahead of time (0104).
  // The greeting is composed once per session from the hour and the persona's
  // honorific — "Good evening, sir. How may I assist you today?" — which is
  // the whole JARVIS handshake: it speaks first, and it speaks immediately.
  const greetingText = React.useMemo(() => {
    if (!arcus.loaded || !desktop || embedded) return null;
    const who = arcus.honorific || firstName;
    // The exact line that was asked for — a greeting is a signature, not a
    // place for the model of the day to improvise.
    return `Hi ${who}, how may I help you today?`;
  }, [arcus.loaded, arcus.honorific, desktop, embedded, firstName]);
  const greetingUrl = useVoiceClip(greetingText);
  const wakeAckUrl = useVoiceClip(
    arcus.loaded && (arcus.wakeWord || isTerminal) && desktop && !embedded
      ? arcus.wakeAck
      : null,
  );

  const [mode, setMode] = React.useState<StudioMode>("bubble");
  const [mounted, setMounted] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [dock, setDock] = React.useState({ w: 400, h: 640 });
  const [promoteArtifactId, setPromoteArtifactId] = React.useState<
    string | null
  >(null);

  const launcherRef = React.useRef<HTMLButtonElement | null>(null);
  const dockScrollRef = React.useRef<HTMLDivElement | null>(null);
  const dockInputRef = React.useRef<HTMLInputElement | null>(null);
  /** Which mode the bubble reopens into. */
  const lastOpenModeRef = React.useRef<StudioMode>("full");
  /** The CURRENT mode, for callbacks that must not rebuild per mode change. */
  const modeRef = React.useRef<StudioMode>("bubble");
  React.useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const { setMuted, stop } = chat;

  // The engine's idleness, as a ref: `open` fires inside a click and needs
  // the CURRENT status without rebuilding itself on every status change.
  const chatIdleRef = React.useRef(true);
  React.useEffect(() => {
    chatIdleRef.current = chat.status === "idle";
  }, [chat.status]);

  // Restore preferences after mount (never during render — the app is
  // server-rendered and reading storage in render is a hydration mismatch).
  React.useEffect(() => {
    setMounted(true);
    const layout = readLayout();
    setDock(layout.dock);
    const saved = readPref<StudioMode>(STUDIO_KEYS.mode, "full");
    lastOpenModeRef.current = saved === "dock" ? "dock" : "full";
    if (readPref<boolean>(STUDIO_KEYS.muted, false)) setMuted(true);
  }, [setMuted]);

  // Mute now persists, so a user who silenced Arc stays silenced.
  React.useEffect(() => {
    if (!mounted) return;
    writePref(STUDIO_KEYS.muted, chat.muted);
  }, [chat.muted, mounted]);

  const { playClip, speak } = chat;
  const open = React.useCallback(
    (next: "dock" | "full") => {
      lastOpenModeRef.current = next;
      writePref(STUDIO_KEYS.mode, next);
      setMode((prev) => {
        // Greet on a FRESH open (bubble -> anything), inside the click's own
        // user gesture so autoplay never objects. Mode hops (dock <-> full)
        // stay silent — a butler greets you at the door, not in every room.
        if (prev === "bubble" && chatIdleRef.current) {
          if (greetingUrl) void playClip(greetingUrl);
          else if (greetingText) void speak(greetingText);
        }
        return next;
      });
    },
    [greetingUrl, greetingText, playClip, speak],
  );

  /**
   * "Hey Arcus" (0104).
   *
   * Waking opens the full workspace and immediately starts listening, so the
   * whole interaction from across the room is: say its name, then say what
   * you want. Suspended while Arcus is busy — see `use-wake-word` for why
   * hearing itself would otherwise loop.
   */
  const { setHandsFree, listenWhenQuiet } = chat;
  // Per-DEVICE mute for the wake microphone (0104-fix): one click in the
  // rail, no settings write — and it SURVIVES reloads, because "the mic
  // grabs my system every time I open the app" is only solved if muting it
  // once actually sticks. While the wake word is armed the mic IS held —
  // that is what always-listening means — so the off switch stays one
  // visible tap away and stays off until the user arms it again.
  const [wakePaused, setWakePaused] = React.useState(false);
  React.useEffect(() => {
    if (readPref<boolean>(STUDIO_KEYS.wakePaused, false)) setWakePaused(true);
  }, []);
  const toggleWakePaused = React.useCallback(() => {
    setWakePaused((p) => {
      writePref(STUDIO_KEYS.wakePaused, !p);
      return !p;
    });
  }, []);
  // The terminal sleeps through the user's own quiet hours (0104-fix): the
  // same window that already silences spoken alerts releases the microphone
  // entirely, so "the mic is on all the time" is at least never true at
  // night. Re-checked once a minute; a minute of drift at the boundary is
  // invisible, a re-render per second is not.
  const [minuteTick, setMinuteTick] = React.useState(0);
  React.useEffect(() => {
    if (!isTerminal || !arcus.loaded) return;
    const timer = window.setInterval(
      () => setMinuteTick((n) => n + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [isTerminal, arcus.loaded]);
  const wakeAsleep = React.useMemo(() => {
    void minuteTick; // recompute each minute
    if (!isTerminal || !arcus.loaded) return false;
    return inQuietHours(arcus.timezone, arcus.quietStart, arcus.quietEnd);
  }, [isTerminal, arcus.loaded, arcus.timezone, arcus.quietStart, arcus.quietEnd, minuteTick]);
  // The live voice session (0104): opt-in via settings, browser↔OpenAI
  // WebRTC, tools relayed home under the user's own session. Its turns land
  // in the SAME thread store — the stage cannot tell which engine served it.
  const realtime = useRealtimeVoice({
    enabled:
      arcus.loaded && arcus.voiceEngine === "realtime" && desktop && !embedded,
    onArtifacts: chat.ingestArtifacts,
    onTurn: chat.ingestTurn,
  });

  const busy = chat.status !== "idle" || realtime.live || realtime.connecting;
  const {
    listening: wakeListening,
    state: wakeState,
    lastHeard: wakeHeard,
    retry: retryWake,
  } = useWakeWord(
    // The terminal listens BY DEFINITION — that is what registering the
    // machine means. Everywhere else the per-user toggle decides. The rail's
    // pause light silences either without touching settings, and quiet hours
    // put the terminal's microphone to sleep for the night.
    (arcus.wakeWord || isTerminal) &&
      desktop &&
      !embedded &&
      !wakePaused &&
      !wakeAsleep,
    busy,
    React.useCallback(() => {
      // A FRESH wake — Arcus was closed — gets the full greeting ("Hi sir,
      // how may I help you today?"), the same handshake a click gets: being
      // called by name across the room IS the front door. Waking it while
      // it is already open gets the short configurable ack instead.
      const fresh = modeRef.current === "bubble";
      lastOpenModeRef.current = "full";
      writePref(STUDIO_KEYS.mode, "full");
      setMode("full");
      // Hands-free from a wake word is implied: someone who called across the
      // room is not about to reach for the mic button for their next turn.
      setHandsFree(true);
      // The spoken line queues BEHIND anything already being said, and
      // `listenWhenQuiet` opens the mic only once Arcus has gone silent —
      // never over its own voice, and only ever OPENS: the old toggle could
      // race the hands-free auto-arm and flip the mic straight back off.
      const engageMic =
        arcus.voiceEngine === "realtime"
          ? () => void realtime.start()
          : () => void listenWhenQuiet();
      const clipUrl = (fresh && greetingUrl) || wakeAckUrl;
      if (clipUrl) void playClip(clipUrl).then(engageMic);
      else engageMic();
    }, [setHandsFree, listenWhenQuiet, greetingUrl, wakeAckUrl, playClip, arcus.voiceEngine, realtime]),
    // The terminal keeps listening across window switches — that is what
    // registering the machine MEANS — and pins the mic channel open so it
    // stops chirping headsets on every recogniser restart.
    isTerminal,
  );

  // "MIC BLOCKED — fix": SpeechRecognition cannot re-prompt after a refusal,
  // but getUserMedia can; a grant is followed by reviving the recogniser.
  const onWakeFix = React.useCallback(async () => {
    const res = await requestMicrophone();
    if (res.ok) {
      toast.success("Microphone ready — listening for \u201cHey Arcus\u201d.");
      retryWake();
    } else {
      toast.error(res.error);
    }
  }, [retryWake]);

  // Hold the screen awake while this machine's job is to listen.
  useTerminal(isTerminal && wakeListening);

  // While a live call is up, every surface reads the CALL's state: the core
  // pulses with Arcus's actual voice, and the universal gestures — tap the
  // core, stop, cancel — end the call instead of poking the idle classic
  // engine underneath it. One object swap; no surface knows the difference.
  const chatForUi = React.useMemo(() => {
    if (!realtime.live && !realtime.connecting) return chat;
    return {
      ...chat,
      status: (realtime.speaking ? "speaking" : "listening") as typeof chat.status,
      level: realtime.level,
      busy: true,
      stop: realtime.stop,
      cancel: realtime.stop,
      toggleMic: realtime.stop,
    };
  }, [chat, realtime.live, realtime.connecting, realtime.speaking, realtime.level, realtime.stop]);

  // Spoken alerts — terminal only, opt-in, heavily braked (see the hook).
  useAmbientVoice({
    enabled:
      isTerminal && arcus.loaded && arcus.ambientVoice && desktop && !embedded,
    status: chat.status,
    speak,
    timezone: arcus.timezone,
    quietStart: arcus.quietStart,
    quietEnd: arcus.quietEnd,
    honorific: arcus.honorific,
  });

  // The saved preference is the starting point; the wake word can raise it
  // for a session without writing anything back.
  React.useEffect(() => {
    if (arcus.loaded) setHandsFree(arcus.handsFree);
  }, [arcus.loaded, arcus.handsFree, setHandsFree]);

  const toBubble = React.useCallback(() => {
    // `stop()` and not `reset()`: with saved conversations, wiping the
    // transcript on close would throw away history the rail now shows.
    stop();
    setMode("bubble");
    setPromoteArtifactId(null);
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }, [stop]);

  /** Esc steps down one level rather than closing outright. */
  const stepDown = React.useCallback(() => {
    setMode((current) => {
      if (current === "full") {
        lastOpenModeRef.current = "dock";
        writePref(STUDIO_KEYS.mode, "dock");
        return "dock";
      }
      if (current === "dock") {
        stop();
        return "bubble";
      }
      return current;
    });
  }, [stop]);

  // Phones keep MobileVoiceScreen; full mode is impossible there.
  React.useEffect(() => {
    if (!desktop && mode !== "bubble") setMode("bubble");
  }, [desktop, mode]);

  /**
   * `?arc=thread:<id>` opens Studio on that conversation (0102).
   *
   * This is how the morning briefing's notification lands somewhere useful:
   * tapping it opens the app on the dashboard AND opens the briefing thread,
   * so the first thing on screen is what Arcus wanted to say. The param is
   * stripped afterwards so a reload doesn't reopen it forever.
   */
  const { selectThread } = chat;
  React.useEffect(() => {
    if (!mounted || !desktop || embedded) return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("arc");
    if (!target?.startsWith("thread:")) return;
    const threadId = target.slice("thread:".length);
    if (!threadId) return;

    open("full");
    // One beat, so the hydrated thread list already contains it.
    const timer = window.setTimeout(() => selectThread(threadId), 400);
    params.delete("arc");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    return () => window.clearTimeout(timer);
  }, [mounted, desktop, embedded, open, selectThread]);

  // Stepping out of the full-screen dialog has to put focus somewhere real:
  // the browser drops it on <body> when the panel unmounts, which restarts
  // Tab at the top of the page behind it. Closing to the bubble already
  // focuses the launcher; this covers Esc's step down to the dock.
  const prevModeRef = React.useRef<StudioMode>("bubble");
  React.useEffect(() => {
    const previous = prevModeRef.current;
    prevModeRef.current = mode;
    if (previous === "full" && mode === "dock") {
      window.requestAnimationFrame(() => dockInputRef.current?.focus());
    }
  }, [mode]);

  // ---- global keyboard ----------------------------------------------------

  React.useEffect(() => {
    if (!desktop || embedded) return;

    // Cmd/Ctrl+K: CAPTURE phase, so it lands before Global Search's
    // document-level bubble listener and `stopPropagation()` keeps that
    // listener from ever seeing it.
    const onHotkey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== STUDIO_HOTKEY) return;
      event.preventDefault();
      event.stopPropagation();
      setMode((current) => {
        if (current === "full") {
          stop();
          return "bubble";
        }
        lastOpenModeRef.current = "full";
        writePref(STUDIO_KEYS.mode, "full");
        return "full";
      });
    };

    // Escape: BUBBLE phase, deliberately. The composer's `/` palette and `@`
    // menu cancel themselves on Esc and call `preventDefault()`; capturing
    // here would step Studio down before they ever got the chance, and one
    // keystroke would close both the menu and the workspace.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setMode((current) => {
        if (current === "bubble") return current;
        if (current === "full") {
          lastOpenModeRef.current = "dock";
          writePref(STUDIO_KEYS.mode, "dock");
          return "dock";
        }
        stop();
        return "bubble";
      });
    };

    window.addEventListener("keydown", onHotkey, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onHotkey, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, [desktop, embedded, stop]);

  // ---- launcher drag ------------------------------------------------------

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [dragBounds, setDragBounds] = React.useState({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  // When the last drag ended. The click that follows a drag is suppressed by
  // recency rather than by a boolean flag: a drag whose pointer is released
  // off the button never produces that click, and a latched flag would then
  // swallow the user's next real one.
  const draggedAtRef = React.useRef(0);

  React.useEffect(() => {
    const BTN = 56; // h-14 w-14
    const MARGIN = 16; // keep a little gap from the viewport edges

    const recompute = () => {
      const maxLeft = -(window.innerWidth - BTN - MARGIN * 2);
      const maxUp = -(window.innerHeight - BTN - MARGIN * 2);
      setDragBounds({ left: maxLeft, right: 0, top: maxUp, bottom: 0 });
      if (x.get() < maxLeft) x.set(maxLeft);
      if (y.get() < maxUp) y.set(maxUp);
    };

    try {
      const saved = localStorage.getItem(STUDIO_KEYS.pos);
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.x === "number") x.set(p.x);
        if (typeof p.y === "number") y.set(p.y);
      }
    } catch {
      // ignore malformed storage
    }

    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [x, y]);

  // ---- dock ---------------------------------------------------------------

  // Teardown for a drag in flight. Esc (or Cmd+K) can close the dock while the
  // grip is still held; without this the window listeners would leak and the
  // whole app would be left unselectable by `user-select: none`.
  const endDockDragRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    // Leaving dock mode tears the drag down too — the grip is unmounted by
    // then, so no pointerup will ever arrive to do it.
    if (mode !== "dock") endDockDragRef.current?.();
    return () => endDockDragRef.current?.();
  }, [mode]);

  const dockResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = dock.w;
      const startH = dock.h;
      document.body.style.userSelect = "none";

      // The dock is anchored bottom-right, so the grip is top-left and the
      // deltas are inverted: dragging up/left makes it bigger.
      const move = (e: PointerEvent) => {
        setDock({
          w: clamp(
            startW + (startX - e.clientX),
            DOCK_MIN_W,
            Math.min(DOCK_MAX_W, window.innerWidth - 32),
          ),
          h: clamp(
            startH + (startY - e.clientY),
            DOCK_MIN_H,
            window.innerHeight - 48,
          ),
        });
      };
      const end = () => {
        endDockDragRef.current = null;
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        setDock((current) => {
          writePref(STUDIO_KEYS.dock, current);
          return current;
        });
      };

      endDockDragRef.current = end;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [dock.w, dock.h],
  );

  const nudgeDock = React.useCallback((event: React.KeyboardEvent) => {
    const step = 24;
    const dx =
      event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    const dy =
      event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    setDock((current) => {
      const next = {
        w: clamp(
          current.w + dx,
          DOCK_MIN_W,
          Math.min(DOCK_MAX_W, window.innerWidth - 32),
        ),
        h: clamp(current.h + dy, DOCK_MIN_H, window.innerHeight - 48),
      };
      writePref(STUDIO_KEYS.dock, next);
      return next;
    });
  }, []);

  // Keep the dock transcript pinned to the newest exchange.
  React.useEffect(() => {
    if (mode !== "dock") return;
    dockScrollRef.current?.scrollTo({
      top: dockScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [mode, chat.messages, chat.status, chat.streamingText]);

  /** Promote a dock artifact chip into the workspace, with it selected. */
  const promote = React.useCallback(
    (artifactId: string) => {
      setPromoteArtifactId(artifactId);
      open("full");
    },
    [open],
  );

  // Phones, and any embedded copy of the app, get nothing at all — no
  // listeners, no portals, no launcher. Both guards matter: `hidden lg:block`
  // only hides this, and an embedded page artifact would otherwise mount the
  // assistant inside the assistant's own preview.
  if (!mounted || !desktop || embedded) return null;

  const greeting = `Hi ${firstName}, I'm Arcus. Ask me anything about your workspace — or open the full studio for previews.`;

  return (
    <>
      {/* Floating launcher */}
      <AnimatePresence>
        {mode === "bubble" && (
          <motion.button
            key="launcher"
            ref={launcherRef}
            style={{ x, y }}
            drag
            dragMomentum={false}
            dragElastic={0.06}
            dragConstraints={dragBounds}
            onDragStart={() => {
              draggedAtRef.current = Date.now();
            }}
            onDragEnd={() => {
              draggedAtRef.current = Date.now();
              writePref(STUDIO_KEYS.pos, { x: x.get(), y: y.get() });
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onClick={() => {
              // Suppress the click that fires at the end of a drag.
              if (Date.now() - draggedAtRef.current < 200) return;
              open(lastOpenModeRef.current === "dock" ? "dock" : "full");
            }}
            aria-label="Open Arcus Studio — drag to reposition, or press Command K"
            className="fixed bottom-6 right-6 z-50 grid h-14 w-14 cursor-grab touch-none place-items-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lift ring-1 ring-white/30 active:cursor-grabbing"
          >
            <span className="pointer-events-none absolute inset-0 -z-10 animate-ping rounded-full bg-primary-500/40" />
            <Sparkles className="h-6 w-6" />
            {/* The wake dot (0104) — and when it is NOT green, it says WHY:
                "I keep saying hey Arcus and nothing happens" is unanswerable
                when the only signal is a dot that quietly isn't there. */}
            {wakeListening ? (
              <span
                aria-hidden
                title="Listening for “Hey Arcus”"
                className="pointer-events-none absolute -bottom-0.5 -left-0.5 h-3 w-3 animate-pulse rounded-full bg-emerald-400 ring-2 ring-white"
              />
            ) : (arcus.wakeWord || isTerminal) && wakeState === "denied" ? (
              <span
                aria-hidden
                title="Wake word can't hear — the microphone is blocked for this site. Open Arcus and click MIC BLOCKED · FIX."
                className="pointer-events-none absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-white"
              />
            ) : (arcus.wakeWord || isTerminal) && wakeState === "failing" ? (
              <span
                aria-hidden
                title="Wake word is retrying — the browser's speech service isn't responding (it needs Chrome and internet)."
                className="pointer-events-none absolute -bottom-0.5 -left-0.5 h-3 w-3 animate-pulse rounded-full bg-amber-400 ring-2 ring-white"
              />
            ) : (arcus.wakeWord || isTerminal) && (wakePaused || wakeAsleep) ? (
              <span
                aria-hidden
                title={
                  wakePaused
                    ? "Wake word muted on this device — open Arcus and click WAKE MUTED · ARM to resume."
                    : "Quiet hours — the wake microphone sleeps until morning."
                }
                className="pointer-events-none absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full bg-slate-400 ring-2 ring-white"
              />
            ) : null}
            {/* Something is waiting to be said (0102). */}
            {inbox.count > 0 && (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-white">
                {inbox.count > 9 ? "9+" : inbox.count}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* The chip: Arcus reaching out first. It sits above the bubble, says
          the one thing worth interrupting for, and opens straight into a
          conversation about it. Dismissing is one tap and never asks twice. */}
      <AnimatePresence>
        {mode === "bubble" && inbox.top && (
          <motion.div
            key="arcus-chip"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.2 }}
            className="glass fixed bottom-24 right-6 z-50 flex max-w-xs items-start gap-2 rounded-2xl border border-white/50 px-3 py-2.5 shadow-lift"
          >
            <button
              type="button"
              onClick={() => {
                const event = inbox.top;
                if (!event) return;
                inbox.dismiss(event.id);
                open("full");
                chat.sendText(`Tell me about this: ${event.title}`);
              }}
              className="min-w-0 flex-1 text-left"
            >
              <p className="truncate text-sm font-semibold text-slate-900">
                {inbox.top.title}
              </p>
              {inbox.top.body && (
                <p className="truncate text-xs text-slate-500">{inbox.top.body}</p>
              )}
            </button>
            <button
              type="button"
              onClick={() => inbox.top && inbox.dismiss(inbox.top.id)}
              aria-label="Dismiss"
              className="mt-0.5 shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dock */}
      <AnimatePresence>
        {mode === "dock" && (
          <motion.div
            key="dock"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
            style={{
              width: Math.min(dock.w, typeof window === "undefined" ? dock.w : window.innerWidth - 32),
              height: dock.h,
            }}
            className="glass fixed bottom-6 right-6 z-50 flex flex-col overflow-hidden rounded-3xl border border-white/40 shadow-lift"
          >
            {/* Resize grip. Top-left, because the panel is anchored
                bottom-right and that is the only corner that can grow. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the assistant panel"
              tabIndex={0}
              onPointerDown={dockResize}
              onKeyDown={nudgeDock}
              className="absolute left-0 top-0 z-10 h-5 w-5 cursor-nwse-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300"
            />

            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 bg-white/60 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-xl gradient-primary text-white shadow-sm">
                  <Sparkles className="h-4.5 w-4.5" />
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-semibold text-slate-900">
                    Arcus
                  </p>
                  <p className="text-[11px] font-medium text-slate-500">
                    {chat.status === "listening"
                      ? chat.heard
                        ? "Heard you — go on…"
                        : "Listening…"
                      : chat.status === "thinking"
                        ? "Got it — working…"
                        : chat.status === "speaking"
                          ? "Speaking…"
                          : "Voice + workspace AI"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Arcus settings"
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => open("full")}
                  aria-label="Open the full studio"
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setMuted((m) => !m)}
                  aria-label={chat.muted ? "Unmute voice" : "Mute voice"}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                >
                  {chat.muted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                <button
                  onClick={toBubble}
                  aria-label="Close assistant"
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Transcript */}
            <div
              ref={dockScrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
            >
              {chat.messages.length === 0 && (
                <div className="rounded-2xl bg-white/70 p-4 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200/70">
                  {greeting}
                </div>
              )}

              {chat.messages.map((m) => (
                <div key={m.id} className="space-y-2">
                  <div
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

                  {/* Artifacts have no room down here — tapping one promotes
                      to the full workspace with that document open. */}
                  {m.artifacts && m.artifacts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.artifacts.map((artifact) => {
                        const Icon = artifactIcon(artifact);
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            onClick={() => promote(artifact.id)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {artifact.title}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {m.cards && m.cards.length > 0 && (
                    <div className="flex flex-col items-start gap-2">
                      {m.cards.map((card, k) => (
                        <AssistantCardView
                          key={k}
                          card={card}
                          onSend={chat.sendInvoice}
                          onSendSms={chat.sendSms}
                          onApproveMission={chat.approveMission}
                          // The dock has nowhere to render a PDF, so Open
                          // takes the same route a chip does: promote to the
                          // workspace with this document already selected.
                          onOpenPreview={promote}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {chat.streaming && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200/70">
                    {chat.streamingText}
                    <span
                      aria-hidden
                      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-primary-500 align-middle"
                    />
                  </div>
                </div>
              )}

              {chat.status === "thinking" && !chat.streaming && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-sm text-slate-500 ring-1 ring-slate-200/70">
                    <Loader2 className="h-4 w-4 animate-spin" /> Working on it…
                  </div>
                </div>
              )}

              {chat.error && (
                <div className="rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-600 ring-1 ring-rose-200">
                  {chat.error}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="border-t border-slate-200/70 bg-white/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={chat.toggleMic}
                  disabled={chat.busy && chat.status !== "listening"}
                  aria-label={
                    chat.status === "listening" ? "Stop recording" : "Start talking"
                  }
                  aria-pressed={chat.status === "listening"}
                  className={cn(
                    "relative grid h-12 w-12 shrink-0 place-items-center rounded-full text-white shadow-sm transition disabled:opacity-50",
                    chat.status === "listening"
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "gradient-primary hover:brightness-110",
                  )}
                >
                  {chat.status === "listening" ? (
                    <>
                      <span
                        aria-hidden
                        className="absolute inset-0 rounded-full bg-rose-500/40"
                        style={{
                          transform: `scale(${1 + Math.min(chat.level * 4, 1)})`,
                        }}
                      />
                      <Square className="relative h-5 w-5" fill="currentColor" />
                    </>
                  ) : chat.status === "thinking" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Mic className="h-5 w-5" />
                  )}
                </button>

                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    chat.sendText(chat.text);
                  }}
                >
                  <input
                    ref={dockInputRef}
                    value={chat.text}
                    onChange={(e) => chat.setText(e.target.value)}
                    placeholder={
                      chat.status === "listening"
                        ? "Listening…"
                        : "Or type a message…"
                    }
                    disabled={chat.status === "listening"}
                    aria-label="Message Arcus"
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-primary-300 focus:ring-2 focus:ring-primary-100 disabled:bg-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={!chat.text.trim() || chat.busy}
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

      {/* Full workspace — portalled to <body> so it escapes the shell's
          `hidden lg:block` wrapper and every overflow-hidden ancestor. */}
      {createPortal(
        <AnimatePresence>
          {mode === "full" && (
            <AssistantWorkspace
              key="studio"
              chat={chatForUi}
              firstName={firstName}
              onDock={stepDown}
              onClose={toBubble}
              initialArtifactId={promoteArtifactId}
              personaName={arcus.personaName}
              wakeListening={wakeListening}
              wakeState={wakeState}
              wakePaused={wakePaused}
              wakeAsleep={wakeAsleep}
              wakeHeard={wakeHeard}
              onWakeFix={onWakeFix}
              onWakeToggle={toggleWakePaused}
              isTerminal={isTerminal}
              ambientStage={arcus.ambientStage}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* The dock's own settings sheet. The full workspace renders its own,
          and the two never coexist — only one mode is mounted at a time. */}
      {mode === "dock" && (
        <StudioSettings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}
