"use client";

/**
 * The mock engine behind /public/arcus-preview (dev only — see page.tsx).
 *
 * A hand-built `VoiceChat` with believable data and a synthetic voice signal:
 * while the forced status is `listening` or `speaking`, `level` runs a
 * speech-shaped envelope (syllable bursts, not a sine hum) so the orb, the
 * field and the ring can be judged against something that moves like a voice.
 * Every mutation is a no-op or local state — nothing reaches the network.
 */

import * as React from "react";

import { CommandView } from "@/components/assistant/command/command-view";
import type {
  Status,
  VoiceChat,
} from "@/components/assistant/use-voice-chat";
import type { AssistantMessage } from "@/lib/assistant-threads";
import type { ToolStep } from "@/lib/assistant-stream";
import {
  chartArtifact,
  metricsArtifact,
  tableArtifact,
  type Artifact,
} from "@/lib/assistant-artifacts";

const MESSAGES: AssistantMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Show me this month's numbers",
    at: Date.now() - 60_000,
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "Revenue is at Rs. 1.24 million against Rs. 310 thousand of expenses, sir. Two invoices are overdue — shall I chase them?",
    at: Date.now() - 55_000,
  },
];

const STEPS: ToolStep[] = [
  {
    id: "s1",
    name: "finance_overview",
    label: "Reading the money",
    state: "done",
  },
  { id: "s2", name: "crm_query", label: "Checking the pipeline", state: "done" },
  {
    id: "s3",
    name: "find_leads_nearby",
    label: "Sweeping the area for leads",
    state: "running",
  },
];

function demoArtifacts(): Artifact[] {
  return [
    tableArtifact({
      id: "demo-table",
      title: "Overdue invoices",
      subtitle: "2 clients owe Rs. 415,000",
      area: "finance",
      columns: [
        { key: "client", label: "Client" },
        { key: "no", label: "Invoice" },
        { key: "days", label: "Days late", align: "right", format: "number" },
        { key: "due", label: "Balance", align: "right", format: "money" },
      ],
      rows: [
        {
          id: "r1",
          tone: "danger",
          cells: { client: "Silva Motors", no: "INV-0142", days: 12, due: 265000 },
        },
        {
          id: "r2",
          tone: "warning",
          cells: { client: "Musa Traders", no: "INV-0147", days: 4, due: 150000 },
        },
      ],
      total_label: "Total overdue",
      total_value: 415000,
      total_format: "money",
    }),
    chartArtifact({
      id: "demo-chart",
      title: "Revenue by week",
      subtitle: "August",
      area: "finance",
      chart: "bar",
      format: "money",
      points: [
        { label: "W1", value: 280000, tone: "info" },
        { label: "W2", value: 340000, tone: "info" },
        { label: "W3", value: 265000, tone: "info" },
        { label: "W4", value: 355000, tone: "positive" },
      ],
    }),
    metricsArtifact({
      id: "demo-metrics",
      title: "This month",
      subtitle: "August at a glance",
      area: "finance",
      metrics: [
        { label: "Revenue", value: 1240000, format: "money", delta: 12 },
        { label: "Expenses", value: 310000, format: "money", delta: -4 },
        { label: "New leads", value: 23, format: "number", delta: 21 },
        { label: "Projects at risk", value: 2, format: "number", tone: "warning" },
      ],
      actions: [
        { label: "Chase the overdue invoices", prompt: "Chase them", icon: "Mail" },
        { label: "Open Finance", href: "/finance", icon: "ExternalLink" },
      ],
    }),
  ];
}

/** A speech-shaped level signal: bursts and rests, not a hum. */
function useFakeVoice(active: boolean): number {
  const [level, setLevel] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      // Syllables at ~4Hz inside phrases at ~0.4Hz with silent gaps.
      const phrase = Math.max(0, Math.sin(t * 0.9) - 0.1) / 0.9;
      const syllable = 0.55 + 0.45 * Math.sin(t * 26 + Math.sin(t * 3) * 4);
      setLevel(0.22 * phrase * syllable);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return level;
}

const STATUSES: Status[] = ["idle", "listening", "thinking", "speaking"];

