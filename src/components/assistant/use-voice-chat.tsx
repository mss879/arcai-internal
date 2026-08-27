"use client";

import * as React from "react";
import { CheckCircle2, Eye, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  AssistantCard,
  CardResolution,
  SmsCardData,
} from "@/lib/assistant-cards";
import {
  cardToArtifact,
  type Artifact,
} from "@/lib/assistant-artifacts";
import {
  createSseParser,
  type AssistantEvent,
  type ToolStep,
} from "@/lib/assistant-stream";
import {
  ACTIVE_THREAD_KEY,
  assistantId,
  deriveThreadTitle,
  loadActiveThreadId,
  loadThreads,
  matchesQuery,
  newThread as makeThread,
  saveActiveThreadId,
  saveThreads,
  sortThreads,
  summarise,
  type AssistantMessage,
  type AssistantThread,
  type ThreadSummary,
} from "@/lib/assistant-threads";
import {
  deleteThreadRemote,
  fetchRemoteThread,
  fetchThreadsIndex,
  mergeThreads,
  pushThread,
  type RemoteThread,
} from "@/lib/assistant-thread-sync";
import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";

/**
 * The voice engine shared by both Arc surfaces — the desktop Studio (bubble,
 * dock and the full-screen workspace) and the full-screen mobile experience.
 * It owns everything stateful about a conversation: microphone capture, level
 * metering + silence auto-stop, transcription, the model round-trip (streamed,
 * with the one-shot route as a fallback), spoken playback, the artifacts the
 * preview canvas renders, and the saved conversation history. The UIs that
 * consume it stay purely presentational.
 *
 * Called EXACTLY ONCE per surface. Two instances would mean two microphones
 * and two histories, so `<VoiceAssistant>` owns the desktop instance and
 * passes it down; `<MobileVoiceScreen>` owns its own (the two never coexist).
 */

/** @deprecated Use `AssistantEvent` from `@/lib/assistant-stream`. */
export type ToolEvent = AssistantEvent;
/** @deprecated Use `AssistantMessage` from `@/lib/assistant-threads`. */
export type Message = AssistantMessage;

export type SendInvoiceResult = { ok: boolean; error?: string };

export type Status = "idle" | "listening" | "thinking" | "speaking";

/** Which route served the last completed turn. Diagnostics only. */
export type Transport = "stream" | "fallback" | null;

const SILENCE_MS = 8000; // manual dictation: auto-stop this long after you
// STOP talking — enough to ride out breaths and mid-sentence pauses (tap the
// mic to stop sooner).
// HANDS-FREE is a conversation, not dictation: waiting 15s after every
// sentence is what made Arcus feel like it "takes forever to respond" — the
// reply cannot even begin until the mic closes. Stop fast instead.
const CONVERSATION_SILENCE_MS = 2500;
// A mic that heard NOTHING at all closes on its own. Without this, a wake
// that went unanswered left the recorder (and the OS mic light) on forever —
// with the wake word suspended the whole time it sat open.
const LISTEN_MAX_QUIET_MS = 10000;
// When the mic re-armed itself for a send-confirmation, the expected answer is
// a short "yes" / "no" — stop fast so the send feels instant, and give up
// quietly if the user says nothing at all (the card's buttons still work).
const CONFIRM_SILENCE_MS = 2000;
const CONFIRM_MAX_WAIT_MS = 8000;
const SPEECH_LEVEL = 0.04; // RMS above this counts as voice (gates out room noise)
const VOICE_FRAMES = 5; // need this many consecutive voiced frames to "arm"

/** How long after the last thread mutation the history is written to storage. */
const PERSIST_DEBOUNCE_MS = 600;

/** How many of the newest server threads are pulled in full on hydration.
 * The rest arrive when the user opens them — a cold start should not fetch a
 * hundred transcripts to paint a rail that shows titles. */
const REMOTE_HYDRATE_THREADS = 15;

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

/**
 * True when this window is inside an iframe.
 *
 * A framed copy of the app (Arc's own preview canvas, or a route that
 * redirected out of `?embed=1`) mounts its own engine, hydrates the saved
 * threads, and would then write that now-stale snapshot back over the
 * conversation the real window is still adding to. Framed windows read
 * history; they never write it.
 */
function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access — which itself means framed.
    return true;
  }
}

/**
 * What the user is looking at, for the prompt's situational line (0104).
 * Read at SEND time, not mount time — they navigate mid-conversation. The
 * title strips the app suffix so the model sees "Silva Motors", not
 * "Silva Motors · ARC AI".
 */
function pageContext(): { pathname: string; title?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const pathname = window.location.pathname;
    const title = document.title.replace(/\s*[·|–-]\s*ARC AI.*$/i, "").trim();
    return { pathname, ...(title ? { title } : {}) };
  } catch {
    return undefined;
  }
}

function looksLikeNoise(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[.!?,]+$/g, "").trim();
  return norm.length < 2 || HALLUCINATIONS.has(norm);
}

// While a send-confirmation card is pending, the mic re-arms so the user can
// just say "yes, send it". Negatives are checked first so "no, don't send"
// never reads as a yes; anything that matches neither goes to the model as a
// normal message (e.g. "change the amount to fifty thousand").
const CONFIRM_NO_RE =
  /\b(no|nope|don'?t|do not|cancel|stop|wait|hold on|not yet|wrong|incorrect|change|edit)\b/i;
const CONFIRM_YES_RE =
  /\b(yes|yeah|yep|yup|sure|correct|confirm|confirmed|okay|ok|go ahead|do it|send( it)?|looks good|perfect|that'?s right)\b/i;

/**
 * Where a pending confirm card lives.
 *
 * `threadId` is not decoration: with history, a bare `msgIndex` into "the"
 * messages array points at a different card the moment the user switches
 * conversation, and a spoken "yes" would send the wrong thing.
 */
type PendingConfirm = {
  threadId: string;
  msgIndex: number;
  cardIndex: number;
};

function lastConfirmCardIndex(cards: AssistantCard[]): number {
  for (let i = cards.length - 1; i >= 0; i--) {
    const t = cards[i].type;
    if (t === "confirm_send" || t === "confirm_send_sms") return i;
  }
  return -1;
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

// A tiny valid silent WAV, used to "unlock" audio playback on the first tap so
// iOS/Safari will let later spoken replies play. Built once, lazily.
let _silentClip: string | null = null;
function silentClip(): string {
  if (_silentClip) return _silentClip;
  const sampleRate = 8000;
  const samples = 800; // ~100ms of silence
  const dataLen = samples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  _silentClip = "data:audio/wav;base64," + btoa(bin);
  return _silentClip;
}

const EMPTY_MESSAGES: AssistantMessage[] = [];
const EMPTY_STEPS: ToolStep[] = [];

function userMessage(content: string): AssistantMessage {
  return { id: assistantId("m"), role: "user", content, at: Date.now() };
}

function assistantMessage(
  content: string,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id: assistantId("m"),
    role: "assistant",
    content,
    at: Date.now(),
    ...extra,
  };
}

/**
 * Every artifact in a thread, oldest first, de-duplicated by id with the
 * LATEST version winning at the ORIGINAL position.
 *
 * That combination is what makes "make it 140 thousand" update the proposal
 * tab already open instead of pushing a second, nearly identical tab — as long
 * as the server reuses the artifact id, which is the contract.
 */
function collectArtifacts(messages: AssistantMessage[]): Artifact[] {
  const order: string[] = [];
  const byId = new Map<string, Artifact>();
  const add = (artifact: Artifact) => {
    if (!byId.has(artifact.id)) order.push(artifact.id);
    byId.set(artifact.id, artifact);
  };
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) add(artifact);
    // A proposal or an invoice arrives as a CARD. Promote it here so the
    // document opens in the canvas beside the conversation — without this the
    // thing the user just asked Arc to write has nowhere to be looked at.
    for (const card of message.cards ?? []) {
      const promoted = cardToArtifact(card);
      if (promoted) add(promoted);
    }
  }
  return order.map((id) => byId.get(id) as Artifact);
}

