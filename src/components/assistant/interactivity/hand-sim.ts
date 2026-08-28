"use client";

/**
 * The simulated hand — the harness's camera.
 *
 * With `localStorage["arc-hand-sim"] = "1"`, `use-hand-tracking` emits
 * synthetic landmarks built from the MOUSE instead of opening a camera.
 * The pointer's position becomes the index knuckle (run through the same
 * mirror-and-reach-box mapping in reverse, so the mapping itself is under
 * test), and held keys shape the hand:
 *
 *   SPACE  pinch (thumb to index)
 *   F      fist            → crush-close, after the dwell
 *   P      open palm       → menu toggle, after the dwell
 *   V      two-finger V    → scroll pose; move the mouse vertically
 *   T      thumbs-up       → approve, after the dwell
 *   D      SECOND hand, pinched, frozen where D was pressed — hold SPACE
 *          too and move the mouse to change the distance: the resize.
 *
 * Keys are ignored while typing in an input. Everything downstream — the
 * filters, the pose classifier, the dwell timers, hit-testing, the drag
 * registry — is exactly the code the real hand drives.
 */

import {
  LM,
  type HandInput,
  type Landmark,
} from "@/components/assistant/interactivity/gesture-engine";
import { readHandPrefs } from "@/components/assistant/interactivity/hand-prefs";

export function simEnabled(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem("arc-hand-sim") === "1"
    );
  } catch {
    return false;
  }
}

/** Viewport point → the camera-space landmark that maps back onto it. */
function toCamera(px: number, py: number): { x: number; y: number } {
  const reach = readHandPrefs().reach;
  const lo = (1 - reach) / 2;
  const nx = px / window.innerWidth;
  const ny = py / window.innerHeight;
  return { x: 1 - (lo + nx * reach), y: lo + ny * reach };
}

type SimPose = "neutral" | "pinch" | "fist" | "palm" | "scroll" | "thumbs";

/**
 * A plausible 21-point hand around the knuckle, shaped per pose. The
 * classifier reads tip-vs-PIP distances from the wrist, so each pose only
 * has to get THOSE ratios right; the rest is set dressing for the glyph.
 */
function buildHand(cx: number, cy: number, pose: SimPose): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  const set = (i: number, dx: number, dy: number) => {
    lm[i] = { x: cx + dx, y: cy + dy, z: 0 };
  };
  set(LM.wrist, 0.05, 0.2);
  set(LM.middleMcp, -0.02, -0.01); // span wrist↔middleMcp ≈ 0.22
  set(LM.indexMcp, 0, 0);
  // The ring and pinky KNUCKLES: the classifier measures the thumb against
  // the pinky MCP (17), so the palm's width must exist or "thumb out" can
  // never be true and palm/thumbs-up become unclassifiable.
  set(13, -0.045, 0.005);
  set(17, -0.07, 0.01);

  // Finger chains: [mcp, x-offset]; a finger is drawn extended or curled.
  const chain = (mcp: number, dx: number, extended: boolean) => {
    if (extended) {
      set(mcp + 1, dx - 0.005, -0.04);
      set(mcp + 2, dx - 0.01, -0.07);
      set(mcp + 3, dx - 0.015, -0.095);
    } else {
      // Curled: the tip folds back toward the palm, INSIDE the pip.
      set(mcp + 1, dx - 0.005, -0.03);
      set(mcp + 2, dx, 0.005);
      set(mcp + 3, dx + 0.01, 0.04);
    }
  };

  const fingersExtended: Record<SimPose, [boolean, boolean, boolean, boolean]> = {
    neutral: [true, true, true, true],
    pinch: [true, true, true, true],
    fist: [false, false, false, false],
    palm: [true, true, true, true],
    scroll: [true, true, false, false],
    thumbs: [false, false, false, false],
  };
  const [fi, fm, fr, fp] = fingersExtended[pose];
  chain(5, 0, fi); // index (5 is already set; 6..8 here)
  chain(9, -0.025, fm);
  chain(13, -0.05, fr);
  chain(17, -0.075, fp);

  // Thumb.
  set(1, 0.06, 0.14);
  set(2, 0.08, 0.09);
  if (pose === "pinch") {
    set(3, 0.02, -0.04);
    set(LM.thumbTip, -0.015, -0.08); // at the index tip: ratio ≈ 0.03
  } else if (pose === "thumbs") {
    set(3, 0.09, 0.02);
    set(LM.thumbTip, 0.1, -0.14); // clear of the hand and pointing up
  } else if (pose === "fist") {
    set(3, 0.05, 0.06);
    set(LM.thumbTip, 0.035, 0.03); // tucked
  } else if (pose === "palm") {
    set(3, 0.09, 0.04);
    set(LM.thumbTip, 0.13, 0.0); // out wide — reads as a deliberate palm
  } else {
    set(3, 0.08, 0.05);
    set(LM.thumbTip, 0.09, 0.02); // relaxed: near enough to NOT be a palm
  }
  return lm;
}

/**
 * Start emitting synthetic frames at ~30Hz. Returns the teardown.
 */
export function startSim(
  emit: (hands: HandInput[] | null, t: number) => void,
): () => void {
  let px = window.innerWidth / 2;
  let py = window.innerHeight / 2;
  const held = new Set<string>();
  let second: { x: number; y: number } | null = null;

  const onMove = (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
  };
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"));
  };
  const onDown = (e: KeyboardEvent) => {
    if (typing(e)) return;
    if (["Space", "KeyF", "KeyP", "KeyV", "KeyT", "KeyD"].includes(e.code)) {
      e.preventDefault();
      if (e.code === "KeyD" && !held.has("KeyD")) {
        // The second hand appears pinched, frozen a hand-width away.
        const c = toCamera(px, py);
        second = { x: c.x + 0.28, y: c.y };
      }
      held.add(e.code);
    }
  };
  const onUp = (e: KeyboardEvent) => {
    held.delete(e.code);
    if (e.code === "KeyD") second = null;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);

  const pose = (): SimPose => {
    if (held.has("KeyF")) return "fist";
    if (held.has("KeyP")) return "palm";
    if (held.has("KeyV")) return "scroll";
    if (held.has("KeyT")) return "thumbs";
    if (held.has("Space")) return "pinch";
    return "neutral";
  };

  let raf = 0;
  let last = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 33) return; // ~30Hz, like the camera
    last = now;
    const c = toCamera(px, py);
    // Labels as MediaPipe reports them for an UNFLIPPED selfie feed: the
    // user's right hand arrives labelled "Left" (see orderHands).
    const hands: HandInput[] = [
      { landmarks: buildHand(c.x, c.y, pose()), handedness: "Left" },
    ];
    if (second) {
      hands.push({
        landmarks: buildHand(second.x, second.y, "pinch"),
        handedness: "Right",
      });
    }
    emit(hands, now);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("keydown", onDown);
    window.removeEventListener("keyup", onUp);
  };
}
