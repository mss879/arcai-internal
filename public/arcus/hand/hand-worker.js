/**
 * The hand-tracking worker — the camera never touches the main thread.
 *
 * ── WHY THIS FILE LIVES IN /public AND IS PLAIN JAVASCRIPT ──────────────
 * It began as `src/.../hand-worker.ts`, constructed with the usual
 * `new Worker(new URL("./hand-worker.ts", import.meta.url))`. That works in
 * dev, where Turbopack compiles the worker on the fly — and silently breaks
 * in a production build, which treats the URL as an ASSET reference and
 * copies the raw TypeScript into `/_next/static/media/hand-worker.<hash>.ts`.
 * The browser then fetches a file full of type annotations and a bare
 * `@mediapipe/...` specifier, fails to parse it, and `new Worker()` throws
 * before the page ever reaches `getUserMedia` — which is why the deployed
 * site never even asked for the camera.
 *
 * So: no bundler is involved here at all. This is a plain, already-valid
 * worker script served from our own origin, pulling in a vendored MediaPipe
 * bundle sitting next to it. What runs in production is byte-for-byte what
 * is in the repo — the one arrangement that cannot be silently broken by a
 * build tool.
 *
 * `vision_bundle-<version>.js` and the wasm beside it are copied from the
 * `@mediapipe/tasks-vision` package (kept in package.json as their
 * provenance); refresh them from `node_modules/@mediapipe/tasks-vision/`
 * when that dependency is upgraded.
 * ───────────────────────────────────────────────────────────────────────
 *
 * The MediaStreamTrack itself is TRANSFERRED here (Chromium can do that), a
 * MediaStreamTrackProcessor reads its VideoFrames inside this worker, and
 * MediaPipe's HandLandmarker (GPU where the worker has WebGL2) turns each
 * frame into 21 landmarks. All the page ever receives is ~1KB of numbers per
 * frame — the pixels are born and die in this thread, which is both the
 * performance story and the privacy story: the feed is never rendered.
 *
 * Where the track cannot be transferred (no MediaStreamTrackProcessor), the
 * page posts ImageBitmaps captured off a detached <video>; inference still
 * happens HERE either way — there is exactly one detection path to keep
 * correct.
 */

// A CLASSIC worker importing the IIFE build, not a module worker importing
// the ESM one — and that is not a style choice. MediaPipe's FilesetResolver
// loads the wasm glue with `importScripts`, which does not exist inside a
// `type: "module"` worker; there it fails with the wonderfully opaque
// "ModuleFactory not set." Classic scope keeps `importScripts` available for
// both this line and MediaPipe's own internals.
//
// `vision_bundle.js` is the package's IIFE build and exposes one global.
// Versioned filename on purpose: this directory is meant to be cached hard
// and forever, so the only safe way to ship a MediaPipe upgrade is a new
// name. Bump it here and in the file you copy from node_modules.
importScripts("./vision_bundle-1.0.1.js");
const { FilesetResolver, HandLandmarker } = self.Vision;

/** @type {import("@mediapipe/tasks-vision").HandLandmarker | null} */
let landmarker = null;
let stopped = false;
/** Monotonic timestamp guard — detectForVideo requires strictly increasing. */
let lastTs = 0;

/** Idle discipline: after this long with no hand, scan every 3rd frame. */
const IDLE_AFTER_MS = 10_000;
let lastHandAt = 0;
let frameSkip = 0;

async function init(assetBase) {
  const fileset = await FilesetResolver.forVisionTasks(assetBase);
  const options = {
    baseOptions: {
      modelAssetPath: `${assetBase}/hand_landmarker.task`,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    // Two, for the resize gesture — the second hand costs almost nothing
    // when absent and one extra inference pass when present.
    numHands: 2,
  };
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options);
    self.postMessage({ type: "ready", gpu: true });
  } catch {
    // No WebGL2 in this worker — the CPU path is slower but real.
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
    self.postMessage({ type: "ready", gpu: false });
  }
}

function detect(source, t) {
  if (!landmarker || stopped) return;

  // Idle scan: nobody has shown a hand for a while — skip 2 of 3 frames so
  // an armed-but-unused mode costs a third of the GPU it would otherwise.
  if (lastHandAt !== 0 && t - lastHandAt > IDLE_AFTER_MS) {
    frameSkip = (frameSkip + 1) % 3;
    if (frameSkip !== 0) return;
  }

  const ts = t > lastTs ? t : lastTs + 1;
  lastTs = ts;
  const result = landmarker.detectForVideo(source, ts);
  const hands = (result.landmarks ?? []).map((landmarks, i) => ({
    landmarks,
    handedness: result.handedness?.[i]?.[0]?.categoryName,
  }));
  if (hands.length > 0) lastHandAt = t;
  self.postMessage({ type: "result", hands: hands.length ? hands : null, t });
}

async function pump(track) {
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

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      init(msg.assetBase).catch((error) => {
        self.postMessage({
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
