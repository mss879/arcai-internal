"use client";

/**
 * Camera + worker lifecycle for interactivity mode.
 *
 * Modelled on `use-wake-word.ts`, whose first version taught the lesson this
 * hook is built around: silent failure produces the exact support call the
 * feature exists to prevent. Every terminal condition here is a NAMED state
 * the rail can show — a blocked camera says so and is clickable, a browser
 * that cannot run the pipeline says so, and "no hand in view" is a state,
 * not an error.
 *
 * The other design rule: per-frame data NEVER touches React. Subscribers
 * (the interaction layer) receive landmarks through a plain callback set;
 * `state` changes only on coarse transitions — a hand appearing, the camera
 * dying — so an armed mode costs zero renders per frame.
 *
 * Privacy is structural, not a promise: the camera is opened at 320×240 and
 * the track is handed straight to the worker, which closes every frame after
 * reading 21 numbers off it. There is no <video> on screen, no canvas with
 * the feed, nothing to leak. The one place pixels touch the page is the
 * FALLBACK pump (browsers without MediaStreamTrackProcessor), where a
 * detached, muted <video> exists only as a frame source for ImageBitmaps —
 * still never rendered. A hidden tab stops the camera entirely: the hardware
 * light goes off, and comes back when the tab does.
 */

import * as React from "react";

import type { HandInput } from "@/components/assistant/interactivity/gesture-engine";
import { simEnabled, startSim } from "@/components/assistant/interactivity/hand-sim";

export type HandTrackingState =
  | "off"
  | "starting"
  | "tracking"
  | "no-hand"
  | "denied"
  | "unsupported"
  | "error";

export type HandFrameListener = (hands: HandInput[] | null, t: number) => void;

/**
 * What the interaction layer consumes. The REAL implementation is this hook;
 * the preview harness supplies a mouse-driven fake with the same shape, so
 * the entire gesture pipeline can be exercised without a camera.
 */
export type HandSource = {
  state: HandTrackingState;
  subscribe: (listener: HandFrameListener) => () => void;
  /** Retry after a denied permission — the "CAMERA BLOCKED · FIX" click. */
  fix: () => void;
};

/**
 * WebKit — desktop Safari and every iOS browser. Gated out for the same
 * reason the wake word gates it: the pipeline needs worker WebGL and APIs
 * WebKit doesn't ship, and a mode that half-works reads as broken.
 */
function isWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua);
}

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    !isWebKit()
  );
}

export function useHandTracking(enabled: boolean): HandSource {
  const [state, setState] = React.useState<HandTrackingState>("off");

  const listenersRef = React.useRef<Set<HandFrameListener>>(new Set());
  const workerRef = React.useRef<Worker | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const pumpStopRef = React.useRef<(() => void) | null>(null);
  /** The coarse state, mirrored so 30Hz results only setState on a CHANGE. */
  const coarseRef = React.useRef<HandTrackingState>("off");
  const enabledRef = React.useRef(enabled);

  const report = React.useCallback((next: HandTrackingState) => {
    if (coarseRef.current === next) return;
    coarseRef.current = next;
    setState(next);
  }, []);

  const stopCamera = React.useCallback(() => {
    pumpStopRef.current?.();
    pumpStopRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const acquire = React.useCallback(async () => {
    const worker = workerRef.current;
    if (!worker) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // 640×480 — steadier landmarks when the user sits further back,
          // still trivial for the worker's GPU pass.
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user",
        },
      });
      // The effect may have torn down while the permission prompt was up.
      if (!enabledRef.current || workerRef.current !== worker) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];

      // Preferred path: transfer the track; pixels never touch this thread.
      let transferred = false;
      if (typeof MediaStreamTrackProcessor !== "undefined") {
        try {
          worker.postMessage({ type: "track", track }, [
            track as unknown as Transferable,
          ]);
          transferred = true;
        } catch {
          transferred = false; // DataCloneError → fall through to the pump
        }
      }

      if (!transferred) {
        // Fallback pump: a DETACHED video as a frame source, ~30Hz bitmaps
        // transferred to the worker. Inference still lives in the worker.
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        let stopped = false;
        let raf = 0;
        const grab = async () => {
          if (stopped) return;
          try {
            const bitmap = await createImageBitmap(video);
            workerRef.current?.postMessage(
              { type: "frame", bitmap, t: performance.now() },
              [bitmap],
            );
          } catch {
            /* a mid-teardown frame — nothing to do */
          }
          if (stopped) return;
          if ("requestVideoFrameCallback" in video) {
            video.requestVideoFrameCallback(() => void grab());
          } else {
            raf = requestAnimationFrame(() => void grab());
          }
        };
        void grab();
        pumpStopRef.current = () => {
          stopped = true;
          cancelAnimationFrame(raf);
          video.srcObject = null;
        };
      }
      report("no-hand"); // armed; "tracking" arrives with the first hand
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      report(
        name === "NotAllowedError" || name === "SecurityError"
          ? "denied"
          : "error",
      );
    }
  }, [report]);

  React.useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      report("off");
      return;
    }
    // The harness's mouse-driven hand — same listeners, no camera at all.
    if (simEnabled()) {
      report("tracking");
      return startSim((hands, t) => {
        for (const listener of listenersRef.current) listener(hands, t);
      });
    }
    if (!supported()) {
      report("unsupported");
      return;
    }
    report("starting");

    const worker = new Worker(
      new URL("./hand-worker.ts", import.meta.url),
    );
    workerRef.current = worker;
    worker.onmessage = (
      event: MessageEvent<
        | { type: "ready"; gpu: boolean }
        | { type: "init-error"; message: string }
        | { type: "result"; hands: HandInput[] | null; t: number }
      >,
    ) => {
      const msg = event.data;
      if (msg.type === "init-error") {
        report("error");
        return;
      }
      if (msg.type === "result") {
        report(msg.hands ? "tracking" : "no-hand");
        for (const listener of listenersRef.current) {
          listener(msg.hands, msg.t);
        }
      }
    };
    worker.postMessage({
      type: "init",
      assetBase: `${window.location.origin}/arcus/hand`,
    });
    void acquire();

    // A hidden tab surrenders the camera — the hardware light must go off.
    const onVisibility = () => {
      if (document.hidden) {
        stopCamera();
      } else if (
        enabledRef.current &&
        !streamRef.current &&
        coarseRef.current !== "denied"
      ) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopCamera();
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [enabled, acquire, report, stopCamera]);

  const fix = React.useCallback(() => {
    if (coarseRef.current !== "denied" && coarseRef.current !== "error") return;
    report("starting");
    void acquire();
  }, [acquire, report]);

  const subscribe = React.useCallback((listener: HandFrameListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return React.useMemo(
    () => ({ state, subscribe, fix }),
    [state, subscribe, fix],
  );
}

/** Chrome's mediacapture-transform API — not yet in the TS dom lib. */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readable: ReadableStream;
}
