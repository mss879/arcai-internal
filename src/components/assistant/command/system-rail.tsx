"use client";

/**
 * The system rail — the right-hand column of the HUD, straight from the
 * reference art: SYSTEM STATUS, CORE STATUS (the reactor), SYSTEM LOG (the
 * agent visibly thinking), and VOICE COMMAND at the bottom.
 *
 * Voice-first by request: there is no visible chat. The bottom panel shows
 * the microphone state and a small "chat" switch; only that switch reveals
 * the transcript and composer, as an overlay sheet that never reflows the
 * rail. Talking is the front door, typing is the side door.
 *
 * Memoised, and neither `level` nor the whole `chat` object appears in its
 * props — the two leaves that need the live meter (the reactor, the mic
 * ring) read it from `LevelContext`, so sixty updates a second pass this
 * component without touching it.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleAlert,
  Loader2,
  MessageSquareText,
  Mic,
  X,
} from "lucide-react";

import { AssistantCardView } from "@/components/assistant/assistant-card";
import { ArcusCore } from "@/components/assistant/command/arcus-core";
import { useAudioLevel } from "@/components/assistant/command/level-context";
import { Composer } from "@/components/assistant/composer";
import { useReducedMotionSafe } from "@/components/assistant/studio-store";
import type {
  SendInvoiceResult,
  Status,
} from "@/components/assistant/use-voice-chat";
import type { WakeWordState } from "@/components/assistant/use-wake-word";
import type { SmsCardData } from "@/lib/assistant-cards";
import type { AssistantMessage } from "@/lib/assistant-threads";
import type { ToolStep } from "@/lib/assistant-stream";
import { cn } from "@/lib/utils";

export const RAIL_W = 296;

/** Boot lines shown while nothing is running — the reference's system log. */
const NOMINAL: string[] = [
  "INITIALIZING SYSTEMS",
  "LOADING INTERFACE",
  "CONNECTING TO WORKSPACE",
  "SECURITY PROTOCOLS",
  "VOICE SYSTEMS",
  "DIAGNOSTICS",
];

const STATUS_WORD: Record<Status, string> = {
  idle: "STANDING BY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "RESPONDING",
};

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5">
      <span className="hud-title">{children}</span>
      <span
        aria-hidden
        className="h-px flex-1"
        style={{
          background:
            "linear-gradient(90deg, rgb(249 115 22 / 0.5), transparent)",
        }}
      />
    </div>
  );
}

/** The decorative heartbeat trace — CSS-animated, zero script. */
function Ekg() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 220 24"
      className="hud-ekg h-6 w-full text-emerald-400"
      fill="none"
    >
      <path
        d="M0 12 H48 l6 -7 6 14 6 -14 6 7 H120 l5 -5 5 10 5 -10 5 5 H220"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.9"
      />
    </svg>
  );
}

/** The reactor + its caption. The one rail piece that consumes the meter. */
function CoreStatus({
  status,
  orbRef,
  onTap,
}: {
  status: Status;
  orbRef: React.RefObject<HTMLDivElement | null>;
  onTap: () => void;
}) {
  const level = useAudioLevel();
  return (
    <div className="flex flex-col items-center gap-2 px-3 pb-3 pt-2">
      <div ref={orbRef}>
        <ArcusCore status={status} level={level} onTap={onTap} size={116} />
      </div>
      <p className="hud-mono text-[10px] tracking-[0.3em] text-[var(--stage-dim)]">
        {STATUS_WORD[status]}
      </p>
    </div>
  );
}

