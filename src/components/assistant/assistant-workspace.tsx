"use client";

/**
 * Arc Studio's full-screen workspace — the flagship surface.
 *
 * The complaint this exists to answer: the old assistant was a 400px corner
 * panel where you couldn't read your own conversation, let alone look at a
 * proposal. So this is three columns:
 *
 *   LEFT   conversation history + a "Jump to" list of every area of the app
 *   CENTRE the transcript: wide bubbles, a live trail of the tools Arc is
 *          running, inline confirm cards, artifact chips, a real composer
 *   RIGHT  the preview canvas — a proposal PDF, an invoice, a client table, a
 *          chart, or an actual page of the app, full size, while you keep
 *          talking
 *
 * It owns layout only. Everything stateful about the conversation lives in the
 * single `useVoiceChat()` instance that `<VoiceAssistant>` passes in as `chat`
 * — one engine for all three modes, so switching from dock to full never
 * interrupts audio or loses the transcript.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  Loader2,
  Minimize2,
  PanelLeftClose,
  LayoutPanelLeft,
  PanelRight,
  PanelRightClose,
  Radio,
  Scan,
  Settings2,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Artifact } from "@/lib/assistant-artifacts";
import type { ToolStep } from "@/lib/assistant-stream";
import type { AssistantMessage } from "@/lib/assistant-threads";
import type { SmsCardData } from "@/lib/assistant-cards";
import { AssistantCardView } from "@/components/assistant/assistant-card";
import { ActivityTrail } from "@/components/assistant/activity-trail";
import { ApprovalsTray } from "@/components/assistant/approvals-tray";
import { Composer } from "@/components/assistant/composer";
import { StudioSettings } from "@/components/assistant/studio-settings";
import { ThreadRail } from "@/components/assistant/thread-rail";
import { CommandView } from "@/components/assistant/command/command-view";
import { PreviewPane } from "@/components/assistant/preview/preview-pane";
import { artifactIcon } from "@/components/assistant/preview/artifact-format";
import { clearPdfCache } from "@/components/assistant/preview/pdf-artifact";
import type {
  SendInvoiceResult,
  Status,
  VoiceChat,
} from "@/components/assistant/use-voice-chat";
import type { WakeWordState } from "@/components/assistant/use-wake-word";
import {
  CANVAS_MAX_RATIO,
  CANVAS_MIN_PX,
  CANVAS_MIN_RATIO,
  CENTRE_MIN_PX,
  clamp,
  RAIL_INLINE_MIN_PX,
  RAIL_PX,
  readLayout,
  readView,
  STUDIO_KEYS,
  STUDIO_SUGGESTIONS,
  useReducedMotionSafe,
  writePref,
  type StudioView,
} from "@/components/assistant/studio-store";

/** How many preview tabs a single conversation may keep open. */
const MAX_TABS = 8;
/** Handle thickness, needed when computing the centre column's floor. */
const HANDLE_PX = 6;
/** "Pinned to the bottom" tolerance for the transcript's auto-scroll. */
const PIN_TOLERANCE_PX = 120;

const ICON_BUTTON =
  "grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300";

/** The same button on the command view's dark chrome. */
const ICON_BUTTON_DARK =
  "grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400";

const FOCUSABLE =
  '[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/** Split a reply into paragraphs and bullet lists without a markdown package. */
