/**
 * The gesture engine — pure math, no DOM, no React.
 *
 * Everything in interactivity mode that could be WRONG (a jittery cursor, a
 * pinch that flickers open mid-drag, a fist that fires a phantom click)
 * lives in this file, precisely so it can be exercised without a camera:
 * the preview harness feeds it synthetic landmarks from the mouse and the
 * whole pipeline downstream is the same code the real hand drives.
 *
 * Five responsibilities:
 *
 *  1. MAPPING — a central "reach box" of the mirrored camera frame maps to
 *     the full viewport, so a small hand motion covers the whole screen.
 *
 *  2. PRECISION — mouse-style acceleration in reverse: slow hand motion
 *     moves the cursor slower than the hand (surgical control right before
 *     a click), fast motion still crosses the screen in one sweep. A gentle
 *     drift-correction keeps the gained cursor anchored to the hand's true
 *     position so it never wanders off.
 *
 *  3. SMOOTHING — a One-Euro filter per axis: heavy at rest, light in
 *     motion. Presets come from the user's Hands settings.
 *
 *  4. THE PINCH — thumb↔index over hand span, hysteresis + debounce, and
 *     AUTO-CALIBRATION: the engine watches each user's own open/closed
 *     ratios and moves the thresholds to fit their hand. TRAVEL alone
 *     decides what a release means: no travel = click, travel = drag+drop.
 *
 *  5. POSES — fist / thumbs-up / palm / scroll (see hand-poses.ts), each
 *     behind a dwell timer so a pose is a decision, not a twitch; plus the
 *     horizontal FLICK and the two-hand pinch for resizing.
 */

import { classifyPose, type Pose } from "@/components/assistant/interactivity/hand-poses";

/** One MediaPipe hand landmark, normalised to the camera frame (0..1). */
export type Landmark = { x: number; y: number; z: number };

/** One detected hand as the worker (or the sim) reports it. */
export type HandInput = { landmarks: Landmark[]; handedness?: string };

/** Landmark indices this engine reads (of MediaPipe's 21). */
export const LM = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleMcp: 9,
} as const;

// ---------------------------------------------------------------------------
// One-Euro filter
// ---------------------------------------------------------------------------

/** One-Euro filter for a single axis. Casiez et al., CHI 2012. */
class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.012,
    private dCutoff = 1.0,
  ) {}

  tune(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1 / 240);
    this.tPrev = tMs;

    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuro.alpha(cutoff, dt);
    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

// ---------------------------------------------------------------------------
// Tuning — every magic number, named and in one place.
// ---------------------------------------------------------------------------

export const TUNING = {
  /** The central fraction of the camera frame that maps to the viewport. */
  reachBox: 0.6,
  /** Pinch closes below this (thumb↔index over hand span)… */
  pinchClose: 0.32,
  /** …and only reopens above this. The gap is the hysteresis. */
  pinchOpen: 0.45,
  /** Consecutive frames a raw pinch reading must hold to change state. */
  pinchDebounceFrames: 2,
  /** A pinch that travelled less than this is a click on release. */
  clickMaxTravelPx: 12,
  /** Precision gain: floor, px/s at which gain reaches 1, and ceiling. */
  gainFloor: 0.34,
  gainFullSpeed: 850,
  gainCeil: 1.15,
  /** Drift correction toward the hand's absolute position, per frame. */
  driftCorrect: 0.015,
  /** Pose dwell times (ms) before the action fires. */
  fistHoldMs: 550,
  palmHoldMs: 850,
  thumbsHoldMs: 550,
  /** Cursor must be this still (px/s) for a dwell to run. */
  dwellMaxSpeed: 260,
  /** Cooldown after any pose action (ms). */
  poseCooldownMs: 2000,
  /** Flick: horizontal speed floor (px/s) and dominance over vertical. */
  flickSpeed: 1400,
  flickDominance: 2.5,
  flickCooldownMs: 1200,
} as const;

/** What the Hands settings control. */
export type EngineConfig = {
  reach: number;
  minCutoff: number;
  beta: number;
  precision: boolean;
  autoCalibrate: boolean;
};

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  reach: TUNING.reachBox,
  minCutoff: 1.2,
  beta: 0.012,
  precision: true,
  autoCalibrate: true,
};

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Camera-normalised landmark → viewport pixels: mirrored (a front camera
 * shows the room backwards), then the reach box stretched to the viewport.
 */