/** The composer needs the live level for its mic ring — context, not props. */
function RailComposer(props: {
  value: string;
  onChange: (v: string) => void;
  onSend: (v: string) => void;
  onToggleMic: () => void;
  onCancel: () => void;
  status: Status;
  busy: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const level = useAudioLevel();
  return (
    <Composer
      value={props.value}
      onChange={props.onChange}
      onSend={props.onSend}
      onToggleMic={props.onToggleMic}
      onCancel={props.onCancel}
      status={props.status}
      level={level}
      busy={props.busy}
      suggestions={[]}
      onSuggest={props.onSend}
      inputRef={props.inputRef}
    />
  );
}

/**
 * The wake light, telling the TRUTH (0104). Its predecessor showed ARMED/OFF
 * with no reason, which produced the exact support call it existed to
 * prevent: "I say hey Arcus and nothing happens." A blocked microphone and a
 * failing speech engine are now named — and clickable, because the fix is a
 * permission prompt away.
 */
function WakeIndicator({
  listening,
  state,
  paused,
  onFix,
  onToggle,
}: {
  listening?: boolean;
  state?: WakeWordState;
  /** Muted for the session via this very light. */
  paused?: boolean;
  onFix?: () => void;
  /** Pause/resume listening for the session — no settings write. */
  onToggle?: () => void;
}) {
  // The session mute outranks everything: while paused the recogniser is
  // disabled, so `state` would otherwise read "off" and hide the way back.
  if (paused && onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="pointer-events-auto text-amber-400 underline decoration-dotted underline-offset-2 hover:text-amber-300"
        title="Wake word paused on this device — click to start listening again."
      >
        WAKE MUTED · ARM
      </button>
    );
  }
  if (listening) {
    if (onToggle) {
      return (
        <button
          type="button"
          onClick={onToggle}
          className="pointer-events-auto text-[var(--stage-accent)] underline decoration-dotted underline-offset-2 hover:brightness-125"
          title="Listening for the wake word — click to pause the microphone for this session."
        >
          WAKE ARMED
        </button>
      );
    }
    return <span className="text-[var(--stage-accent)]">WAKE ARMED</span>;
  }
  if (state === "denied" && onFix) {
    return (
      <button
        type="button"
        onClick={onFix}
        className="pointer-events-auto text-rose-400 underline decoration-dotted underline-offset-2 hover:text-rose-300"
        title="The microphone is blocked for this site — click to allow it and start listening."
      >
        MIC BLOCKED · FIX
      </button>
    );
  }
  if (state === "failing" && onFix) {
    return (
      <button
        type="button"
        onClick={onFix}
        className="pointer-events-auto text-amber-400 underline decoration-dotted underline-offset-2 hover:text-amber-300"
        title="Speech recognition keeps failing (it needs Chrome and an internet connection) — click to retry now."
      >
        WAKE RETRYING · NOW
      </button>
    );
  }
  if (state === "unsupported") {
    return (
      <span title="This browser has no speech recognition — use Chrome for the wake word.">
        WAKE UNSUPPORTED
      </span>
    );
  }
  if (state === "suspended") {
    return <span title="Paused while Arcus is busy.">WAKE PAUSED</span>;
  }
  return (
    <span title="Turn the wake word on in settings (Voice tab), or register this machine as the terminal.">
      WAKE OFF
    </span>
  );
}

function LogLine({ step }: { step: ToolStep }) {
  const running = step.state === "running";
  const failed = step.state === "error";
  return (
    <li className="hud-mono flex items-center gap-1.5 text-[10px] leading-5">
      <span className="text-[var(--stage-accent)]">&gt;</span>
      <span className="min-w-0 flex-1 truncate uppercase tracking-wider text-[var(--stage-dim)]">
        {step.label}
      </span>
      {running ? (
        <Loader2 className="h-3 w-3 animate-spin text-[var(--stage-accent)]" />
      ) : failed ? (
        <span className="flex items-center gap-1 text-rose-400">
          <CircleAlert className="h-3 w-3" />
          ERR
        </span>
      ) : (
        <span className="flex items-center gap-1 text-emerald-400">
          <Check className="h-3 w-3" />
          OK
        </span>
      )}
    </li>
  );
}

export type SystemRailProps = {
  status: Status;
  steps: ToolStep[];
  personaName: string;
  /** Speech detected in the current capture — the "I hear you" light. */
  heard?: boolean;
  wakeListening?: boolean;
  wakeState?: WakeWordState;
  wakePaused?: boolean;
  /** Newest snippet the wake recogniser heard — shown as live proof. */
  wakeHeard?: string;
  onWakeFix?: () => void;
  onWakeToggle?: () => void;
  isTerminal?: boolean;
  orbRef: React.RefObject<HTMLDivElement | null>;
  onCoreTap: () => void;
  // ---- conversation (all referentially stable or turn-scoped) ----
  messages: AssistantMessage[];
  streamingText: string;
  error: string | null;
  text: string;
  setText: (v: string) => void;
  onPrompt: (v: string) => void;
  onToggleMic: () => void;
  onCancel: () => void;
  busy: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onOpenArtifact: (id: string) => void;
  onSendInvoice: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
  onSendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
  onApproveMission: (missionId: string) => Promise<SendInvoiceResult>;
};

