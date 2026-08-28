/**
 * Hand poses, read straight off the 21 landmarks — no second model.
 *
 * MediaPipe ships a GestureRecognizer task that would label these for us,
 * but it is another 8MB download for five poses a page of geometry can
 * classify deterministically. Everything here is ratios of distances
 * normalised by the hand's own proportions, so distance from the camera
 * and hand size cancel out.
 *
 * The vocabulary (chosen to be UNAMBIGUOUS against the pinch):
 *
 *   FIST    — all four fingers deeply curled, thumb not raised.
 *             A pinch never reads as a fist: pinching keeps the index tip
 *             out by the thumb, far from the palm.
 *   THUMBS  — a fist with the thumb extended and pointing up.
 *   PALM    — everything extended: the open hand.
 *   SCROLL  — index + middle extended, ring + pinky curled (the V).
 *
 * The engine gates the pinch state machine while a pose is held, so a
 * fist closing can never fire a phantom pinch on its way down.
 */

import type { Landmark } from "@/components/assistant/interactivity/gesture-engine";

export type Pose = "none" | "fist" | "thumbs" | "palm" | "scroll";

const WRIST = 0;

/** [pip, tip] per finger, index → pinky. */
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [6, 8],
  [10, 12],
  [14, 16],
  [18, 20],
];

const d = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

/** Extension per finger: tip clearly beyond the PIP, measured from the wrist. */
function fingerStates(lm: Landmark[]): { extended: boolean; curled: boolean }[] {
  const w = lm[WRIST];
  return FINGERS.map(([pip, tip]) => {
    const tipD = d(lm[tip], w);
    const pipD = d(lm[pip], w) || 1e-6;
    return { extended: tipD > pipD * 1.12, curled: tipD < pipD * 0.92 };
  });
}

export function classifyPose(lm: Landmark[]): Pose {
  const f = fingerStates(lm);
  const span = d(lm[WRIST], lm[9]) || 1e-6;

  // Thumb: extended when the tip stands clear of the pinky-side knuckle line.
  const thumbOut = d(lm[4], lm[17]) / span > 0.85;
  // …and "up" when it points against camera-Y from the wrist.
  const thumbUp = thumbOut && (lm[0].y - lm[4].y) / span > 0.55;

  const curledCount = f.filter((s) => s.curled).length;
  const extendedCount = f.filter((s) => s.extended).length;

  if (curledCount === 4) return thumbUp ? "thumbs" : "fist";
  if (extendedCount === 4 && thumbOut) return "palm";
  if (f[0].extended && f[1].extended && f[2].curled && f[3].curled) {
    return "scroll";
  }
  return "none";
}