export function mapToViewport(
  lm: Landmark,
  viewportW: number,
  viewportH: number,
  reach: number = TUNING.reachBox,
): { x: number; y: number } {
  const lo = (1 - reach) / 2;
  const nx = clamp01(((1 - lm.x) - lo) / reach);
  const ny = clamp01((lm.y - lo) / reach);
  return { x: nx * viewportW, y: ny * viewportH };
}

/** Thumb-tip↔index-tip distance over the hand's own span (scale-free). */
export function pinchRatio(landmarks: Landmark[]): number {
  const t = landmarks[LM.thumbTip];
  const i = landmarks[LM.indexTip];
  const w = landmarks[LM.wrist];
  const m = landmarks[LM.middleMcp];
  const span = Math.hypot(w.x - m.x, w.y - m.y) || 1e-6;
  return Math.hypot(t.x - i.x, t.y - i.y) / span;
}

// ---------------------------------------------------------------------------
// Small state machines
// ---------------------------------------------------------------------------

/** Debounced, hysteresis pinch — used for both hands. */
class PinchFsm {
  pinched = false;
  private streak = 0;

  /** Feed a ratio (or null to force-open); returns edges. */
  step(
    ratio: number | null,
    close: number,
    open: number,
  ): { start: boolean; end: boolean } {
    const raw = ratio === null ? false : this.pinched ? ratio < open : ratio < close;
    if (raw !== this.pinched) this.streak++;
    else this.streak = 0;
    if (this.streak >= TUNING.pinchDebounceFrames) {
      this.streak = 0;
      this.pinched = raw;
      return { start: raw, end: !raw };
    }
    return { start: false, end: false };
  }

  reset(): boolean {
    const was = this.pinched;
    this.pinched = false;
    this.streak = 0;
    return was;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** What the conductor acts on, produced once per camera frame. */
export type GestureFrame = {
  /** Smoothed cursor position, viewport px, and its velocity (px/s). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** True while the pinch is held. */
  pinching: boolean;
  /** Edge: the pinch closed THIS frame. */
  pinchStart: boolean;
  /** Edge: released this frame having travelled — the end of a drag. */
  drop: boolean;
  /** Edge: released this frame in place — a tap, however long it was held. */
  click: boolean;
  /** True once the held pinch has travelled far enough to be a drag. */
  dragging: boolean;
  /** Current pose (dwell-independent, for the reticle's label). */
  pose: Pose;
  /** Pose dwell edges — each fires exactly once per hold. */
  crush: boolean;
  palmAction: boolean;
  thumbsAction: boolean;
  /** How far into the active dwell we are, 0..1, for the reticle's ring. */
  dwell: number;
  /** Vertical cursor delta while the scroll pose is held (px, signed). */
  scrollDy: number;
  /** Horizontal flick edge: -1 left, 1 right, 0 none. */
  flick: -1 | 0 | 1;
  /** Two-hand pinch (resize): active, its start edge, and scale vs start. */
  twoPinch: boolean;
  twoPinchStart: boolean;
  twoPinchScale: number;
  /** Raw landmarks of the primary hand, for the skeleton glyph. */
  landmarks: Landmark[];
};

export class GestureEngine {
  private config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };

  private fx = new OneEuro();
  private fy = new OneEuro();

  private pinch = new PinchFsm();
  private pinch2 = new PinchFsm();

  // Precision-gained cursor state.
  private cx: number | null = null;
  private cy: number | null = null;
  private mPrev: { x: number; y: number } | null = null;

  // Velocity of the filtered cursor.
  private xPrev: number | null = null;
  private yPrev: number | null = null;
  private tPrev: number | null = null;

  private pinchStartX = 0;
  private pinchStartY = 0;
  private travelled = false;

  // Auto-calibration of the pinch thresholds.
  private rMin = 1;
  private rMax = 0;
  private calSamples = 0;

  // Pose dwell state.
  private poseHeld: Pose = "none";
  private poseSince = 0;
  private poseFired = false;
  private poseCooldownUntil = 0;

  private flickCooldownUntil = 0;
  private scrollPrevY: number | null = null;

  // Two-hand resize.
  private twoStartDist = 0;

  setConfig(config: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...config };
    this.fx.tune(this.config.minCutoff, this.config.beta);
    this.fy.tune(this.config.minCutoff, this.config.beta);
  }