export function PreviewClient() {
  const [status, setStatus] = React.useState<Status>("idle");
  const [text, setText] = React.useState("");
  const [showArtifacts, setShowArtifacts] = React.useState(true);
  // Interactivity mode, two flavours: "sim" drives the pipeline from the
  // mouse (Space = pinch, no camera needed); "camera" runs the real thing.
  const [hands, setHands] = React.useState<"off" | "sim" | "camera">("off");
  const [streamingText, setStreamingText] = React.useState("");
  const level = useFakeVoice(status === "listening" || status === "speaking");

  const artifacts = React.useMemo(
    () => (showArtifacts ? demoArtifacts() : []),
    [showArtifacts],
  );

  const noop = React.useCallback(() => {}, []);
  const asyncOk = React.useCallback(async () => ({ ok: true }), []);

  // The preview's honesty layer: this page renders the REAL components on
  // MOCK data, so its buttons cannot reach the live app — but a click that
  // does nothing at all reads as a broken product, not a preview. Navigation
  // really navigates (to the login-gated page), and prompts echo what WOULD
  // have been sent.
  const [echo, setEcho] = React.useState<string | null>(null);
  // Exercises the rail's session wake mute without a real recogniser.
  const [wakePaused, setWakePaused] = React.useState(false);
  const say = React.useCallback((text: string) => {
    setEcho(text);
    window.setTimeout(() => setEcho((cur) => (cur === text ? null : cur)), 4000);
  }, []);
  const previewNavigate = React.useCallback((href: string) => {
    say(`OPENING ${href} — the live app takes over from here`);
    window.setTimeout(() => {
      window.location.href = href;
    }, 600);
  }, [say]);
  const previewPrompt = React.useCallback(
    (text: string) => say(`WOULD ASK ARCUS: “${text}”`),
    [say],
  );

  const chat = React.useMemo<VoiceChat>(
    () => ({
      status,
      messages: MESSAGES,
      level,
      heard: status === "listening",
      error: null,
      text,
      muted: false,
      busy: status === "thinking" || status === "speaking",
      setText,
      setMuted: noop as VoiceChat["setMuted"],
      toggleMic: () =>
        setStatus((s) => (s === "listening" ? "idle" : "listening")),
      sendText: noop,
      sendInvoice: asyncOk,
      sendSms: asyncOk,
      approveMission: asyncOk,
      handsFree: false,
      setHandsFree: noop,
      speak: async () => {},
      playClip: async () => {},
      listenWhenQuiet: async () => {},
      ingestArtifacts: noop,
      ingestTurn: noop,
      stopListening: noop,
      stop: () => setStatus("idle"),
      silence: () => setStatus("idle"),
      reset: noop,
      steps: status === "thinking" ? STEPS : [],
      streamingText,
      streaming: streamingText.length > 0,
      cancel: noop,
      transport: null,
      artifacts,
      latestArtifactId: artifacts[artifacts.length - 1]?.id ?? null,
      threads: [],
      activeThreadId: "demo",
      newThread: () => "demo",
      selectThread: noop,
      renameThread: noop,
      deleteThread: noop,
      searchThreads: () => [],
    }),
    [status, level, text, streamingText, artifacts, noop, asyncOk],
  );

  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      <CommandView
        chat={chat}
        firstName="Shahid"
        personaName="Arcus"
        onNavigate={previewNavigate}
        onPrompt={previewPrompt}
        composerRef={composerRef}
        wakeListening={!wakePaused}
        wakePaused={wakePaused}
        wakeHeard="hey arcus what's my revenue"
        onWakeToggle={() => setWakePaused((p) => !p)}
        isTerminal
        hands={hands !== "off"}
      />

      {/* Unmissable: this is the design preview, not the app. */}
      <div className="pointer-events-none absolute left-1/2 top-14 z-50 -translate-x-1/2">
        <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-300">
          Design preview · mock data
        </span>
      </div>

      {echo && (
        <div className="absolute bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-orange-400/40 bg-black/85 px-3 py-1.5 font-mono text-[11px] tracking-wider text-orange-300">
          {echo}
        </div>
      )}

      {/* Harness controls — bottom-left, out of the dock's way. */}
      <div className="absolute bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-xl border border-white/15 bg-black/70 p-1.5 backdrop-blur">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={
              "rounded-lg px-2.5 py-1 text-[11px] font-medium " +
              (status === s
                ? "bg-orange-500 text-white"
                : "text-slate-300 hover:bg-white/10")
            }
          >
            {s}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          onClick={() => setShowArtifacts((v) => !v)}
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10"
        >
          {showArtifacts ? "empty stage" : "artifacts"}
        </button>
        <button
          type="button"
          onClick={() =>
            setStreamingText((v) =>
              v ? "" : "Right away, sir — pulling the overdue list now…",
            )
          }
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10"
        >
          stream
        </button>
        <span className="mx-1 h-4 w-px bg-white/15" />
        {/* Toggling flips the localStorage flag BEFORE arming, because the
            hook reads it once per arm. Sim: mouse moves the hand, hold
            Space to pinch. Camera: the real pipeline, permission and all. */}
        <button
          type="button"
          onClick={() => {
            setHands((v) => {
              const next = v === "sim" ? "off" : "sim";
              try {
                window.localStorage.setItem(
                  "arc-hand-sim",
                  next === "sim" ? "1" : "0",
                );
              } catch {}
              return next;
            });
          }}
          className={
            "rounded-lg px-2.5 py-1 text-[11px] font-medium " +
            (hands === "sim"
              ? "bg-emerald-500 text-white"
              : "text-slate-300 hover:bg-white/10")
          }
        >
          hands·sim
        </button>
        <button
          type="button"
          onClick={() => {
            setHands((v) => {
              const next = v === "camera" ? "off" : "camera";
              try {
                window.localStorage.setItem("arc-hand-sim", "0");
              } catch {}
              return next;
            });
          }}
          className={
            "rounded-lg px-2.5 py-1 text-[11px] font-medium " +
            (hands === "camera"
              ? "bg-emerald-500 text-white"
              : "text-slate-300 hover:bg-white/10")
          }
        >
          hands·cam
        </button>
      </div>
    </div>
  );
}