/** The artifact a finished turn should leave open, cards included. */
function turnArtifacts(
  artifacts: Artifact[],
  cards: AssistantCard[],
): Artifact[] {
  const promoted = cards
    .map(cardToArtifact)
    .filter((a): a is Artifact => a !== null);
  const seen = new Set(artifacts.map((a) => a.id));
  return [...artifacts, ...promoted.filter((a) => !seen.has(a.id))];
}

export type VoiceChat = {
  status: Status;
  /** Messages of the ACTIVE thread. */
  messages: AssistantMessage[];
  level: number;
  /** Speech detected in the current capture — drives "I hear you" copy. */
  heard: boolean;
  error: string | null;
  text: string;
  muted: boolean;
  busy: boolean;
  setText: (value: string) => void;
  setMuted: React.Dispatch<React.SetStateAction<boolean>>;
  toggleMic: () => void;
  sendText: (value: string) => void;
  /** Actually email a saved invoice — fired only by the user's Send tap. */
  sendInvoice: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
  /** Actually send a prepared SMS — fired only by the user's Send tap. */
  sendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
  /** Start a mission the user approved (0103). */
  approveMission: (missionId: string) => Promise<SendInvoiceResult>;
  /** True while the mic re-opens itself after every reply (0104). */
  handsFree: boolean;
  setHandsFree: (value: boolean) => void;
  /**
   * Say something out loud, unprompted (0104 — the terminal's wake ack and
   * ambient alerts). Owns the shared player, the autoplay unlock and the
   * status transition, so the wake word suspends itself while this talks.
   */
  speak: (reply: string) => Promise<void>;
  /** Play a precached clip instantly — greeting / wake ack (0104). */
  playClip: (url: string) => Promise<void>;
  /** Open the mic once nothing is being spoken — the wake flow's handoff. */
  listenWhenQuiet: () => Promise<void>;
  /** Surface artifacts from a live-voice tool call (0104). */
  ingestArtifacts: (artifacts: Artifact[]) => void;
  /** Commit a finished live-voice exchange into the thread (0104). */
  ingestTurn: (turn: {
    user: string;
    assistant: string;
    artifacts: Artifact[];
    cards: AssistantCard[];
  }) => void;
  stopListening: () => void;
  /** Stop capture + playback without wiping the transcript. */
  stop: () => void;
  /** Shut up NOW — clears the clip queue and blocks any reply already being
   *  synthesised from ever playing. What closing the panel must call. */
  silence: () => void;
  /** Stop everything and clear the ACTIVE thread. */
  reset: () => void;

  // ── the turn in flight ─────────────────────────────────────────────────
  /** Tool steps for the current turn; empty when idle. Arrival order. */
  steps: ToolStep[];
  /** Deltas assembled so far for the in-flight reply; "" when none. */
  streamingText: string;
  streaming: boolean;
  /** Abort the in-flight turn and playback. The transcript is left intact. */
  cancel: () => void;
  /** Which transport served the last completed turn. */
  transport: Transport;

  // ── artifacts ──────────────────────────────────────────────────────────
  /** Every artifact in the active thread, oldest first, de-duped by id. */
  artifacts: Artifact[];
  /** Id of the most recently received artifact, or null. */
  latestArtifactId: string | null;

  // ── threads ────────────────────────────────────────────────────────────
  threads: ThreadSummary[];
  activeThreadId: string;
  /** Creates, activates and returns the new thread id. */
  newThread: () => string;
  selectThread: (id: string) => void;
  renameThread: (id: string, title: string) => void;
  deleteThread: (id: string) => void;
  /** Full-body search over the saved threads. Empty query → all threads. */
  searchThreads: (query: string) => ThreadSummary[];
};