  /** The live thresholds — defaults until the user's own pinch teaches us. */
  private thresholds(): { close: number; open: number } {
    if (
      !this.config.autoCalibrate ||
      this.calSamples < 60 ||
      this.rMin > 0.25 || // never seen a full pinch: nothing learned yet
      this.rMax - this.rMin < 0.3
    ) {
      return { close: TUNING.pinchClose, open: TUNING.pinchOpen };
    }
    const range = this.rMax - this.rMin;
    const close = clamp(this.rMin + 0.28 * range, 0.2, 0.45);
    const open = clamp(this.rMin + 0.5 * range, close + 0.1, 0.7);
    return { close, open };
  }

  process(
    hands: HandInput[],
    tMs: number,
    viewportW: number,
    viewportH: number,
  ): GestureFrame {
    const landmarks = hands[0].landmarks;
    const cfg = this.config;

    // --- pose first: it gates the pinch ---
    const pose = classifyPose(landmarks);

    // --- mapping + precision gain ---
    const m = mapToViewport(landmarks[LM.indexMcp], viewportW, viewportH, cfg.reach);
    const dtRaw = this.tPrev === null ? 1 / 30 : Math.max((tMs - this.tPrev) / 1000, 1 / 240);
    if (this.cx === null || this.cy === null || this.mPrev === null) {
      this.cx = m.x;
      this.cy = m.y;
    } else if (cfg.precision) {
      const dxm = m.x - this.mPrev.x;
      const dym = m.y - this.mPrev.y;
      const jump = Math.hypot(dxm, dym);
      if (jump > 220) {
        // A teleport — the hand re-entering the frame, or the sim's mouse
        // warping. Gained deltas would land the cursor off-target; snap —
        // and reset the velocity baseline, because a snap is not motion:
        // the spike would otherwise read as a flick.
        this.cx = m.x;
        this.cy = m.y;
        this.xPrev = null;
        this.yPrev = null;
        this.flickCooldownUntil = Math.max(this.flickCooldownUntil, tMs + 250);
      } else {
        const speed = jump / dtRaw;
        const gain = clamp(
          TUNING.gainFloor + speed / TUNING.gainFullSpeed,
          TUNING.gainFloor,
          TUNING.gainCeil,
        );
        this.cx += dxm * gain + (m.x - this.cx) * TUNING.driftCorrect;
        this.cy += dym * gain + (m.y - this.cy) * TUNING.driftCorrect;
      }
    } else {
      this.cx = m.x;
      this.cy = m.y;
    }
    this.mPrev = m;

    const x = this.fx.filter(this.cx, tMs);
    const y = this.fy.filter(this.cy, tMs);

    let vx = 0;
    let vy = 0;
    if (this.xPrev !== null && this.yPrev !== null && this.tPrev !== null) {
      vx = (x - this.xPrev) / dtRaw;
      vy = (y - this.yPrev) / dtRaw;
    }
    this.xPrev = x;
    this.yPrev = y;
    this.tPrev = tMs;
    const speed = Math.hypot(vx, vy);

    // --- pinch (gated while a pose is held: a fist is not a pinch) ---
    const ratio = pinchRatio(landmarks);
    if (pose === "none" || pose === "palm") {
      // Calibration learns only from unambiguous frames.
      this.rMin = Math.min(ratio, this.rMin + 0.002);
      this.rMax = Math.max(ratio, this.rMax - 0.002);
      this.calSamples++;
    }
    const { close, open } = this.thresholds();
    const gatePinch = pose === "fist" || pose === "thumbs" || pose === "scroll";
    const edges = this.pinch.step(gatePinch ? null : ratio, close, open);

    let pinchStart = false;
    let drop = false;
    let click = false;
    if (edges.start) {
      pinchStart = true;
      this.pinchStartX = x;
      this.pinchStartY = y;
      this.travelled = false;
    } else if (edges.end) {
      // A pinch ended by the POSE GATE is not a tap: a hand closing into a
      // fist passes through a pinch-like shape on the way down, and that
      // must never click whatever the cursor happens to be over. A held
      // drag still drops (a grabbed panel must always be released).
      if (this.travelled) drop = true;
      else if (!gatePinch) click = true;
    }
    if (this.pinch.pinched && !this.travelled) {
      const moved = Math.hypot(x - this.pinchStartX, y - this.pinchStartY);
      if (moved > TUNING.clickMaxTravelPx) this.travelled = true;
    }

    // --- pose dwells ---
    let crush = false;
    let palmAction = false;
    let thumbsAction = false;
    let dwell = 0;
    const dwellPose = pose === "fist" || pose === "palm" || pose === "thumbs";
    if (dwellPose && !this.pinch.pinched && tMs >= this.poseCooldownUntil) {
      if (this.poseHeld !== pose || speed > TUNING.dwellMaxSpeed) {
        this.poseHeld = pose;
        this.poseSince = tMs;
        this.poseFired = false;
      }
      const need =
        pose === "fist"
          ? TUNING.fistHoldMs
          : pose === "palm"
            ? TUNING.palmHoldMs
            : TUNING.thumbsHoldMs;
      dwell = clamp((tMs - this.poseSince) / need, 0, 1);
      if (dwell >= 1 && !this.poseFired) {
        this.poseFired = true;
        this.poseCooldownUntil = tMs + TUNING.poseCooldownMs;
        if (pose === "fist") crush = true;
        else if (pose === "palm") palmAction = true;
        else thumbsAction = true;
      }
    } else {
      this.poseHeld = "none";
    }

    // --- scroll pose: vertical cursor delta while the V is held ---
    let scrollDy = 0;
    if (pose === "scroll") {
      if (this.scrollPrevY !== null) scrollDy = y - this.scrollPrevY;
      this.scrollPrevY = y;
    } else {
      this.scrollPrevY = null;
    }

    // --- flick: a fast, flat, open-handed sweep ---
    let flick: -1 | 0 | 1 = 0;
    if (
      !this.pinch.pinched &&
      pose !== "scroll" &&
      tMs >= this.flickCooldownUntil &&
      Math.abs(vx) > TUNING.flickSpeed &&
      Math.abs(vx) > Math.abs(vy) * TUNING.flickDominance
    ) {
      flick = vx > 0 ? 1 : -1;
      this.flickCooldownUntil = tMs + TUNING.flickCooldownMs;
    }

    // --- two-hand pinch: resize ---
    let twoPinch = false;
    let twoPinchStart = false;
    let twoPinchScale = 1;
    const second = hands[1];
    if (second && this.pinch.pinched) {
      const r2 = pinchRatio(second.landmarks);
      this.pinch2.step(r2, close, open);
      if (this.pinch2.pinched) {
        const p1 = mapToViewport(landmarks[LM.indexMcp], viewportW, viewportH, cfg.reach);
        const p2 = mapToViewport(second.landmarks[LM.indexMcp], viewportW, viewportH, cfg.reach);
        const dist = Math.max(Math.hypot(p1.x - p2.x, p1.y - p2.y), 40);
        if (this.twoStartDist === 0) {
          this.twoStartDist = dist;
          twoPinchStart = true;
        }
        twoPinch = true;
        twoPinchScale = dist / this.twoStartDist;
      } else {
        this.twoStartDist = 0;
      }
    } else {
      this.pinch2.reset();
      this.twoStartDist = 0;
    }

    return {
      x,
      y,
      vx,
      vy,
      pinching: this.pinch.pinched,
      pinchStart,
      drop,
      click,
      dragging: this.pinch.pinched && this.travelled,
      pose,
      crush,
      palmAction,
      thumbsAction,
      dwell,
      scrollDy,
      flick,
      twoPinch,
      twoPinchStart,
      twoPinchScale,
      landmarks,
    };
  }

  /** The hand left the frame: forget everything, release any held pinch. */
  reset(): { wasPinched: boolean } {
    const wasPinched = this.pinch.reset();
    this.pinch2.reset();
    this.fx.reset();
    this.fy.reset();
    this.cx = null;
    this.cy = null;
    this.mPrev = null;
    this.xPrev = null;
    this.yPrev = null;
    this.tPrev = null;
    this.travelled = false;
    this.poseHeld = "none";
    this.scrollPrevY = null;
    this.twoStartDist = 0;
    return { wasPinched };
  }
}
