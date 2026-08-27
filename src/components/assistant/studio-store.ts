"use client";

/**
 * Arc Studio's layout memory — the small, boring state that has to survive a
 * reload: which mode the assistant was last opened in, how wide the user
 * dragged the preview canvas, whether the rail was collapsed, whether voice
 * was muted.
 *
 * Why it lives in its own module rather than inside the components: the shell
 * (`voice-assistant.tsx`) and the workspace (`assistant-workspace.tsx`) both
 * read and write the same keys, and a duplicated string literal is how one
 * surface quietly stops remembering what the other saved. Every access is
 * `try/catch`'d because Safari's private mode throws on *read*, not just on
 * write, and a storage error must never take the assistant down with it.
 *
 * Nothing here touches the DOM during render — all defaults are applied in a
 * mount effect by the caller, since the app is server-rendered and a
 * first-render `localStorage` read is a hydration mismatch.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";

/**
 * The three shapes the assistant takes.
 *
 * - `bubble` — closed; only the draggable launcher is on screen.
 * - `dock` — the small corner panel, for a quick question.
 * - `full` — the full-screen workspace with history, transcript and canvas.
 */
export type StudioMode = "bubble" | "dock" | "full";

/**
 * Which shape the full-screen surface takes.
 *
 * - `command` — the stage: results fill the screen, chat docks bottom-right.
 * - `classic` — the original three columns: rail | transcript | canvas.
 *
 * `command` is the default because that is the point of the room; `classic`
 * stays one click away in the header, and nothing about it changed.
 */
export type StudioView = "command" | "classic";

/** Everything about the geometry the user is allowed to change. */
export type StudioLayout = {
  dock: { w: number; h: number };
  /** Canvas width as a fraction of the panel, not a pixel count — so the
   *  proportions survive a window resize instead of stranding the canvas. */
  canvasRatio: number;
  railOpen: boolean;
  canvasOpen: boolean;
};

/** Every localStorage key Studio owns, in one place. */
export const STUDIO_KEYS = {
  /** The launcher's dragged position. Pre-existing — never rename it. */
  pos: "arc-assistant-pos",
  mode: "arc-studio-mode",
  dock: "arc-studio-dock",
  canvas: "arc-studio-canvas",
  rail: "arc-studio-rail",
  canvasOpen: "arc-studio-canvas-open",
  muted: "arc-studio-muted",
  view: "arc-studio-view",
} as const;

/** The stage, unless this browser has been told otherwise. */
export const DEFAULT_VIEW: StudioView = "command";

/**
 * Restore the view, treating anything unrecognised as the default.
 *
 * A hand-edited or half-written value must not strand the user in a surface
 * that does not exist — there are only two, and one of them is always right.
 */
export function readView(): StudioView {
  return readPref(STUDIO_KEYS.view, DEFAULT_VIEW) === "classic"
    ? "classic"
    : "command";
}

export const DEFAULT_LAYOUT: StudioLayout = {
  dock: { w: 400, h: 640 },
  canvasRatio: 0.46,
  railOpen: true,
  canvasOpen: true,
};

/** Narrower than this and the preview stops being a preview. */
export const CANVAS_MIN_PX = 360;
/** The conversation's hard floor — bubbles below this stop being readable. */
export const CENTRE_MIN_PX = 420;
export const RAIL_PX = 264;
/** Below this PANEL width the rail becomes an overlay drawer. */
export const RAIL_INLINE_MIN_PX = 1280;
export const CANVAS_MIN_RATIO = 0.25;
export const CANVAS_MAX_RATIO = 0.7;

/** Dock clamps, applied on every resize and on restore. */
export const DOCK_MIN_W = 360;
export const DOCK_MAX_W = 760;
export const DOCK_MIN_H = 420;

/** Full mode needs a real desktop; phones keep `MobileVoiceScreen`. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The four things the user is most likely to want, shown on an empty thread.
 * Defined once so the composer and the empty transcript can never drift.
 */
export const STUDIO_SUGGESTIONS = [
  "Write a proposal for Silva for the smart website",
  "Who owes me money right now?",
  "Show me this month's numbers",
  "Open my client list",
];

/** Read a JSON preference. Returns `fallback` on absence or any failure. */
export function readPref<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON preference. Silent on quota or private-mode failures. */
export function writePref<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A preference is never worth an exception.
  }
}

/** Clamp a number into a range, tolerating NaN from corrupted storage. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Restore a layout, clamping anything a stale or hand-edited value broke. */
export function readLayout(): StudioLayout {
  const dock = readPref(STUDIO_KEYS.dock, DEFAULT_LAYOUT.dock);
  const ratio = readPref(STUDIO_KEYS.canvas, DEFAULT_LAYOUT.canvasRatio);
  return {
    dock: {
      w: clamp(Number(dock?.w), DOCK_MIN_W, DOCK_MAX_W),
      h: clamp(Number(dock?.h), DOCK_MIN_H, 2000),
    },
    canvasRatio: clamp(Number(ratio), CANVAS_MIN_RATIO, CANVAS_MAX_RATIO),
    railOpen: readPref(STUDIO_KEYS.rail, DEFAULT_LAYOUT.railOpen) !== false,
    canvasOpen:
      readPref(STUDIO_KEYS.canvasOpen, DEFAULT_LAYOUT.canvasOpen) !== false,
  };
}

/**
 * `matchMedia` as a hook. Deliberately `false` on the first render: the app is
 * server-rendered, so anything else is a hydration mismatch, and every caller
 * treats `false` as "don't mount the desktop surface yet".
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * `useReducedMotion()` normalised to a plain boolean.
 *
 * motion's hook returns `boolean | null` (null before it has read the media
 * query), and `null` in a ternary silently picks the animated branch on the
 * very first paint. Every Studio component wants "assume still until told
 * otherwise", so the coercion happens once, here.
 */
export function useReducedMotionSafe(): boolean {
  return useReducedMotion() === true;
}

/**
 * True when this window is inside an iframe.
 *
 * Studio embeds real app pages in its preview canvas (`?embed=1`). If the
 * assistant also mounted inside that frame it could open a page artifact of
 * its own — an infinite recursion that locks the tab. This is the second of
 * two independent guards; the other is `AppShell`'s embed branch.
 */
export function useIsEmbedded(): boolean {
  const [embedded, setEmbedded] = React.useState(false);
  React.useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      // A cross-origin parent throws on access — which itself means framed.
      setEmbedded(true);
    }
  }, []);
  return embedded;
}
