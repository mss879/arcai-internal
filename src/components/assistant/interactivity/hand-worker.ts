/**
 * The hand-tracking worker — the camera never touches the main thread.
 *
 * The MediaStreamTrack itself is TRANSFERRED here (Chromium can do that),
 * a MediaStreamTrackProcessor reads its VideoFrames inside this worker, and
 * MediaPipe's HandLandmarker (GPU delegate where the worker has WebGL2)
 * turns each frame into 21 landmarks. All the page ever receives is ~1KB of
 * numbers per frame — the pixels are born and die in this thread, which is
 * both the performance story and the privacy story: the feed is never
 * rendered anywhere.
 *
 * Where the track cannot be transferred (no MediaStreamTrackProcessor), the
 * page falls back to posting ImageBitmaps captured off a hidden <video>;
 * inference still happens HERE either way — there is exactly one detection
 * path to keep correct.
 *
 * All model/wasm assets load from /arcus/hand/ on our own origin. No CDN:
 * production must not depend on a third-party host being up.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

type WorkerHand = { landmarks: NormalizedLandmark[]; handedness?: string };

type InitMsg = { type: "init"; assetBase: string };
type TrackMsg = { type: "track"; track: MediaStreamTrack };
type FrameMsg = { type: "frame"; bitmap: ImageBitmap; t: number };
type StopMsg = { type: "stop" };
type InMsg = InitMsg | TrackMsg | FrameMsg | StopMsg;

export type WorkerResult =
  | { type: "ready"; gpu: boolean }
  | { type: "init-error"; message: string }
  | { type: "result"; hands: WorkerHand[] | null; t: number };

/** Chrome's mediacapture-transform API — not yet in the TS dom lib. */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readable: ReadableStream<VideoFrame>;
}

const scope = self as unknown as {
  postMessage(message: WorkerResult): void;
  onmessage: ((event: MessageEvent<InMsg>) => void) | null;
};

let landmarker: HandLandmarker | null = null;
let stopped = false;
/** Monotonic timestamp guard — detectForVideo requires strictly increasing. */
let lastTs = 0;

/** Idle discipline: after this long with no hand, scan every 3rd frame. */
const IDLE_AFTER_MS = 10_000;
let lastHandAt = 0;
let frameSkip = 0;

async function init(assetBase: string): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(assetBase);
  const options = {
    baseOptions: {
      modelAssetPath: `${assetBase}/hand_landmarker.task`,
      delegate: "GPU" as const,
    },
    runningMode: "VIDEO" as const,
    // Two, for the resize gesture — the second hand costs almost nothing
    // when absent and one extra inference pass when present.
    numHands: 2,
  };
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options);
    scope.postMessage({ type: "ready", gpu: true });
  } catch {
    // No WebGL2 in this worker — the CPU path is slower but real.
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
    });
    scope.postMessage({ type: "ready", gpu: false });
  }
}

function detect(source: ImageBitmap | VideoFrame, t: number): void {
  if (!landmarker || stopped) return;

  // Idle scan: nobody has shown a hand for a while — skip 2 of 3 frames so
  // an armed-but-unused mode costs a third of the GPU it would otherwise.
  if (t - lastHandAt > IDLE_AFTER_MS && lastHandAt !== 0) {
    frameSkip = (frameSkip + 1) % 3;
    if (frameSkip !== 0) return;
  }

  const ts = t > lastTs ? t : lastTs + 1;
  lastTs = ts;
  const result = landmarker.detectForVideo(source, ts);
  const hands: WorkerHand[] = (result.landmarks ?? []).map((landmarks, i) => ({
    landmarks,
    handedness: result.handedness?.[i]?.[0]?.categoryName,
  }));
  if (hands.length > 0) lastHandAt = t;
  scope.postMessage({ type: "result", hands: hands.length ? hands : null, t });
}

async function pump(track: MediaStreamTrack): Promise<void> {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  lastHandAt = performance.now(); // full rate until the first idle window
  for (;;) {
    const { done, value } = await reader.read();
    if (done || stopped) {
      value?.close();
      break;
    }
    try {
      detect(value, performance.now());
    } finally {
      value.close(); // an unclosed VideoFrame stalls the camera pipeline
    }
  }
  reader.releaseLock();
}

scope.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      init(msg.assetBase).catch((error: unknown) => {
        scope.postMessage({
          type: "init-error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      break;
    case "track":
      pump(msg.track).catch(() => {
        /* the track ended — the page owns restarting */
      });
      break;
    case "frame":
      try {
        detect(msg.bitmap, msg.t);
      } finally {
        msg.bitmap.close();
      }
      break;
    case "stop":
      stopped = true;
      landmarker?.close();
      landmarker = null;
      break;
  }
};