export function useVoiceChat(): VoiceChat {
  const [status, setStatus] = React.useState<Status>("idle");
  const [muted, setMuted] = React.useState(false);
  const [text, setText] = React.useState("");
  const [level, setLevel] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  /** Speech was detected in the CURRENT capture — the "I hear you" light. */
  const [heard, setHeard] = React.useState(false);

  // History. `threads` is the whole store; the UI reads the active thread's
  // messages. One source of truth means a rename or a delete can never leave
  // the transcript pointing at something that no longer exists.
  const [threads, setThreads] = React.useState<AssistantThread[]>(() => [
    makeThread(),
  ]);
  const [activeThreadId, setActiveThreadId] = React.useState<string>(
    () => threads[0].id,
  );
  const [hydrated, setHydrated] = React.useState(false);
  /** Keep listening after each reply — set from Studio settings (0104). */
  const [handsFree, setHandsFreeState] = React.useState(false);

  const [steps, setSteps] = React.useState<ToolStep[]>(EMPTY_STEPS);
  const [streamingText, setStreamingText] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [transport, setTransport] = React.useState<Transport>(null);
  const [latestArtifactId, setLatestArtifactId] = React.useState<string | null>(
    null,
  );
  // Artifacts that have arrived on the stream but whose turn has not committed
  // yet. Without this the preview canvas would sit empty until the model
  // finished talking, when the whole point is watching the document appear.
  const [liveArtifacts, setLiveArtifacts] = React.useState<Artifact[]>([]);

  // Audio plumbing kept in refs so re-renders don't disturb capture.
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const hasSpokenRef = React.useRef(false);
  const lastLoudRef = React.useRef(0);
  const playerRef = React.useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = React.useRef(false);
  const currentUrlRef = React.useRef<string | null>(null);
  const mutedRef = React.useRef(muted);
  React.useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const busy = status === "thinking" || status === "speaking";

  const activeThread = React.useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const messages = activeThread?.messages ?? EMPTY_MESSAGES;

  const messagesRef = React.useRef(messages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const threadsRef = React.useRef(threads);
  React.useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  const activeThreadIdRef = React.useRef(activeThreadId);
  React.useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);
  const statusRef = React.useRef(status);
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Voice-confirm plumbing. A pending confirm card + "the user was talking"
  // means we re-open the mic after the reply so a spoken yes/no can resolve it.
  const pendingConfirmRef = React.useRef<PendingConfirm | null>(null);
  const lastInputVoiceRef = React.useRef(false);
  // Set just before an automatic re-arm; consumed by startListening so that
  // one capture session uses the fast confirm timings instead of dictation's.
  const autoListenRef = React.useRef(false);
  /**
   * Hands-free: keep the conversation open after each reply (0104).
   *
   * A ref as well as state because `maybeAutoListen` is called from audio
   * callbacks that captured their closure long before the user toggled it.
   */
  const handsFreeRef = React.useRef(false);
  /** Pending re-arm timer, so unmount can cancel it. */
  const autoListenTimerRef = React.useRef<number | null>(null);
  /** A capture is being opened RIGHT NOW — guards overlapping getUserMedia. */
  const micOpeningRef = React.useRef(false);
  /**
   * Bumped by `silence()`. Every speech path captures this before its first
   * await and refuses to make a sound if it has moved on since — the only
   * reliable way to stop a reply whose TTS was already in flight when the
   * user closed the panel.
   */
  const speechEpochRef = React.useRef(0);
  /**
   * The next capture is a WAKE-INITIATED one-shot: snappy conversational
   * timings without turning hands-free on. Consumed by `openMicrophone`.
   */
  const conversationalRef = React.useRef(false);
  /**
   * This turn came from the wake word, so it gets ONE answer and then the
   * microphone closes — even when hands-free is switched on. Being called by
   * name is a command, not an invitation to transcribe the room; hands-free
   * still governs turns the user starts by tapping the mic themselves.
   */
  const oneShotRef = React.useRef(false);
  /**
   * Silenced until the user asks for something again. `speak()` has several
   * early exits (muted, empty reply, a failed TTS fetch) that re-arm the
   * microphone without ever touching the player, so the epoch checks alone
   * do not cover them — this does. Cleared by any deliberate act: tapping
   * the mic, typing, or a fresh wake.
   */
  const silencedRef = React.useRef(false);
  const startListeningRef = React.useRef<() => void>(() => {});

  // The turn in flight.
  const turnAbortRef = React.useRef<AbortController | null>(null);
  const pendingDeltaRef = React.useRef("");
  const flushRafRef = React.useRef<number | null>(null);

  // ---- history persistence -----------------------------------------------

  /**
   * Threads changed locally since the last successful push (0101).
   *
   * Only these are sent to the server, and — just as importantly — only these
   * are protected from being overwritten by an incoming realtime refetch: a
   * thread the user is typing into right now must not be replaced by the
   * server's older copy of it.
   */
  const dirtyThreadsRef = React.useRef<Set<string>>(new Set());
  const markDirty = React.useCallback((id: string) => {
    dirtyThreadsRef.current.add(id);
  }, []);

  // Restore after mount. Reading storage during render would be a hydration
  // mismatch, so the first paint is always the empty "New chat".
  //
  // Local first, then the server: the cache paints instantly and the network
  // reconciles a moment later. A signed-out or offline browser simply keeps
  // the cache — every sync helper fails silently by design.
  React.useEffect(() => {
    const stored = loadThreads();
    if (stored.length > 0) {
      const ordered = sortThreads(stored);
      setThreads(ordered);
      const savedId = loadActiveThreadId();
      const exists = savedId && ordered.some((t) => t.id === savedId);
      setActiveThreadId(exists ? (savedId as string) : ordered[0].id);
    }
    setHydrated(true);

    // A framed copy of the app reads history but never writes it, remotely or
    // locally — otherwise a preview-canvas iframe would push its stale
    // snapshot over the live conversation.
    if (isFramed()) return;

    let cancelled = false;
    void (async () => {
      const index = await fetchThreadsIndex();
      if (!index || cancelled) return;

      // Bodies for the newest handful only. The rest arrive when selected,
      // and the merge leaves what it doesn't know about untouched.
      const wanted = index.threads.slice(0, REMOTE_HYDRATE_THREADS);
      const bodies = await Promise.all(
        wanted.map((meta) => fetchRemoteThread(meta.id)),
      );
      if (cancelled) return;

      const remote = bodies.filter((t): t is RemoteThread => t !== null);
      if (!remote.length && !index.deleted.length) return;

      let survivors: AssistantThread[] = [];
      setThreads((prev) => {
        const merged = mergeThreads(prev, remote, index.deleted);
        survivors = merged.length ? merged : prev;
        return survivors;
      });
      // A conversation deleted on another device must not stay selected here;
      // fall back to the newest one that survived the merge.
      setActiveThreadId((current) =>
        index.deleted.includes(current) && survivors.length
          ? survivors[0].id
          : current,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced write. Never persists a turn in flight — `steps` still running
  // and `streamingText` are deliberately excluded from the message record.
  React.useEffect(() => {
    if (!hydrated || isFramed()) return;
    const t = window.setTimeout(() => {
      saveThreads(threads);
      // Same debounce carries the threads to the server. Clearing the id
      // before awaiting keeps a push that is still in flight from blocking
      // the next edit's push.
      const dirty = [...dirtyThreadsRef.current];
      if (!dirty.length) return;
      dirtyThreadsRef.current.clear();
      for (const id of dirty) {
        const thread = threads.find((t) => t.id === id);
        // Nothing to say yet: an empty "New chat" is not worth a row.
        if (!thread || thread.messages.length === 0) continue;
        void pushThread(thread).then((ok) => {
          // Failed pushes stay dirty so the next debounce retries them.
          if (!ok) dirtyThreadsRef.current.add(id);
        });
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [threads, hydrated]);

  // Live updates from elsewhere: another device continuing a conversation, or
  // the tick dropping in a briefing thread. Locally-dirty threads are skipped
  // — the copy being typed into wins until its own push lands.
  useArcusRealtime(
    "assistant_threads",
    React.useCallback((payload) => {
      const row = (payload.new ?? payload.old) as { id?: string } | null;
      const id = row?.id;
      if (!id || dirtyThreadsRef.current.has(id)) return;
      void (async () => {
        const remote = await fetchRemoteThread(id);
        if (!remote) return;
        setThreads((prev) => mergeThreads(prev, [remote], []));
      })();
    }, []),
    hydrated && !isFramed(),
  );

  React.useEffect(() => {
    if (!hydrated || !activeThreadId || isFramed()) return;
    saveActiveThreadId(activeThreadId);
  }, [activeThreadId, hydrated]);

  /** Replace one thread's messages, bumping `updatedAt` and the auto-title. */
  const setThreadMessages = React.useCallback(
    (threadId: string, next: AssistantMessage[]) => {
      markDirty(threadId);
      setThreads((prev) =>
        prev.map((thread) => {
          if (thread.id !== threadId) return thread;
          const updated: AssistantThread = {
            ...thread,
            messages: next,
            updatedAt: Date.now(),
          };
          updated.title = deriveThreadTitle(updated);
          return updated;
        }),
      );
    },
    [markDirty],
  );

  /**
   * Append to a thread's CURRENT messages.
   *
   * Deliberately not `setThreadMessages(id, [...snapshot, message])`: the
   * confirm-card flow writes a card resolution ("sending" → "sent") into the
   * same thread between taking a snapshot and appending its reply, and
   * replacing the array with that stale snapshot silently reverts the
   * resolution — which puts a live Send button back on an invoice that has
   * already gone out. Appending inside the updater can't lose a write.
   */
  const appendThreadMessages = React.useCallback(
    (threadId: string, ...toAppend: AssistantMessage[]) => {
      if (toAppend.length === 0) return;
      markDirty(threadId);
      setThreads((prev) =>
        prev.map((thread) => {
          if (thread.id !== threadId) return thread;
          const updated: AssistantThread = {
            ...thread,
            messages: [...thread.messages, ...toAppend],
            updatedAt: Date.now(),
          };
          updated.title = deriveThreadTitle(updated);
          return updated;
        }),
      );
    },
    [markDirty],
  );

  // ---- audio --------------------------------------------------------------

  // One reusable <audio> element for all spoken replies.
  const getPlayer = React.useCallback(() => {
    if (!playerRef.current && typeof Audio !== "undefined") {
      const el = new Audio();
      el.preload = "auto";
      playerRef.current = el;
    }
    return playerRef.current;
  }, []);

  /**
   * Meter Arcus's OWN voice (0104).
   *
   * `level` has always been the microphone: real RMS while you talk, nothing
   * while Arcus talks. The visualizer papered over that with a synthetic sine
   * envelope during `speaking` — which is exactly the "the animation doesn't
   * match the voice" complaint, because it pulsed on a timer, not the audio.
   *
   * This routes the reply player through an AnalyserNode so `level` carries
   * the real waveform in both directions. Two Web Audio rules shape the code:
   * `createMediaElementSource` may be called ONCE per element ever (so the
   * source node is cached for the player's lifetime), and once an element is
   * routed through a context it is silent unless the graph reaches
   * `ctx.destination` (so the chain connects through, not just to the
   * analyser). If any of it throws, playback continues unmetered — a silent
   * assistant would be a far worse bug than a still orb.
   */
  const speechMeterRef = React.useRef<{
    ctx: AudioContext;
    analyser: AnalyserNode;
    buf: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const speechRafRef = React.useRef<number | null>(null);

  const stopSpeechMeter = React.useCallback(() => {
    if (speechRafRef.current) cancelAnimationFrame(speechRafRef.current);
    speechRafRef.current = null;
    setLevel(0);
  }, []);

  const startSpeechMeter = React.useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    try {
      if (!speechMeterRef.current) {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(el);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        speechMeterRef.current = {
          ctx,
          analyser,
          buf: new Uint8Array(analyser.fftSize),
        };
      }
      const meter = speechMeterRef.current;
      void meter.ctx.resume();

      let frame = 0;
      const tick = () => {
        // The player owns the loop's lifetime: metering past `ended` would
        // hold `level` at the last frame's value instead of falling to rest.
        if (el.paused || el.ended) {
          stopSpeechMeter();
          return;
        }
        // Every OTHER frame. 30 updates a second is indistinguishable on a
        // glow ring, and each update is a React render of the shell — this
        // halves the render pressure for the whole time Arcus is talking.
        frame++;
        if (frame % 2 === 0) {
          meter.analyser.getByteTimeDomainData(meter.buf);
          let sum = 0;
          for (let i = 0; i < meter.buf.length; i++) {
            const v = (meter.buf[i] - 128) / 128;
            sum += v * v;
          }
          setLevel(Math.sqrt(sum / meter.buf.length));
        }
        speechRafRef.current = requestAnimationFrame(tick);
      };
      if (speechRafRef.current) cancelAnimationFrame(speechRafRef.current);
      speechRafRef.current = requestAnimationFrame(tick);
    } catch {
      // Metering is a nicety. The reply still plays.
    }
  }, [stopSpeechMeter]);

  // Must run inside a user gesture (tap). Plays a silent clip so the browser
  // marks the element as user-initiated; later replies can then auto-play —
  // without this, voice replies are silent on iOS/Safari.
  const unlockAudio = React.useCallback(() => {
    if (audioUnlockedRef.current) return;
    const el = getPlayer();
    if (!el) return;
    audioUnlockedRef.current = true;
    try {
      el.muted = true;
      el.src = silentClip();
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }).catch(() => {
          el.muted = false;
        });
      } else {
        el.muted = false;
      }
    } catch {
      el.muted = false;
    }
  }, [getPlayer]);

  /**
   * A short two-note blip meaning "captured — working on it" (0104-fix).
   *
   * Synthesised on the spot so there is no asset to load. The chief doubt in
   * a voice UI is whether it heard anything at all, and a visual state alone
   * is invisible from across the room — which is where a wake word puts you.
   */
  const cueCtxRef = React.useRef<AudioContext | null>(null);
  const playCaptureCue = React.useCallback(() => {
    if (mutedRef.current) return;
    try {
      const ctx = (cueCtxRef.current ??= new AudioContext());
      void ctx.resume();
      const at = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.1, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, at);
      osc.frequency.setValueAtTime(880, at + 0.1);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 0.24);
    } catch {
      // A missing chirp is not a problem worth surfacing.
    }
  }, []);

  const teardownCapture = React.useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  /** Drop any buffered deltas and the frame that was going to flush them. */
  const cancelDeltaFlush = React.useCallback(() => {
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }
    pendingDeltaRef.current = "";
  }, []);

  /**
   * Buffer a delta and schedule ONE animation frame to apply it.
   *
   * Tokens arrive far faster than the screen refreshes; setting state per
   * token re-renders the transcript ~60+ times a second and drags the whole
   * workspace (and any live PDF iframe) with it.
   */
  const pushDelta = React.useCallback((chunk: string) => {
    pendingDeltaRef.current += chunk;
    if (flushRafRef.current !== null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      const buffered = pendingDeltaRef.current;
      pendingDeltaRef.current = "";
      if (buffered) setStreamingText((prev) => prev + buffered);
    });
  }, []);

  // Clean everything up on unmount: abort the turn, stop capture, stop
  // playback, and free the last spoken blob.
  React.useEffect(() => {
    return () => {
      turnAbortRef.current?.abort();
      if (flushRafRef.current !== null) cancelAnimationFrame(flushRafRef.current);
      // A queued voice-confirm re-arm must never outlive the surface.
      if (autoListenTimerRef.current !== null) {
        window.clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
      pendingConfirmRef.current = null;
      // Stop the recorder before its stream is torn down, so `onstop` cannot
      // fire a transcription for a component that no longer exists.
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        try {
          recorder.stop();
        } catch {
          // Already stopping; the track teardown below is what matters.
        }
      }
      recorderRef.current = null;
      teardownCapture();
      playerRef.current?.pause();
      cueCtxRef.current?.close().catch(() => {});
      cueCtxRef.current = null;
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    };
  }, [teardownCapture]);

  /** Record a confirm card's outcome on the message it belongs to. */
  const updateCardResolution = React.useCallback(
    (target: PendingConfirm, resolution: CardResolution) => {
      setThreads((prev) =>
        prev.map((thread) =>
          thread.id !== target.threadId
            ? thread
            : {
                ...thread,
                messages: thread.messages.map((m, i) =>
                  i !== target.msgIndex
                    ? m
                    : {
                        ...m,
                        cards: m.cards?.map((c, j) =>
                          j !== target.cardIndex
                            ? c
                            : ({ ...c, resolution } as AssistantCard),
                        ),
                      },
                ),
              },
        ),
      );
    },
    [],
  );

  /**
   * Re-open the microphone after a reply, when it makes sense to.
   *
   * Two cases, both of which mean the user is mid-conversation with their
   * hands elsewhere:
   *
   *   - a confirm card is waiting and they were speaking, so a spoken "yes"
   *     should resolve it without a tap (the original behaviour); or
   *   - HANDS-FREE is on and the last thing they did was speak — the
   *     conversation simply continues, which is what makes "Hey Arcus" worth
   *     having: wake it once, then talk.
   */
  const maybeAutoListen = React.useCallback(() => {
    // Closed, cancelled or otherwise hushed: nothing automatic re-opens the
    // microphone until the user does something deliberate.
    if (silencedRef.current) return;
    const wantsConfirm = Boolean(pendingConfirmRef.current);
    // A wake-word turn is over when its answer lands. The only thing allowed
    // to re-open the mic is a confirm card, because that IS a direct question
    // ("shall I send it?") and answering it out loud is the whole point.
    const oneShot = oneShotRef.current;
    if (oneShot && !wantsConfirm) {
      oneShotRef.current = false;
      return;
    }
    const wantsHandsFree =
      handsFreeRef.current && lastInputVoiceRef.current && !oneShot;
    if (!wantsHandsFree && !(wantsConfirm && lastInputVoiceRef.current)) return;
    // Tracked so unmounting during the delay can cancel it — otherwise the
    // microphone opens after the surface is gone, with nothing left alive to
    // stop the recorder or release the track.
    window.clearTimeout(autoListenTimerRef.current ?? undefined);
    autoListenTimerRef.current = window.setTimeout(() => {
      autoListenTimerRef.current = null;
      if (statusRef.current !== "idle") return;
      // The fast confirm timings are only right when a yes/no is expected;
      // an open-ended hands-free turn needs room to think mid-sentence.
      if (pendingConfirmRef.current) {
        autoListenRef.current = true;
        startListeningRef.current();
      } else if (handsFreeRef.current && lastInputVoiceRef.current) {
        startListeningRef.current();
      }
    }, 350);
  }, []);

  const speak = React.useCallback(
    async (reply: string) => {
      if (mutedRef.current || !reply.trim()) {
        setStatus("idle");
        maybeAutoListen();
        return;
      }
      const el = getPlayer();
      if (!el) {
        setStatus("idle");
        maybeAutoListen();
        return;
      }
      // Everything below is on the far side of a network round trip. If the
      // user closes the panel while the voice is being synthesised, this is
      // what stops the finished audio from playing into an empty room.
      const epoch = speechEpochRef.current;
      try {
        setStatus("speaking");
        const res = await fetch("/api/assistant/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: reply }),
        });
        if (!res.ok) {
          setStatus("idle");
          maybeAutoListen();
          return;
        }
        const blob = await res.blob();
        if (epoch !== speechEpochRef.current) return; // silenced meanwhile
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
        const url = URL.createObjectURL(blob);
        currentUrlRef.current = url;
        el.muted = false;
        el.src = url;
        const done = () => {
          stopSpeechMeter();
          if (epoch !== speechEpochRef.current) return; // silenced meanwhile
          setStatus("idle");
          maybeAutoListen();
        };
        el.onended = done;
        el.onerror = done;
        await el.play();
        // After play() resolves, so the AudioContext resume isn't racing the
        // browser's own autoplay decision.
        startSpeechMeter();
      } catch {
        // Autoplay can still be refused; the reply is already shown as text.
        stopSpeechMeter();
        setStatus("idle");
        maybeAutoListen();
      }
    },
    [getPlayer, maybeAutoListen, startSpeechMeter, stopSpeechMeter],
  );

  /**
   * One clip AFTER another, never over it (0104-fix).
   *
   * The greeting and the wake ack share the single reply player, and the two
   * genuinely collide — say "hey Arcus" while the greeting is mid-sentence
   * and the ack used to preempt it mid-word, which read as Arcus cutting
   * itself off. Queuing on a promise chain means whatever is being said
   * finishes first; the chain also gives the wake flow one true answer to
   * "is anything still talking?" before it opens the microphone.
   */
  const playbackChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const enqueuePlayback = React.useCallback((run: () => Promise<void>) => {
    const chained = playbackChainRef.current.then(run, run);
    playbackChainRef.current = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }, []);

  /**
   * Play an ALREADY-SYNTHESISED clip — the greeting and the wake ack (0104).
   *
   * `speak()` costs a TTS round trip, which is fine for replies but wrong for
   * the two lines that must land the instant something happens. Those are
   * fetched once and cached as object URLs (`useVoiceClip`); this plays one
   * through the same shared player, so the meter, the status transition and
   * the wake word's self-suspension all behave exactly as for a real reply.
   */
  const playClip = React.useCallback(
    (url: string) => {
      // Captured at QUEUE time, checked at PLAY time: a clip queued behind
      // the greeting must not still speak up after the panel was closed.
      const epoch = speechEpochRef.current;
      return enqueuePlayback(async () => {
        if (mutedRef.current || !url) return;
        if (epoch !== speechEpochRef.current) return; // silenced meanwhile
        const el = getPlayer();
        if (!el) return;
        // Resolves when PLAYBACK ENDS, not when it starts — the wake flow
        // chains "open the microphone" on it, and a fixed timer would either
        // clip a long ack phrase or leave dead air after a short one.
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (mode: "natural" | "stopped" | "preempted") => {
            if (done) return;
            done = true;
            el.onended = null;
            el.onerror = null;
            el.onpause = null;
            el.onemptied = null;
            stopSpeechMeter();
            // Silenced while this was playing: settle the promise so nothing
            // awaiting it hangs, but touch NOTHING else — the panel is shut,
            // and re-arming the mic here is the bug this whole pass is about.
            if (epoch === speechEpochRef.current) {
              // "preempted" means another speaker (a reply via speak()) now
              // owns the player AND the status — stomping it to idle here
              // would un-suspend the wake word while Arcus is mid-sentence.
              // The guard also keeps a finished clip from clobbering the
              // status of a turn that is still thinking.
              if (mode !== "preempted") {
                setStatus((s) => (s === "speaking" ? "idle" : s));
              }
              // Only a clip that PLAYED OUT re-arms the mic; a pause means
              // someone intervened (stop, cancel) and silence is the answer.
              if (mode === "natural") maybeAutoListen();
            }
            resolve();
          };
          try {
            setStatus("speaking");
            el.muted = false;
            el.src = url;
            el.onended = () => finish("natural");
            el.onerror = () => finish("stopped");
            // stop()/cancel() PAUSE the player rather than ending it; without
            // this the promise never settles and everything queued behind it
            // — including the wake flow's "open the mic now" — waits forever.
            // (`el.ended` distinguishes a browser that pauses on natural end.)
            el.onpause = () => finish(el.ended ? "natural" : "stopped");
            el.play()
              .then(() => {
                startSpeechMeter();
                // If anything else claims the player by swapping `src`,
                // settle rather than wedge the queue. Assigned only now:
                // our OWN src swap above queues an 'emptied' task that
                // would otherwise kill this very clip.
                el.onemptied = () => finish("preempted");
              })
              .catch(() => finish("stopped"));
          } catch {
            finish("stopped");
          }
        });
      });
    },
    [enqueuePlayback, getPlayer, maybeAutoListen, startSpeechMeter, stopSpeechMeter],
  );

  /**
   * Land a live-voice exchange in the SAME thread store the classic pipeline
   * writes (0104). The Realtime session produces its own transcripts and its
   * tools return artifacts through the relay route; this commits them so the
   * conversation history and the stage cannot tell which engine served a
   * turn — one history, whatever the transport.
   */
  const ingestArtifacts = React.useCallback((incoming: Artifact[]) => {
    if (!incoming.length) return;
    setLiveArtifacts((prev) => {
      const next = [...prev];
      for (const artifact of incoming) {
        const i = next.findIndex((a) => a.id === artifact.id);
        if (i >= 0) next[i] = artifact;
        else next.push(artifact);
      }
      return next;
    });
    setLatestArtifactId(incoming[incoming.length - 1].id);
  }, []);

  const ingestTurn = React.useCallback(
    (turn: {
      user: string;
      assistant: string;
      artifacts: Artifact[];
      cards: AssistantCard[];
    }) => {
      const threadId = activeThreadIdRef.current;
      const toAppend: AssistantMessage[] = [];
      if (turn.user.trim()) toAppend.push(userMessage(turn.user.trim()));
      toAppend.push(
        assistantMessage(turn.assistant.trim() || "(spoken reply)", {
          ...(turn.artifacts.length ? { artifacts: turn.artifacts } : {}),
          ...(turn.cards.length ? { cards: turn.cards } : {}),
        }),
      );
      appendThreadMessages(threadId, ...toAppend);
      // The committed message now carries the artifacts; clearing the live
      // copies stops the merge memo counting them twice — the same handoff
      // the stream commit performs.
      setLiveArtifacts([]);
    },
    [appendThreadMessages],
  );

  const sendInvoice = React.useCallback(
    async (
      invoiceId: string,
      emails: string[],
      message?: string,
    ): Promise<SendInvoiceResult> => {
      // A manual Send tap supersedes any pending voice confirmation.
      pendingConfirmRef.current = null;
      try {
        const res = await fetch("/api/assistant/send-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId, emails, message }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          return { ok: false, error: data?.error || "Could not send the invoice." };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not reach the server." };
      }
    },
    [],
  );

  /**
   * Start a mission the user just approved (0103).
   *
   * Deliberately shaped like `sendInvoice`: a plain fetch from the browser,
   * carrying the user's own session. There is no tool that can call this
   * route, which is what makes "approve" a human act rather than something
   * the model can decide for itself.
   */
  /** Toggle hands-free, keeping the ref the audio callbacks read in sync. */
  const setHandsFree = React.useCallback((value: boolean) => {
    handsFreeRef.current = value;
    setHandsFreeState(value);
  }, []);

  const approveMission = React.useCallback(
    async (missionId: string): Promise<SendInvoiceResult> => {
      try {
        const res = await fetch(
          `/api/assistant/missions/${encodeURIComponent(missionId)}/approve`,
          { method: "POST" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          return { ok: false, error: data?.error || "Could not start the mission." };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not reach the server." };
      }
    },
    [],
  );

  const sendSms = React.useCallback(
    async (sms: SmsCardData): Promise<SendInvoiceResult> => {
      pendingConfirmRef.current = null;
      try {
        const res = await fetch("/api/assistant/send-sms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toNumber: sms.to_number,
            message: sms.message,
            clientId: sms.client_id,
            leadId: sms.lead_id,
            clientName: sms.client_name,
            kind: sms.kind,
            invoiceId: sms.invoice_id,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          return { ok: false, error: data?.error || "Could not send the SMS." };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not reach the server." };
      }
    },
    [],
  );

  /**
   * If a confirm card is pending and the user's words are a clear yes or no,
   * resolve it right here — the send still happens through the same
   * user-action-only routes as the buttons, never through the model. Returns
   * true when the words were consumed; false hands them to the chat as usual.
   */
  const resolvePendingConfirm = React.useCallback(
    async (said: string): Promise<boolean> => {
      const pending = pendingConfirmRef.current;
      if (!pending) return false;
      // A confirmation belongs to the conversation it was raised in.
      if (pending.threadId !== activeThreadIdRef.current) {
        pendingConfirmRef.current = null;
        return false;
      }
      const card =
        messagesRef.current[pending.msgIndex]?.cards?.[pending.cardIndex];
      if (
        !card ||
        (card.type !== "confirm_send" && card.type !== "confirm_send_sms") ||
        card.resolution
      ) {
        pendingConfirmRef.current = null;
        return false;
      }

      const isNo = CONFIRM_NO_RE.test(said);
      const isYes = !isNo && CONFIRM_YES_RE.test(said);
      if (!isNo && !isYes) return false;

      pendingConfirmRef.current = null;
      const threadId = pending.threadId;
      // Appended, never replaced: `updateCardResolution` writes into this same
      // thread below and a snapshot-and-replace would undo it.
      appendThreadMessages(threadId, userMessage(said));

      if (isNo) {
        updateCardResolution(pending, { state: "cancelled" });
        const reply = "Okay, cancelled — nothing was sent.";
        appendThreadMessages(threadId, assistantMessage(reply));
        await speak(reply);
        return true;
      }

      setStatus("thinking");
      updateCardResolution(pending, { state: "sending" });
      const res =
        card.type === "confirm_send_sms"
          ? await sendSms(card.sms)
          : await sendInvoice(card.invoice.id, card.emails, card.message);

      let reply: string;
      if (res.ok) {
        updateCardResolution(pending, { state: "sent" });
        reply =
          card.type === "confirm_send_sms"
            ? `Done — the text is on its way to ${card.sms.to_display}.`
            : `Done — the invoice is on its way to ${card.emails.join(", ")}.`;
      } else {
        updateCardResolution(pending, { state: "error", error: res.error });
        reply = `That didn't go through — ${res.error ?? "the send failed"}. You can tap Try again on the card.`;
      }
      appendThreadMessages(threadId, assistantMessage(reply));
      await speak(reply);
      return true;
    },
    [
      appendThreadMessages,
      sendInvoice,
      sendSms,
      speak,
      updateCardResolution,
    ],
  );

  /**
   * Commit a finished turn into its thread and arm any confirm card.
   *
   * `next` is the message list the turn was asked with (already including the
   * user's message), so the assistant message lands at index `next.length` —
   * which is exactly what `PendingConfirm.msgIndex` records.
   */
  const commitTurn = React.useCallback(
    (
      threadId: string,
      next: AssistantMessage[],
      reply: string,
      parts: {
        events: AssistantEvent[];
        cards: AssistantCard[];
        artifacts: Artifact[];
        steps: ToolStep[];
        error?: string;
      },
    ) => {
      const message = assistantMessage(reply, {
        events: parts.events.length ? parts.events : undefined,
        cards: parts.cards.length ? parts.cards : undefined,
        artifacts: parts.artifacts.length ? parts.artifacts : undefined,
        steps: parts.steps.length ? parts.steps : undefined,
        error: parts.error,
      });
      setThreadMessages(threadId, [...next, message]);

      const confirmIndex = lastConfirmCardIndex(parts.cards);
      pendingConfirmRef.current =
        confirmIndex >= 0
          ? { threadId, msgIndex: next.length, cardIndex: confirmIndex }
          : null;

      // A proposal has no tool-emitted artifact — it IS the card — so the
      // canvas selection has to consider both or writing one would leave the
      // preview showing whatever was there before.
      const produced = turnArtifacts(parts.artifacts, parts.cards);
      const lastArtifact = produced[produced.length - 1];
      if (lastArtifact) setLatestArtifactId(lastArtifact.id);
    },
    [setThreadMessages],
  );

  /**
   * The one-shot route. This is the fallback when the stream never produced
   * anything — and, until `/api/assistant/stream` ships, the normal path.
   */
  const runChatFallback = React.useCallback(
    async (
      next: AssistantMessage[],
      threadId: string,
      signal: AbortSignal,
    ) => {
      try {
        const res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal,
          body: JSON.stringify({
            messages: next.map((m) => ({ role: m.role, content: m.content })),
            context: pageContext(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error || "Something went wrong.");
          setStatus("idle");
          return;
        }
        setTransport("fallback");
        const reply: string = data.reply || "";
        commitTurn(threadId, next, reply, {
          events: (data.events as AssistantEvent[]) || [],
          cards: (data.cards as AssistantCard[]) || [],
          artifacts: (data.artifacts as Artifact[]) || [],
          steps: [],
        });
        await speak(reply);
      } catch (e) {
        if (signal.aborted || (e as Error)?.name === "AbortError") return;
        setError("Could not reach the assistant.");
        setStatus("idle");
      }
    },
    [commitTurn, speak],
  );

  /**
   * Ask the model, preferring the streaming route so the workspace can show
   * each tool as it runs and the reply as it is written.
   *
   * The anti-duplication contract: we only fall back to `/api/assistant/chat`
   * when the stream produced ZERO text and no terminal frame. If text was
   * already on screen and the stream then died, the turn soft-completes with
   * whatever arrived — re-asking would show the answer twice and could run a
   * create/send tool a second time.
   */
  const runTurn = React.useCallback(
    async (next: AssistantMessage[], threadId: string, mode: "voice" | "text") => {
      // A fresh round-trip supersedes any earlier pending confirmation — if
      // this reply carries a new confirm card, it becomes the pending one.
      pendingConfirmRef.current = null;
      setStatus("thinking");
      setError(null);
      setSteps(EMPTY_STEPS);
      setStreamingText("");
      setLiveArtifacts([]);
      cancelDeltaFlush();

      const ctrl = new AbortController();
      turnAbortRef.current?.abort();
      turnAbortRef.current = ctrl;

      let assembled = "";
      let terminal: "done" | "error" | null = null;
      let sawDelta = false;
      // Tools that ran are work already done. A dead stream after tool
      // activity must NEVER auto-fall-back to the one-shot route — that
      // re-runs the whole turn, writes included (a duplicate invoice, a
      // second project). Track it separately from text.
      let sawToolStart = false;
      let streamError: string | null = null;
      const turnSteps: ToolStep[] = [];
      const events: AssistantEvent[] = [];
      const cards: AssistantCard[] = [];
      const artifacts: Artifact[] = [];

      try {
        const res = await fetch("/api/assistant/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: ctrl.signal,
          body: JSON.stringify({
            messages: next.map((m) => ({ role: m.role, content: m.content })),
            mode,
            context: pageContext(),
          }),
        });
        if (
          !res.ok ||
          !res.body ||
          !(res.headers.get("content-type") ?? "").includes("text/event-stream")
        ) {
          // 404 while the route is still being built, 503 from a cold worker,
          // or an HTML error page. Drop the body we are never going to read —
          // an un-consumed one holds the connection open — and fall back.
          await res.body?.cancel().catch(() => {});
          throw new Error("no-stream");
        }

        setStreaming(true);
        const parse = createSseParser();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parse(decoder.decode(value, { stream: true }))) {
            switch (frame.type) {
              case "status":
                break;
              case "tool_start": {
                sawToolStart = true;
                const step: ToolStep = {
                  id: frame.id,
                  name: frame.name,
                  label: frame.label,
                  state: "running",
                };
                turnSteps.push(step);
                setSteps([...turnSteps]);
                break;
              }
              case "tool_end": {
                const step = turnSteps.find((s) => s.id === frame.id);
                if (step) {
                  step.state = frame.ok ? "done" : "error";
                  step.event = frame.event;
                  step.error = frame.error;
                  setSteps([...turnSteps]);
                }
                if (frame.event) events.push(frame.event);
                break;
              }
              case "artifact": {
                const at = artifacts.findIndex(
                  (a) => a.id === frame.artifact.id,
                );
                if (at >= 0) artifacts[at] = frame.artifact;
                else artifacts.push(frame.artifact);
                setLiveArtifacts([...artifacts]);
                setLatestArtifactId(frame.artifact.id);
                break;
              }
              case "card": {
                cards.push(frame.card);
                // A proposal or invoice card is a document too — show it in
                // the canvas the moment it exists rather than making the user
                // wait for the model to stop talking about it.
                const promoted = cardToArtifact(frame.card);
                if (promoted) {
                  const at = artifacts.findIndex((a) => a.id === promoted.id);
                  if (at >= 0) artifacts[at] = promoted;
                  else artifacts.push(promoted);
                  setLiveArtifacts([...artifacts]);
                  setLatestArtifactId(promoted.id);
                }
                break;
              }
              case "delta":
                sawDelta = true;
                assembled += frame.text;
                pushDelta(frame.text);
                break;
              case "done":
                terminal = "done";
                assembled = frame.reply || assembled;
                break;
              case "error":
                terminal = "error";
                streamError = frame.error;
                setError(frame.error);
                break;
            }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") {
          setStreaming(false);
          return;
        }
        if (!sawDelta && !sawToolStart && !terminal) {
          // Nothing at all was rendered or executed: the stream route is
          // missing or refused. Safe to ask once, the ordinary way.
          setStreaming(false);
          setSteps(EMPTY_STEPS);
          await runChatFallback(next, threadId, ctrl.signal);
          return;
        }
        // The stream died mid-work. Soft-complete with whatever arrived —
        // and if tools had already run, say so, because retrying blind could
        // do the same work twice.
        terminal = terminal ?? "done";
        if (!sawDelta && sawToolStart && !streamError) {
          streamError =
            "The connection dropped mid-task. Check what was already done before asking again.";
          setError(streamError);
        }
      }

      setStreaming(false);
      cancelDeltaFlush();
      setStreamingText("");

      if (ctrl.signal.aborted) return;

      if (!terminal && !sawDelta) {
        if (sawToolStart) {
          // Body ended silently AFTER tools ran (the platform killed the
          // function). Falling back would re-run those tools — commit the
          // partial work with a warning instead.
          streamError =
            streamError ??
            "The connection dropped mid-task. Check what was already done before asking again.";
          setError(streamError);
        } else {
          // The body ended without a terminal frame, without text and without
          // any tool activity — nothing happened, so the one-shot route can
          // safely take the turn.
          setSteps(EMPTY_STEPS);
          await runChatFallback(next, threadId, ctrl.signal);
          return;
        }
      }

      const failed = terminal === "error" || Boolean(streamError);
      const hasAnything =
        assembled.trim().length > 0 ||
        cards.length > 0 ||
        artifacts.length > 0 ||
        turnSteps.length > 0;

      if (failed && !hasAnything) {
        // A failure before anything at all arrived: there is no partial work
        // to keep, so just surface the error banner.
        setSteps(EMPTY_STEPS);
        setLiveArtifacts([]);
        setStatus("idle");
        return;
      }

      setTransport("stream");
      setSteps(EMPTY_STEPS);
      setLiveArtifacts([]);
      // On failure the turn is committed WITH its partial work and the error
      // pinned to the message (rendered in rose) — streamed text, documents
      // and the tool trail are never vaporized by a late error frame.
      commitTurn(threadId, next, assembled, {
        events,
        cards,
        artifacts,
        steps: turnSteps,
        ...(failed
          ? { error: streamError ?? "The assistant ran into a problem." }
          : {}),
      });
      if (failed) {
        setStatus("idle");
        return;
      }
      await speak(assembled);
    },
    [cancelDeltaFlush, commitTurn, pushDelta, runChatFallback, speak],
  );

  const sendText = React.useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || busy) return;
      unlockAudio(); // we're in the tap/submit gesture — prime voice output
      setText("");
      silencedRef.current = false;
      lastInputVoiceRef.current = false;
      void (async () => {
        // A typed "yes" resolves a pending confirm card too.
        if (await resolvePendingConfirm(trimmed)) return;
        const threadId = activeThreadIdRef.current;
        const next = [...messagesRef.current, userMessage(trimmed)];
        setThreadMessages(threadId, next);
        await runTurn(next, threadId, "text");
      })();
    },
    [busy, resolvePendingConfirm, runTurn, setThreadMessages, unlockAudio],
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
          // Stay hands-free: if a confirmation is still waiting and we only
          // heard noise, listen again instead of going quiet.
          maybeAutoListen();
          return;
        }
        lastInputVoiceRef.current = true;
        // A spoken "yes / no" resolves the pending confirm card directly.
        if (await resolvePendingConfirm(said)) return;
        const threadId = activeThreadIdRef.current;
        const next = [...messagesRef.current, userMessage(said)];
        setThreadMessages(threadId, next);
        await runTurn(next, threadId, "voice");
      } catch {
        setError("Could not transcribe audio.");
        setStatus("idle");
      }
    },
    [
      maybeAutoListen,
      resolvePendingConfirm,
      runTurn,
      setThreadMessages,
    ],
  );

  const stopListening = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const openMicrophone = React.useCallback(async () => {
    // Consume the auto-arm flag: this one session answers a confirm card, so
    // it stops fast after a short reply instead of waiting out dictation.
    const confirmMode = autoListenRef.current;
    autoListenRef.current = false;
    // A wake-initiated turn is a conversation, not dictation — snappy
    // timings without hands-free having to be on. Hands-free implies the
    // same, since it IS a conversation by definition.
    const conversational = conversationalRef.current || handsFreeRef.current;
    conversationalRef.current = false;
    const silenceMs = confirmMode
      ? CONFIRM_SILENCE_MS
      : conversational
        ? CONVERSATION_SILENCE_MS
        : SILENCE_MS;

    setError(null);
    unlockAudio(); // we're in the tap gesture — prime voice output for mobile
    // Stop any in-progress playback first.
    playerRef.current?.pause();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "Voice needs a secure (https) connection. Open the app over https."
          : "Microphone isn't available in this browser.",
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked. Allow mic access for this site.");
      return;
    }
    // Belt-and-braces: never orphan a previous capture stream — an orphaned
    // stream is a microphone nothing can release until the tab closes.
    streamRef.current?.getTracks().forEach((t) => t.stop());
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
      if (spoke && blob.size > 0) {
        // The audible "got it" — the mic has closed and the words are on
        // their way, which is the moment the user most doubts being heard.
        playCaptureCue();
        void transcribeAndSend(blob, ext);
      } else {
        setStatus("idle");
      }
    };

    // Level metering + silence auto-stop. If this fails, recording still
    // works — you just stop it yourself with the button.
    hasSpokenRef.current = false;
    setHeard(false);
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
      const startedAt = Date.now();
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
          if (voicedFrames >= VOICE_FRAMES && !hasSpokenRef.current) {
            hasSpokenRef.current = true;
            // The visible "I hear you" — the one signal that tells the user
            // their words registered before any reply exists.
            setHeard(true);
          }
        } else {
          voicedFrames = 0;
        }

        // Only auto-stop AFTER you've actually started talking and then gone
        // quiet — never cut you off while you're still gathering your words.
        if (hasSpokenRef.current && now - lastLoudRef.current > silenceMs) {
          stopListening();
          return;
        }
        // A mic with nothing said at all closes quietly rather than sitting
        // open — an open recorder suspends the wake word and keeps the OS
        // mic light on, so "forever" is never an acceptable wait.
        const maxQuiet = confirmMode ? CONFIRM_MAX_WAIT_MS : LISTEN_MAX_QUIET_MS;
        if (!hasSpokenRef.current && now - startedAt > maxQuiet) {
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
  }, [playCaptureCue, stopListening, teardownCapture, transcribeAndSend, unlockAudio]);

  /**
   * One capture at a time (0104-fix). Overlapping opens — the wake flow and
   * the hands-free auto-arm firing within the same few hundred ms — used to
   * run getUserMedia twice; the second overwrote the refs and ORPHANED the
   * first stream, a held microphone nothing could ever release. That is why
   * the OS mic indicator would stay lit long after Arcus went quiet.
   */
  const startListening = React.useCallback(async () => {
    if (micOpeningRef.current || statusRef.current === "listening") return;
    micOpeningRef.current = true;
    try {
      await openMicrophone();
    } finally {
      micOpeningRef.current = false;
    }
  }, [openMicrophone]);

  /**
   * Open the microphone once Arcus has finished talking (0104-fix).
   *
   * The wake flow used to fire `toggleMic` on a timer, which raced the
   * hands-free auto-arm — whichever fired second flipped the mic straight
   * back OFF, so "hey Arcus" said "Yes, sir?" and then went deaf. This waits
   * out the playback chain (greeting, then ack, in order), leaves a short
   * beat so the mic never records the tail of Arcus's own voice, and only
   * ever OPENS — an already-listening mic is left alone.
   */
  const listenWhenQuiet = React.useCallback(async () => {
    const epoch = speechEpochRef.current;
    await playbackChainRef.current;
    if (epoch !== speechEpochRef.current) return; // closed while greeting
    // A reply spoken via speak() is not on the chain; wait for the player.
    const el = playerRef.current;
    if (el && !el.paused && !el.ended) {
      await new Promise<void>((resolve) => {
        const done = () => {
          el.removeEventListener("ended", done);
          el.removeEventListener("pause", done);
          resolve();
        };
        el.addEventListener("ended", done);
        el.addEventListener("pause", done);
      });
    }
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    if (epoch !== speechEpochRef.current) return; // closed while acking
    if (statusRef.current !== "idle") return;
    // This one capture is a conversation turn, so it closes 2.5s after the
    // user stops talking rather than sitting open for dictation — and it is
    // the ONLY one this wake buys.
    conversationalRef.current = true;
    oneShotRef.current = true;
    silencedRef.current = false;
    await startListening();
  }, [startListening]);

  // Let earlier callbacks (speak → maybeAutoListen) re-arm the mic without a
  // circular dependency on startListening.
  React.useEffect(() => {
    startListeningRef.current = () => {
      void startListening();
    };
  }, [startListening]);

  const toggleMic = React.useCallback(() => {
    if (status === "listening") {
      stopListening();
      return;
    }
    // Reaching for the button is a deliberate conversation, so hands-free
    // applies again from here — the wake word's one-shot rule ends.
    oneShotRef.current = false;
    silencedRef.current = false;
    if (!busy) void startListening();
  }, [status, busy, startListening, stopListening]);

  const cancel = React.useCallback(() => {
    turnAbortRef.current?.abort();
    turnAbortRef.current = null;
    // Cancelling means cancelling the VOICE too: without these, a clip queued
    // behind the one being paused simply took over, and a reply already being
    // synthesised still arrived and spoke.
    speechEpochRef.current += 1;
    playbackChainRef.current = Promise.resolve();
    cancelDeltaFlush();
    setStreaming(false);
    setStreamingText("");
    setSteps(EMPTY_STEPS);
    setLiveArtifacts([]);
    pendingConfirmRef.current = null;
    playerRef.current?.pause();
    setStatus("idle");
  }, [cancelDeltaFlush]);

  /**
   * Shut up, completely and immediately (0104-fix).
   *
   * `stop()` used to only pause the player, which left three ways for Arcus
   * to keep talking after the user had closed it:
   *   - a clip QUEUED behind the paused one simply started playing next;
   *   - a reply whose TTS was still being fetched arrived and played;
   *   - the mic re-armed itself on the way out and started another turn.
   *
   * So this bumps the speech epoch (every path checks it before making a
   * sound), empties the queue, kills the pending re-arm, and closes the
   * microphone. The turn in flight is deliberately NOT aborted — it finishes
   * silently and its answer is waiting in the transcript when you come back.
   */
  const silence = React.useCallback(() => {
    speechEpochRef.current += 1;
    playbackChainRef.current = Promise.resolve();
    window.clearTimeout(autoListenTimerRef.current ?? undefined);
    autoListenTimerRef.current = null;
    pendingConfirmRef.current = null;
    conversationalRef.current = false;
    oneShotRef.current = false;
    silencedRef.current = true;
    stopListening();
    // Pause, but leave the handlers attached: they are what SETTLES the
    // clip's promise (detaching them stranded every caller awaiting it
    // forever). The epoch bump above is what neuters their side effects.
    playerRef.current?.pause();
    stopSpeechMeter();
    // Only the audible states are a lie once silenced; a turn still thinking
    // is still thinking, and claiming otherwise would hide real work.
    setStatus((s) => (s === "listening" || s === "speaking" ? "idle" : s));
  }, [stopListening, stopSpeechMeter]);

  const stop = React.useCallback(() => {
    silence();
  }, [silence]);

  const reset = React.useCallback(() => {
    stop();
    cancel();
    setThreadMessages(activeThreadIdRef.current, []);
    setError(null);
    setText("");
  }, [cancel, setThreadMessages, stop]);

  // ---- threads ------------------------------------------------------------

  const newThread = React.useCallback((): string => {
    cancel();
    stopListening();
    const thread = makeThread();
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    setText("");
    setLatestArtifactId(null);
    return thread.id;
  }, [cancel, stopListening]);

  const selectThread = React.useCallback(
    (id: string) => {
      if (id === activeThreadIdRef.current) return;
      // A confirmation belongs to the conversation you were in.
      cancel();
      stopListening();
      setActiveThreadId(id);
      setLatestArtifactId(null);
    },
    [cancel, stopListening],
  );

  const renameThread = React.useCallback(
    (id: string, title: string) => {
      const clean = title.trim().slice(0, 80);
      if (!clean) return;
      markDirty(id);
      setThreads((prev) =>
        prev.map((t) => (t.id === id ? { ...t, title: clean } : t)),
      );
    },
    [markDirty],
  );

  const deleteThread = React.useCallback(
    (id: string) => {
      // Computed outside the updater: a `setState` nested inside another
      // updater runs twice under StrictMode and would create a stray thread.
      const remaining = threadsRef.current.filter((t) => t.id !== id);
      const wasActive = activeThreadIdRef.current === id;

      // Tombstone it server-side too, so the other devices learn it is gone
      // instead of pushing their cached copy back. A pending push for this
      // thread is dropped — it would recreate what we are deleting.
      dirtyThreadsRef.current.delete(id);
      if (!isFramed()) void deleteThreadRemote(id);

      if (remaining.length === 0) {
        const fresh = makeThread();
        setThreads([fresh]);
        setActiveThreadId(fresh.id);
      } else {
        setThreads(remaining);
        // Deleting the conversation you were in lands you on the next newest.
        if (wasActive) setActiveThreadId(sortThreads(remaining)[0].id);
      }

      if (wasActive) {
        cancel();
        setLatestArtifactId(null);
      }
    },
    [cancel],
  );

  const threadSummaries = React.useMemo(
    () => sortThreads(threads).map(summarise),
    [threads],
  );

  const searchThreads = React.useCallback(
    (query: string): ThreadSummary[] => {
      const q = query.trim();
      const source = sortThreads(threadsRef.current);
      if (!q) return source.map(summarise);
      return source.filter((t) => matchesQuery(t, q)).map(summarise);
    },
    [],
  );

  const artifacts = React.useMemo(() => {
    const committed = collectArtifacts(messages);
    if (liveArtifacts.length === 0) return committed;
    // Same upsert rule as `collectArtifacts`: a live revision replaces the
    // committed version in place rather than opening a second tab.
    const merged = [...committed];
    for (const artifact of liveArtifacts) {
      const at = merged.findIndex((a) => a.id === artifact.id);
      if (at >= 0) merged[at] = artifact;
      else merged.push(artifact);
    }
    return merged;
  }, [messages, liveArtifacts]);

  return {
    status,
    messages,
    level,
    heard,
    error,
    text,
    muted,
    busy,
    setText,
    setMuted,
    toggleMic,
    sendText,
    sendInvoice,
    sendSms,
    approveMission,
    handsFree,
    setHandsFree,
    speak,
    playClip,
    listenWhenQuiet,
    ingestArtifacts,
    ingestTurn,
    stopListening,
    stop,
    silence,
    reset,

    steps,
    streamingText,
    streaming,
    cancel,
    transport,

    artifacts,
    latestArtifactId,

    threads: threadSummaries,
    activeThreadId,
    newThread,
    selectThread,
    renameThread,
    deleteThread,
    searchThreads,
  };
}

export function EventChip({ event }: { event: AssistantEvent }) {
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

/** Re-exported so `ACTIVE_THREAD_KEY` has one import site in the UI layer. */
export { ACTIVE_THREAD_KEY };
