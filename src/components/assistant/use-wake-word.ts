"use client";

/**
 * "Hey Arcus" — waking the assistant without touching anything (0104).
 *
 * Built on the browser's own Web Speech API rather than a wake-word library,
 * for three reasons: it ships with Chrome and Safari so there is nothing to
 * install or download at runtime, it costs nothing per utterance (the audio
 * never reaches our API), and it keeps the no-new-dependencies rule the rest
 * of this codebase follows.
 *
 * THIS IS OFF BY DEFAULT, and the reason is honest rather than technical:
 * browser speech recognition may stream audio to the browser vendor's own
 * service, so an always-listening microphone is a real privacy decision that
 * belongs to the user, not to us. The settings copy says so plainly, the
 * indicator shows while it is on, and Cmd/Ctrl+K remains the way in for
 * anyone who would rather not.
 *
 * The first version of this hook failed SILENTLY, which produced the exact
 * bug report it was designed to avoid: "I say hey Arcus and nothing happens,
 * and nothing tells me why." Three of its deaths were unrecoverable — a
 * denied mic permission stopped it forever, an exception from `start()`
 * scheduled no retry, and the failure budget reset itself before it could
 * ever trip. This version is a small state machine instead:
 *
 *   • every terminal condition is REPORTED (`state`), so the rail and the
 *     settings panel can say "mic blocked" instead of showing a dead badge;
 *   • a refused permission is retryable (`retry()`) once the user grants the
 *     microphone — no reload required;
 *   • persistent engine failures (Chrome's speech service being unreachable
 *     is the classic) back off to a slow retry loop instead of either dying
 *     or hammering: quick restarts while healthy, 20s cycles while broken.
 *
 * Three behavioural rules are unchanged: it never listens while Arcus talks
 * (it would hear its own name), it only runs on a visible top-level tab, and
 * it restarts itself after Chrome's routine silence timeouts.
 */

import * as React from "react";

/**
 * Tolerant on purpose. "Arcus" is not in any recogniser's dictionary, so it
 * comes back as "arc us", "argus", "marcus" — matching only the exact
 * spelling would make the feature look broken. The leading greeting is
 * optional so a bare "Arcus?" works too.
 */
const WAKE_RE =
  /\b(?:hey|hi|hello|ok|okay)?[,\s]*(arcus|arc us|arkus|argus|arcas|marcus)\b/i;

/** Ignore a second match this soon — one utterance, one wake. */
const DEBOUNCE_MS = 3_000;

/** Restart delay after a HEALTHY session ends (Chrome's silence timeout). */
const RESTART_MS = 400;

/** A session that survives this long counts as healthy. */
const HEALTHY_MS = 3_000;

/** Consecutive short-lived sessions before backing off. */
const MAX_QUICK_FAILURES = 4;

/** The slow lane: retry cadence while the engine keeps failing. */
const BACKOFF_MS = 20_000;

export type WakeWordState =
  /** The recogniser is running and the phrase will be heard. */
  | "listening"
  /** Disabled by configuration (toggle off / not the terminal / mobile). */
  | "off"
  /** This browser has no speech recognition at all. */
  | "unsupported"
  /** The microphone permission was refused — `retry()` after granting. */
  | "denied"
  /** The engine keeps dying young; retrying on the slow cadence. */
  | "failing"
  /** Suspended while Arcus itself is busy or the tab is hidden. */
  | "suspended";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser can do wake-word listening at all. */
export function wakeWordSupported(): boolean {
  return getRecognitionCtor() !== null;
}

/**
 * Listen for the wake phrase and call `onWake` when it is heard.
 *
 * @param enabled Whether to listen at all — the user's own setting (or the
 *   terminal flag).
 * @param busy True while Arcus is recording, thinking or speaking; listening
 *   is suspended for the duration so it cannot hear itself.
 * @param onWake Fired once per utterance, debounced.
 */