function SystemRailImpl({
  status,
  steps,
  personaName,
  heard,
  wakeListening,
  wakeState,
  wakePaused,
  wakeHeard,
  onWakeFix,
  onWakeToggle,
  isTerminal,
  orbRef,
  onCoreTap,
  messages,
  streamingText,
  error,
  text,
  setText,
  onPrompt,
  onToggleMic,
  onCancel,
  busy,
  composerRef,
  onOpenArtifact,
  onSendInvoice,
  onSendSms,
  onApproveMission,
}: SystemRailProps) {
  const reduced = useReducedMotionSafe();
  const [chatOpen, setChatOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // The log keeps showing the last turn's work after it finishes — a console
  // that wipes itself the instant a command returns tells you nothing.
  const [lastSteps, setLastSteps] = React.useState<ToolStep[]>([]);
  React.useEffect(() => {
    if (steps.length > 0) setLastSteps(steps);
  }, [steps]);
  const logSteps = steps.length > 0 ? steps : lastSteps;

  // Set after mount: this component server-renders too, and the server's
  // locale is not the user's — a date painted there is a hydration mismatch.
  const [today, setToday] = React.useState("");
  React.useEffect(() => {
    setToday(
      new Date()
        .toLocaleDateString(undefined, {
          weekday: "short",
          day: "2-digit",
          month: "short",
        })
        .toUpperCase(),
    );
  }, []);

  // Pin the transcript to its newest line while open.
  React.useEffect(() => {
    if (!chatOpen) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatOpen, messages, streamingText]);

  const shown = messages.slice(-30);

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col gap-3 py-3 pr-3"
      style={{ width: RAIL_W }}
    >
      {/* SYSTEM STATUS */}
      <section className="hud-panel hud-panel--tight hud-ticks relative shrink-0 pb-2.5">
        <PanelTitle>System status</PanelTitle>
        <div className="flex items-center gap-3 px-3 pt-1.5">
          <div className="min-w-0 flex-1">
            <Ekg />
          </div>
          <div className="hud-mono shrink-0 text-right text-[10px] leading-4 tracking-wider">
            <p className="text-emerald-400">ONLINE</p>
            <p className="text-[var(--stage-faint)]">{today}</p>
          </div>
        </div>
        <div className="hud-mono flex items-center justify-between px-3 pt-1 text-[9px] tracking-[0.18em] text-[var(--stage-faint)]">
          <span>{isTerminal ? "PRIMARY TERMINAL" : "WORKSPACE LINK"}</span>
          <WakeIndicator
            listening={wakeListening}
            state={wakeState}
            paused={wakePaused}
            onFix={onWakeFix}
            onToggle={onWakeToggle}
          />
        </div>
      </section>

      {/* CORE STATUS */}
      <section className="hud-panel hud-ticks relative shrink-0">
        <PanelTitle>Core status</PanelTitle>
        <CoreStatus status={status} orbRef={orbRef} onTap={onCoreTap} />
      </section>

      {/* SYSTEM LOG — the agent, visibly thinking. */}
      <section className="hud-panel hud-panel--tight relative flex min-h-0 flex-1 flex-col">
        <PanelTitle>System log</PanelTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-1">
          {logSteps.length > 0 ? (
            <ul>
              {logSteps.slice(-9).map((step) => (
                <LogLine key={step.id} step={step} />
              ))}
            </ul>
          ) : (
            <ul>
              {NOMINAL.map((line) => (
                <li
                  key={line}
                  className="hud-mono flex items-center gap-1.5 text-[10px] leading-5"
                >
                  <span className="text-[var(--stage-accent)]">&gt;</span>
                  <span className="min-w-0 flex-1 truncate tracking-wider text-[var(--stage-faint)]">
                    {line}
                  </span>
                  <span className="text-emerald-400/80">OK</span>
                </li>
              ))}
              <li className="hud-mono pt-1 text-[10px] tracking-[0.2em] text-emerald-400/90">
                &gt; ALL SYSTEMS NOMINAL
              </li>
            </ul>
          )}
          {error && (
            <p className="hud-mono mt-1 flex items-start gap-1.5 text-[10px] leading-4 text-rose-400">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </section>

      {/* VOICE COMMAND — talking is the front door; chat is the switch. */}
      <section className="hud-panel hud-ticks relative shrink-0 pb-3">
        <PanelTitle>Voice command</PanelTitle>
        <div className="flex items-center gap-3 px-3 pt-2">
          <button
            type="button"
            onClick={onCoreTap}
            aria-label={
              status === "listening" ? "Stop listening" : "Start listening"
            }
            className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors",
              status === "listening"
                ? "border-primary-400/70 bg-primary-500/20 text-primary-300"
                : "border-[var(--stage-border-strong)] text-[var(--stage-dim)] hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
            )}
          >
            <Mic className="h-4.5 w-4.5" />
          </button>
          <div className="hud-mono min-w-0 flex-1 text-[10px] leading-4 tracking-wider text-[var(--stage-faint)]">
            {status === "listening" ? (
              heard ? (
                <p className="text-emerald-400">GOT IT — GO ON…</p>
              ) : (
                <p className="text-[var(--stage-accent)]">LISTENING…</p>
              )
            ) : status === "thinking" ? (
              <p className="text-amber-300">ON IT — CHECKING THE SYSTEM…</p>
            ) : status === "speaking" ? (
              <p className="text-sky-300">RESPONDING…</p>
            ) : (
              <p>
                {wakeListening
                  ? `SAY “HEY ${personaName.toUpperCase()}”`
                  : "TAP THE CORE TO TALK"}
              </p>
            )}
            <p className="truncate text-[var(--stage-faint)]/70">
              {status === "idle" && wakeListening && wakeHeard
                ? `HEARD: “${wakeHeard.toUpperCase()}”`
                : `TALK TO ME${isTerminal ? ", SIR" : ""}.`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            aria-pressed={chatOpen}
            aria-label={chatOpen ? "Close the chat" : "Switch to chat"}
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors",
              chatOpen
                ? "border-primary-400/60 bg-primary-500/15 text-primary-300"
                : "border-[var(--stage-border)] text-[var(--stage-dim)] hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
            )}
          >
            <MessageSquareText className="h-4 w-4" />
          </button>
        </div>
      </section>

      {/* The chat sheet — an overlay, so opening it never reflows the rail. */}
      <AnimatePresence>
        {chatOpen && (
          <motion.div
            key="chat"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            transition={{ duration: 0.2 }}
            // Positioned by inline style on a chrome-free wrapper: `hud-panel`
            // must never share an element with `absolute`, because the panel
            // class participates in the cascade and one stale build of it
            // carrying a `position` puts the sheet back into flow — which
            // crushed the system log to nothing. Inline style answers to no
            // stylesheet.
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              height: "min(560px, calc(100% - 24px))",
              width: 360,
              zIndex: 30,
            }}
          >
            {/* Solid ground, not the panel's translucent wash: this floats
                over the system log, and ghost text through a conversation
                reads as a rendering bug. */}
            <div className="hud-panel relative flex h-full w-full flex-col !bg-[#0b0805]">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--stage-border)] px-3">
              <span className="hud-title">Conversation</span>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                aria-label="Close the chat"
                className="grid h-7 w-7 place-items-center rounded-lg text-[var(--stage-dim)] hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
            >
              {shown.length === 0 && !streamingText && (
                <p className="hud-mono py-6 text-center text-[10px] tracking-wider text-[var(--stage-faint)]">
                  NOTHING SAID YET
                </p>
              )}
              {shown.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex",
                    message.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[88%] rounded-lg px-2.5 py-1.5 text-[13px] leading-relaxed text-[var(--stage-text)]",
                      message.role === "user" && "bg-primary-500/15",
                    )}
                  >
                    {message.content}
                    {message.cards?.map((card, ci) => (
                      <div key={ci} className="mt-2">
                        <AssistantCardView
                          card={card}
                          onSend={onSendInvoice}
                          onSendSms={onSendSms}
                          onApproveMission={onApproveMission}
                          onOpenPreview={onOpenArtifact}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {streamingText && (
                <p className="text-[13px] leading-relaxed text-[var(--stage-text)]">
                  {streamingText}
                </p>
              )}
            </div>
            <div className="shrink-0 border-t border-[var(--stage-border)] p-2">
              <div className="rounded-xl bg-white/95 p-1.5">
                <RailComposer
                  value={text}
                  onChange={setText}
                  onSend={onPrompt}
                  onToggleMic={onToggleMic}
                  onCancel={onCancel}
                  status={status}
                  busy={busy}
                  inputRef={composerRef}
                />
              </div>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}

export const SystemRail = React.memo(SystemRailImpl);