function renderBody(content: string): React.ReactNode {
  const blocks = content.split(/\n{2,}/);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    const bullets = lines.filter((l) => /^\s*[-•]\s+/.test(l));
    if (bullets.length > 0 && bullets.length === lines.length) {
      return (
        <ul key={i} className="my-1.5 list-disc space-y-1 pl-5 marker:text-slate-300">
          {bullets.map((line, j) => (
            <li key={j}>{line.replace(/^\s*[-•]\s+/, "")}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} className={cn(i > 0 && "mt-2.5")}>
        {block}
      </p>
    );
  });
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

type ConversationProps = {
  messages: AssistantMessage[];
  liveSteps: ToolStep[];
  streamingText: string;
  streaming: boolean;
  status: Status;
  error: string | null;
  firstName: string;
  onSuggest: (text: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  activeArtifactId: string | null;
  onNavigate: (href: string) => void;
  onSendInvoice: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
  onSendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
  onApproveMission: (missionId: string) => Promise<SendInvoiceResult>;
  className?: string;
};

function ConversationImpl({
  messages,
  liveSteps,
  streamingText,
  streaming,
  status,
  error,
  firstName,
  onSuggest,
  onOpenArtifact,
  activeArtifactId,
  onNavigate,
  onSendInvoice,
  onSendSms,
  onApproveMission,
  className,
}: ConversationProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = React.useState(true);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < PIN_TOLERANCE_PX);
  }, []);

  const jumpToLatest = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  }, []);

  // Auto-scroll only while the user is already at the bottom. Yanking someone
  // who scrolled up to re-read an invoice is the fastest way to make a
  // streaming transcript feel hostile.
  React.useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText, liveSteps, status, pinned]);

  const empty = messages.length === 0 && !streaming && liveSteps.length === 0;

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full min-h-0 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto w-full max-w-[820px] space-y-5">
          {empty && (
            <div className="animate-float-in">
              <div className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-[var(--shadow-soft)]">
                <div className="grid h-11 w-11 place-items-center rounded-2xl gradient-primary text-white">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-slate-900">
                  Hi {firstName} — what are we doing today?
                </h2>
                <p className="mt-1.5 text-[15px] leading-relaxed text-slate-600">
                  I can reach every part of your workspace: clients, projects,
                  the pipeline, invoices, proposals, the money. Ask me to write
                  something and it opens in the preview beside us — a proposal
                  PDF, an invoice, a table, your month&apos;s numbers — and you
                  can keep changing it out loud.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {STUDIO_SUGGESTIONS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => onSuggest(chip)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-600 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-primary-600 px-4 py-2.5 text-[15px] leading-relaxed text-white">
                    {message.content}
                  </div>
                </div>
              );
            }

            const artifacts = message.artifacts ?? [];
            return (
              <div key={message.id} className="space-y-2.5">
                {message.steps && message.steps.length > 0 && (
                  <ActivityTrail
                    steps={message.steps}
                    live={false}
                    onNavigate={onNavigate}
                  />
                )}

                {message.content && (
                  <div
                    className={cn(
                      "max-w-[92%] rounded-2xl rounded-bl-md px-4 py-3 text-[15px] leading-relaxed shadow-[var(--shadow-soft)] ring-1",
                      message.error
                        ? "bg-rose-50 text-rose-700 ring-rose-200"
                        : "bg-white text-slate-700 ring-slate-200/70",
                    )}
                  >
                    {renderBody(message.content)}
                  </div>
                )}

                {artifacts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {artifacts.map((artifact: Artifact) => {
                      const Icon = artifactIcon(artifact);
                      const active = artifact.id === activeArtifactId;
                      return (
                        <button
                          key={artifact.id}
                          type="button"
                          onClick={() => onOpenArtifact(artifact.id)}
                          aria-label={`Open ${artifact.title} in the preview`}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
                            active
                              ? "border-primary-300 bg-primary-50 text-primary-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-primary-300 hover:text-primary-700",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {artifact.title}
                        </button>
                      );
                    })}
                  </div>
                )}

                {message.cards && message.cards.length > 0 && (
                  <div className="flex flex-col items-start gap-2">
                    {message.cards.map((card, k) => (
                      <AssistantCardView
                        key={k}
                        card={card}
                        onSend={onSendInvoice}
                        onSendSms={onSendSms}
                        onApproveMission={onApproveMission}
                        onOpenPreview={onOpenArtifact}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {liveSteps.length > 0 && <ActivityTrail steps={liveSteps} live />}

          {streaming && (
            <div
              aria-live="polite"
              aria-busy="true"
              className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-3 text-[15px] leading-relaxed text-slate-700 shadow-[var(--shadow-soft)] ring-1 ring-slate-200/70"
            >
              {renderBody(streamingText)}
              <span
                aria-hidden
                className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-primary-500 align-middle"
              />
            </div>
          )}

          {status === "thinking" && !streaming && liveSteps.length === 0 && (
            <div className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-3 text-[15px] text-slate-500 ring-1 ring-slate-200/70">
              <Loader2 className="h-4 w-4 animate-spin" /> Working on it…
            </div>
          )}

          {error && (
            <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-600 ring-1 ring-rose-200">
              {error}
            </div>
          )}
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-lift transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

const Conversation = React.memo(ConversationImpl);
Conversation.displayName = "Conversation";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export type AssistantWorkspaceProps = {
  /** The single shared engine instance, owned by `<VoiceAssistant>`. */
  chat: VoiceChat;
  /** Greeting name, e.g. "Shahid". */
  firstName: string;
  /** Step down to the corner dock. */
  onDock: () => void;
  /** Close entirely (back to the bubble). */
  onClose: () => void;
  /** Artifact to select on open, when promoted from a dock chip. */
  initialArtifactId?: string | null;
  /** What the assistant calls itself — drives the HUD nameplate. */
  personaName?: string;
  /** True while the wake-word recogniser is actually running. */
  wakeListening?: boolean;
  /** WHY it is or isn't — drives the rail's wake indicator. */
  wakeState?: WakeWordState;
  /** Muted for this session via the rail's wake light. */
  wakePaused?: boolean;
  /** Newest snippet the wake recogniser heard — live proof it's alive. */
  wakeHeard?: string;
  /** Prompt for the microphone and revive the recogniser. */
  onWakeFix?: () => void;
  /** Pause/resume wake listening for the session — the rail's wake light. */
  onWakeToggle?: () => void;
  isTerminal?: boolean;
  ambientStage?: boolean;
};

/**
 * The three-column workspace. Rendered by `<VoiceAssistant>` inside a portal
 * so it escapes every `overflow-hidden` ancestor in the app shell.
 */
export function AssistantWorkspace({
  chat,
  firstName,
  onDock,
  onClose,
  initialArtifactId,
  personaName,
  wakeListening,
  wakeState,
  wakePaused,
  wakeHeard,
  onWakeFix,
  onWakeToggle,
  isTerminal,
  ambientStage,
}: AssistantWorkspaceProps): React.ReactElement {
  const router = useRouter();
  const reduced = useReducedMotionSafe();

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);

  // ---- layout ------------------------------------------------------------

  // Which surface is on screen. Server-rendered as "classic" and corrected in
  // the mount effect below with every other stored preference — a first-render
  // localStorage read would be a hydration mismatch, and guessing "command"
  // here would flash the wrong layout for users who chose the other one.
  const [view, setView] = React.useState<StudioView>("classic");

  const [railOpen, setRailOpen] = React.useState(true);
  const [canvasOpen, setCanvasOpen] = React.useState(true);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [ratio, setRatio] = React.useState(0.46);
  const [expanded, setExpanded] = React.useState(false);
  const [panelWidth, setPanelWidth] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);

  // Restore preferences after mount — a first-render localStorage read would
  // be a hydration mismatch, exactly as with the sidebar's collapsed state.
  React.useEffect(() => {
    const layout = readLayout();
    setRailOpen(layout.railOpen);
    setCanvasOpen(layout.canvasOpen);
    setRatio(layout.canvasRatio);
    setView(readView());
  }, []);

  const command = view === "command";
  const iconButton = command ? ICON_BUTTON_DARK : ICON_BUTTON;

  const toggleView = React.useCallback(() => {
    setView((prev) => {
      const next: StudioView = prev === "command" ? "classic" : "command";
      writePref(STUDIO_KEYS.view, next);
      return next;
    });
  }, []);

  React.useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The rail goes inline only when the PANEL is wide enough. A Tailwind
  // breakpoint would be measuring the viewport, and the panel is inset by its
  // margin — the two disagree by exactly enough to matter near the boundary.
  const railInline = panelWidth === 0 || panelWidth >= RAIL_INLINE_MIN_PX;

  // Dropping below the inline threshold turns the rail into a drawer; leaving
  // it open would bury the conversation under it. This is a layout reaction,
  // not a preference, so it is deliberately not persisted.
  const wasInlineRef = React.useRef(true);
  React.useEffect(() => {
    if (!railInline && wasInlineRef.current) setRailOpen(false);
    wasInlineRef.current = railInline;
  }, [railInline]);

  // Expanded is a focus mode: the canvas takes the whole panel, so neither
  // the rail nor the conversation is on screen to compete for width.
  const railVisible = railOpen && !expanded;
  const railPx = railVisible && railInline ? RAIL_PX : 0;
  const canvasMax = Math.max(
    CANVAS_MIN_PX,
    panelWidth - railPx - CENTRE_MIN_PX - HANDLE_PX,
  );
  const canvasPx = expanded
    ? Math.max(panelWidth, CANVAS_MIN_PX)
    : clamp(ratio * panelWidth, CANVAS_MIN_PX, canvasMax);

  // Memoised with every other prop the canvas receives: `<PreviewPane>` is
  // wrapped in `React.memo` precisely so the mic's ~60/s level ticks don't
  // re-render a live PDF or an embedded page, and a fresh style object (or a
  // fresh arrow function) on each render would defeat that completely.
  const canvasStyle = React.useMemo<React.CSSProperties>(
    () => ({ width: canvasPx }),
    [canvasPx],
  );

  const persistRatio = React.useCallback((next: number) => {
    writePref(STUDIO_KEYS.canvas, next);
  }, []);

  // The teardown of the drag in progress, if any. Esc closes the workspace
  // from anywhere — including mid-drag — and without this the pointer
  // listeners would outlive the panel and `user-select: none` would stay on
  // <body> for the rest of the session.
  const endDragRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => endDragRef.current?.(), []);

  const beginDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      if (!panel) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragging(true);
      document.body.style.userSelect = "none";

      const move = (e: PointerEvent) => {
        const rect = panel.getBoundingClientRect();
        const width = clamp(
          rect.right - e.clientX,
          CANVAS_MIN_PX,
          Math.max(CANVAS_MIN_PX, rect.width - railPx - CENTRE_MIN_PX - HANDLE_PX),
        );
        setRatio(clamp(width / rect.width, CANVAS_MIN_RATIO, CANVAS_MAX_RATIO));
      };
      const end = () => {
        endDragRef.current = null;
        try {
          target.releasePointerCapture?.(event.pointerId);
        } catch {
          // The capture is already gone (the element unmounted mid-drag).
        }
        document.body.style.userSelect = "";
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        setRatio((current) => {
          persistRatio(current);
          return current;
        });
      };

      endDragRef.current = end;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [persistRatio, railPx],
  );

  const nudge = React.useCallback(
    (event: React.KeyboardEvent) => {
      const delta =
        event.key === "ArrowLeft" ? 0.02 : event.key === "ArrowRight" ? -0.02 : 0;
      if (event.key === "Home") {
        event.preventDefault();
        setRatio(0.46);
        persistRatio(0.46);
        return;
      }
      if (!delta) return;
      event.preventDefault();
      setRatio((prev) => {
        const next = clamp(prev + delta, CANVAS_MIN_RATIO, CANVAS_MAX_RATIO);
        persistRatio(next);
        return next;
      });
    },
    [persistRatio],
  );

  const toggleRail = React.useCallback(() => {
    setRailOpen((prev) => {
      writePref(STUDIO_KEYS.rail, !prev);
      return !prev;
    });
  }, []);

  const toggleCanvas = React.useCallback(() => {
    setExpanded(false);
    setCanvasOpen((prev) => {
      writePref(STUDIO_KEYS.canvasOpen, !prev);
      return !prev;
    });
  }, []);

  const toggleExpand = React.useCallback(() => setExpanded((v) => !v), []);

  const collapseCanvas = React.useCallback(() => {
    setExpanded(false);
    setCanvasOpen(false);
    writePref(STUDIO_KEYS.canvasOpen, false);
  }, []);

  // ---- artifacts ---------------------------------------------------------

  const [closedIds, setClosedIds] = React.useState<string[]>([]);
  const [activeArtifactId, setActiveArtifactId] = React.useState<string | null>(
    initialArtifactId ?? null,
  );
  // Set when the user picks a tab themselves; cleared on every new send, so a
  // fresh answer can steal focus but an idle conversation never does.
  const userPinnedRef = React.useRef(Boolean(initialArtifactId));

  const artifacts = React.useMemo(() => {
    const open = chat.artifacts.filter((a) => !closedIds.includes(a.id));
    if (open.length <= MAX_TABS) return open;
    // Keep the newest, plus whatever is on screen right now.
    const trimmed = open.slice(open.length - MAX_TABS);
    const active = open.find((a) => a.id === activeArtifactId);
    if (active && !trimmed.some((a) => a.id === active.id)) {
      return [active, ...trimmed.slice(1)];
    }
    return trimmed;
  }, [chat.artifacts, closedIds, activeArtifactId]);

  // Follow the newest artifact unless the user has chosen a tab this turn.
  React.useEffect(() => {
    if (userPinnedRef.current) return;
    const latest = chat.latestArtifactId;
    if (latest && !closedIds.includes(latest)) {
      setActiveArtifactId(latest);
      setCanvasOpen(true);
      return;
    }
    const fallback = artifacts[artifacts.length - 1];
    if (fallback) setActiveArtifactId(fallback.id);
  }, [chat.latestArtifactId, artifacts, closedIds]);

  const openArtifact = React.useCallback((id: string) => {
    userPinnedRef.current = true;
    setActiveArtifactId(id);
    setExpanded(false);
    setCanvasOpen(true);
    writePref(STUDIO_KEYS.canvasOpen, true);
  }, []);

  const closeTab = React.useCallback(
    (id: string) => {
      setClosedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      if (activeArtifactId === id) {
        userPinnedRef.current = false;
        setActiveArtifactId(null);
      }
    },
    [activeArtifactId],
  );

  const closeAllTabs = React.useCallback(() => {
    setClosedIds(chat.artifacts.map((a) => a.id));
    setActiveArtifactId(null);
    userPinnedRef.current = false;
  }, [chat.artifacts]);

  // Free every cached PDF blob when the workspace goes away. This is the only
  // moment we can be sure no tab still points at one of those object URLs.
  React.useEffect(() => () => clearPdfCache(), []);

  // ---- behaviour ---------------------------------------------------------

  const { sendText, newThread: startThread, selectThread, setText } = chat;

  /** Push a route and step down, so the user actually sees the page. */
  const onNavigate = React.useCallback(
    (href: string) => {
      router.push(href);
      onDock();
    },
    [router, onDock],
  );

  const send = React.useCallback(
    (value: string) => {
      userPinnedRef.current = false;
      sendText(value);
    },
    [sendText],
  );

  /** Fill the composer and focus it — never send. */
  const seed = React.useCallback(
    (value: string) => {
      setText(value);
      window.requestAnimationFrame(() => {
        const el = composerRef.current;
        el?.focus();
        el?.setSelectionRange(value.length, value.length);
      });
    },
    [setText],
  );

  const onNewThread = React.useCallback(() => {
    startThread();
    setClosedIds([]);
    setActiveArtifactId(null);
    userPinnedRef.current = false;
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [startThread]);

  const onSelectThread = React.useCallback(
    (id: string) => {
      selectThread(id);
      setClosedIds([]);
      setActiveArtifactId(null);
      userPinnedRef.current = false;
    },
    [selectThread],
  );

  // Lock the page behind the overlay. The previous value is restored rather
  // than cleared: the mobile voice screen uses the same trick, and blindly
  // writing "" would undo its lock if the two ever overlapped.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus the composer on open.
  React.useEffect(() => {
    const t = window.setTimeout(() => composerRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  /**
   * Keyboard handling local to the panel: the focus trap, plus the two
   * shortcuts that only make sense here. Cmd/Ctrl+K and Esc are owned by
   * `<VoiceAssistant>` because they have to work from anywhere in the app.
   */
  const onPanelKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        onNewThread();
        return;
      }

      if (meta && event.key === "/") {
        event.preventDefault();
        setCanvasOpen(true);
        writePref(STUDIO_KEYS.canvasOpen, true);
        window.requestAnimationFrame(() => {
          const pane = panelRef.current?.querySelector<HTMLElement>(
            '[aria-label="Preview"]',
          );
          pane?.focus();
        });
        return;
      }

      // Esc steps down one surface at a time. The composer's "/" and "@"
      // menus and the rail's search field consume their own Esc before it
      // ever reaches here (they `stopPropagation`), so by this point the
      // next thing to close is the drawer, then the expanded canvas — and
      // only when neither is up does `<VoiceAssistant>`'s window listener
      // (which skips a defaultPrevented event) take the workspace down.
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (railOpen && !railInline) {
          event.preventDefault();
          // Same path as the drawer's scrim, so Esc and a tap outside leave
          // the rail in the same (persisted) state.
          toggleRail();
          return;
        }
        if (expanded) {
          event.preventDefault();
          setExpanded(false);
          return;
        }
        return;
      }

      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [expanded, onNewThread, railInline, railOpen, toggleRail],
  );

  const statusLine =
    chat.status === "listening"
      ? "Listening…"
      : chat.status === "thinking"
        ? "Thinking…"
        : chat.status === "speaking"
          ? "Speaking…"
          : (chat.threads.find((t) => t.id === chat.activeThreadId)?.title ??
            "Voice + workspace AI");

  // The canvas can never be hidden while expanded — the un-expand button
  // lives in its own toolbar, and hiding it would strand the user.
  const showCanvas = canvasOpen || expanded;
  const showRail = railVisible;
  const showCentre = !expanded;

  return (
    <div
      className="fixed inset-0 z-[70] flex"
      role="dialog"
      aria-modal="true"
      aria-label="Arcus Studio"
    >
      <motion.div
        aria-hidden
        onClick={onDock}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.18 }}
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
      />

      <motion.div
        ref={panelRef}
        onKeyDown={onPanelKeyDown}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
        transition={
          reduced
            ? { duration: 0.12 }
            : { type: "spring", duration: 0.4, bounce: 0.12 }
        }
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          command
            ? "bg-[#07060b]"
            : "m-3 rounded-3xl border border-white/60 bg-white/90 shadow-[var(--shadow-lift)] backdrop-blur-2xl xl:m-6",
        )}
      >
        {/* Top bar */}
        <header
          className={cn(
            "flex h-14 shrink-0 items-center gap-3 border-b px-3 pr-2",
            command
              ? "border-white/10 bg-white/[0.03]"
              : "border-slate-200/70 bg-white/70",
          )}
        >
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl gradient-primary text-white">
            <Sparkles className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 leading-tight">
            <p
              className={cn(
                "truncate text-sm font-semibold",
                command ? "text-slate-100" : "text-slate-900",
              )}
            >
              Arcus Studio
            </p>
            <p
              className={cn(
                "truncate text-[11px] font-medium",
                command ? "text-slate-400" : "text-slate-500",
              )}
            >
              {statusLine}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleView}
              aria-label={
                command ? "Switch to the classic layout" : "Switch to command view"
              }
              aria-pressed={command}
              title={command ? "Classic layout" : "Command view"}
              className={iconButton}
            >
              {command ? (
                <LayoutPanelLeft className="h-4 w-4" />
              ) : (
                <Scan className="h-4 w-4" />
              )}
            </button>
            {!command && (
              <>
                <button
                  type="button"
                  onClick={toggleRail}
                  aria-label={
                    showRail ? "Hide conversations" : "Show conversations"
                  }
                  aria-pressed={showRail}
                  className={iconButton}
                >
                  {showRail ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4 rotate-180" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={toggleCanvas}
                  aria-label={showCanvas ? "Hide the preview" : "Show the preview"}
                  aria-pressed={showCanvas}
                  className={iconButton}
                >
                  {showCanvas ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4" />
                  )}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => chat.setMuted((m) => !m)}
              aria-label={chat.muted ? "Unmute voice" : "Mute voice"}
              aria-pressed={chat.muted}
              className={iconButton}
            >
              {chat.muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            {/* Hands-free: after each reply the mic reopens, so a
                conversation continues without a tap (0104). */}
            <button
              type="button"
              onClick={() => chat.setHandsFree(!chat.handsFree)}
              aria-label={
                chat.handsFree ? "Turn hands-free off" : "Turn hands-free on"
              }
              aria-pressed={chat.handsFree}
              className={cn(
                iconButton,
                chat.handsFree &&
                  (command
                    ? "bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25"
                    : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"),
              )}
            >
              <Radio className="h-4 w-4" />
            </button>
            <ApprovalsTray chat={chat} />
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Arcus settings"
              className={iconButton}
            >
              <Settings2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDock}
              aria-label="Shrink to the corner"
              className={iconButton}
            >
              <Minimize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Arcus Studio"
              className={iconButton}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* The stage. A second presentation of the same `chat`, so the header
            toggle can never lose a thread, an artifact or a turn in flight. */}
        {command ? (
          <CommandView
            chat={chat}
            firstName={firstName}
            personaName={personaName || "Arcus"}
            onNavigate={onNavigate}
            onPrompt={send}
            composerRef={composerRef}
            initialArtifactId={initialArtifactId}
            wakeListening={wakeListening}
            wakeState={wakeState}
            wakePaused={wakePaused}
            wakeHeard={wakeHeard}
            onWakeFix={onWakeFix}
            onWakeToggle={onWakeToggle}
            isTerminal={isTerminal}
            ambientStage={ambientStage}
          />
        ) : (
        /* Columns */
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* Below 1280px of PANEL width the rail becomes a drawer; it owns
              its own scrim and positioning, so nothing is restyled here. */}
          {showRail && (
            <ThreadRail
              threads={chat.threads}
              activeThreadId={chat.activeThreadId}
              onSearch={chat.searchThreads}
              onSelect={onSelectThread}
              onNew={onNewThread}
              onRename={chat.renameThread}
              onDelete={chat.deleteThread}
              onSeed={seed}
              overlay={!railInline}
              onDismiss={toggleRail}
            />
          )}

          {showCentre && (
            <div className="flex min-h-0 min-w-[420px] flex-1 flex-col">
              <Conversation
                className="min-h-0 flex-1"
                messages={chat.messages}
                liveSteps={chat.steps}
                streamingText={chat.streamingText}
                streaming={chat.streaming}
                status={chat.status}
                error={chat.error}
                firstName={firstName}
                onSuggest={send}
                onOpenArtifact={openArtifact}
                activeArtifactId={activeArtifactId}
                onNavigate={onNavigate}
                onSendInvoice={chat.sendInvoice}
                onSendSms={chat.sendSms}
                onApproveMission={chat.approveMission}
              />
              <div className="shrink-0 border-t border-slate-200/70 bg-white/70 px-6 py-4">
                <div className="mx-auto w-full max-w-[820px]">
                  <Composer
                    value={chat.text}
                    onChange={chat.setText}
                    onSend={send}
                    onToggleMic={chat.toggleMic}
                    onCancel={chat.cancel}
                    status={chat.status}
                    level={chat.level}
                    busy={chat.busy}
                    // The empty-thread chips live in the transcript above, where
                    // there is room for them; showing both would be noise.
                    suggestions={[]}
                    onSuggest={send}
                    inputRef={composerRef}
                  />
                </div>
              </div>
            </div>
          )}

          {showCanvas && (
            <>
              {!expanded && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize preview panel"
                  aria-valuemin={Math.round(CANVAS_MIN_RATIO * 100)}
                  aria-valuemax={Math.round(CANVAS_MAX_RATIO * 100)}
                  aria-valuenow={Math.round(ratio * 100)}
                  tabIndex={0}
                  onPointerDown={beginDrag}
                  onKeyDown={nudge}
                  className="group relative z-10 w-1.5 shrink-0 cursor-col-resize focus-visible:outline-none"
                >
                  <span aria-hidden className="absolute inset-y-0 -left-2 -right-2" />
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 transition-colors group-hover:bg-primary-400 group-focus-visible:bg-primary-500"
                  />
                </div>
              )}

              <PreviewPane
                artifacts={artifacts}
                activeId={activeArtifactId}
                onSelect={openArtifact}
                onCloseTab={closeTab}
                onCloseAll={closeAllTabs}
                onPrompt={send}
                onNavigate={onNavigate}
                onCollapse={collapseCanvas}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                style={canvasStyle}
              />
            </>
          )}

          {/* Drag shield. Without it the pointer crosses into the PDF or page
              iframe and the browser stops delivering pointermove to us. */}
          {dragging && (
            <div aria-hidden className="absolute inset-0 z-40 cursor-col-resize" />
          )}
        </div>
        )}
      </motion.div>

      <StudioSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