export function useWakeWord(
  enabled: boolean,
  busy: boolean,
  onWake: () => void,
): {
  /** Running right now — the rail's ARMED light. */
  listening: boolean;
  supported: boolean;
  /** WHY it is or isn't running — so a dead badge can explain itself. */
  state: WakeWordState;
  /** Clear a `denied`/`failing` verdict and try again (e.g. after the user
   *  grants the microphone). Safe to call in any state. */
  retry: () => void;
} {
  const [state, setState] = React.useState<WakeWordState>("off");
  // Bumping this remounts the whole effect — the one clean way to revive a
  // recogniser whose permission verdict changed underneath it.
  const [attempt, setAttempt] = React.useState(0);

  // The recogniser's callbacks outlive the render that created them, so the
  // latest `onWake` is kept in a ref — written in an effect, never during
  // render, so a concurrent re-render cannot see a half-updated value.
  const onWakeRef = React.useRef(onWake);
  React.useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  const supported = React.useMemo(() => wakeWordSupported(), []);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);

  React.useEffect(() => {
    if (!supported) {
      setState("unsupported");
      return;
    }
    if (!enabled) {
      setState("off");
      return;
    }
    if (busy) {
      setState("suspended");
      return;
    }
    // Never in the preview canvas's iframe — a second microphone behind the
    // first is exactly the behaviour that makes people distrust the feature.
    try {
      if (window.self !== window.top) return;
    } catch {
      return;
    }

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setState("unsupported");
      return;
    }

    let recognition: SpeechRecognitionLike | null = null;
    let disposed = false;
    let denied = false;
    let quickFailures = 0;
    let startedAt = 0;
    let lastWake = 0;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      if (disposed || denied) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(start, delay);
    };

    const start = () => {
      if (disposed || denied || document.hidden) return;
      try {
        recognition = new Ctor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (event) => {
          // A result at all means the engine is genuinely working.
          quickFailures = 0;
          // Only the newest result matters; older ones were already scanned
          // and re-matching them would re-fire on every interim update.
          const results = event.results;
          const latest = results[results.length - 1];
          const transcript = latest?.[0]?.transcript ?? "";
          if (!WAKE_RE.test(transcript)) return;
          const now = Date.now();
          if (now - lastWake < DEBOUNCE_MS) return;
          lastWake = now;
          // Stop before waking: the assistant is about to open its own
          // microphone, and two recognisers on one device fight.
          try {
            recognition?.stop();
          } catch {
            // Already stopping.
          }
          onWakeRef.current();
        };

        recognition.onerror = (event) => {
          // A permission refusal is terminal for THIS effect run — but it is
          // reported, and `retry()` can lift it once the user grants the mic.
          if (
            event?.error === "not-allowed" ||
            event?.error === "service-not-allowed"
          ) {
            denied = true;
            setState("denied");
          }
          // Everything else ("no-speech", "network", "aborted") falls through
          // to onend, where the health accounting decides the retry cadence.
        };

        recognition.onend = () => {
          if (disposed || denied) return;
          // Died young = the engine is broken (offline speech service, mic
          // wrestling); lived a while = Chrome's normal silence timeout.
          const lived = Date.now() - startedAt;
          if (lived < HEALTHY_MS) quickFailures += 1;
          else quickFailures = 0;

          if (quickFailures >= MAX_QUICK_FAILURES) {
            // The slow lane — keep trying forever, visibly, without hammering.
            setState("failing");
            schedule(BACKOFF_MS);
          } else {
            setState("suspended");
            schedule(RESTART_MS);
          }
        };

        startedAt = Date.now();
        recognition.start();
        setState("listening");
      } catch {
        // `start()` can throw synchronously (invalid state, engine quirks).
        // The old code died here forever; now it is just another failure.
        quickFailures += 1;
        setState(quickFailures >= MAX_QUICK_FAILURES ? "failing" : "suspended");
        schedule(quickFailures >= MAX_QUICK_FAILURES ? BACKOFF_MS : RESTART_MS);
      }
    };

    // Only while the tab is visible: a background tab holding the microphone
    // open is exactly the behaviour that makes people distrust a feature.
    const onVisibility = () => {
      if (document.hidden) {
        setState("suspended");
        try {
          recognition?.abort();
        } catch {
          // Nothing to abort.
        }
      } else if (!disposed && !denied) {
        start();
      }
    };

    if (document.hidden) setState("suspended");
    else start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) window.clearTimeout(timer);
      try {
        recognition?.abort();
      } catch {
        // Already gone.
      }
    };
  }, [enabled, supported, busy, attempt]);

  return { listening: state === "listening", supported, state, retry };
}

/**
 * Ask the browser for the microphone, then report whether it is usable.
 *
 * This exists for the "MIC BLOCKED — fix" affordances: SpeechRecognition
 * cannot re-prompt after a refusal, but `getUserMedia` can (and on a
 * hard block it fails fast, which the caller turns into instructions to
 * flip the site permission by hand). The track is stopped immediately —
 * this is a permission request, not a recording.
 */
export async function requestMicrophone(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    return {
      ok: false,
      error:
        name === "NotAllowedError"
          ? "The microphone is blocked for this site. Click the mic icon in the address bar, allow it, then try again."
          : "Could not reach a microphone.",
    };
  }
}
