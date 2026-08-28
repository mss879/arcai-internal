"use client";

/**
 * Hands preferences — local to the device, like every other Studio layout
 * choice. Camera behaviour is a per-machine comfort setting, not workspace
 * data, so nothing here touches the database.
 *
 * Writes dispatch a window event so a LIVE session re-tunes instantly —
 * the settings panel and the running command view are separate trees, and
 * "move the slider, feel the cursor change" is the whole point of a
 * sensitivity setting.
 */

import * as React from "react";

import { STUDIO_KEYS, readPref, writePref } from "@/components/assistant/studio-store";

export type HandSmoothing = "fast" | "balanced" | "steady";

/** Which hand drives the cursor: either, or strictly one. */
export type HandChoice = "any" | "right" | "left";

export type HandPrefs = {
  /** Reach box fraction — smaller = less hand travel covers the screen. */
  reach: number;
  smoothing: HandSmoothing;
  sounds: boolean;
  skeleton: boolean;
  /** Only this hand is tracked; the other is ignored (except as the
   *  second hand of a two-hand resize). */
  hand: HandChoice;
};

export const HAND_PREF_DEFAULTS: HandPrefs = {
  reach: 0.6,
  smoothing: "balanced",
  sounds: true,
  skeleton: true,
  hand: "any",
};

/** One-Euro presets per smoothing choice: cutoff/beta. */
export const SMOOTHING_TUNING: Record<
  HandSmoothing,
  { minCutoff: number; beta: number }
> = {
  fast: { minCutoff: 2.2, beta: 0.03 },
  balanced: { minCutoff: 1.2, beta: 0.012 },
  steady: { minCutoff: 0.7, beta: 0.006 },
};

const EVENT = "arc-hand-prefs";

export function readHandPrefs(): HandPrefs {
  const stored = readPref<Partial<HandPrefs>>(STUDIO_KEYS.handPrefs, {});
  return { ...HAND_PREF_DEFAULTS, ...stored };
}

export function writeHandPrefs(patch: Partial<HandPrefs>): HandPrefs {
  const next = { ...readHandPrefs(), ...patch };
  writePref(STUDIO_KEYS.handPrefs, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
  return next;
}

/** Live view of the prefs — re-renders when the settings panel writes. */
export function useHandPrefs(): HandPrefs {
  const [prefs, setPrefs] = React.useState<HandPrefs>(HAND_PREF_DEFAULTS);
  React.useEffect(() => {
    setPrefs(readHandPrefs());
    const onChange = () => setPrefs(readHandPrefs());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return prefs;
}
