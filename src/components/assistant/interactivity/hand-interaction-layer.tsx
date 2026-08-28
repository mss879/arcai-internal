"use client";

/**
 * The conductor — where landmarks become intent.
 *
 * Subscribes to a `HandSource` (the real camera hook, or the harness's
 * mouse-driven fake — this file cannot tell the difference, which is the
 * point), runs the pure gesture engine, and turns its edges into action:
 *
 *  - HOVER: `elementFromPoint`, throttled to actual movement, finds the
 *    interactive element under the reticle; nearby small targets pull the
 *    displayed cursor toward their centre (the magnet), so near-misses
 *    become hits without the engine's real position ever lying.
 *  - CLICK: pinch released in place fires `el.click()` — real DOM clicks,
 *    so React handlers, links and buttons respond without knowing hands
 *    exist.
 *  - GRAB: a held pinch over `[data-hand-drag]` drives the drag registry.
 *    The MOUSE drives the very same callbacks via `beginFromPointer`.
 *  - POSES: a held fist CRUSHES (closes) the panel under the cursor, a
 *    held palm toggles the menu, a held thumbs-up presses the first
 *    visible `[data-hand-approve]`, a two-finger V SCROLLS whatever is
 *    under the cursor (live page iframes included), a fast flat sweep
 *    FLICKS between artifacts, and pinching with BOTH hands stretches a
 *    held panel — the resize.
 *
 * Everything per-frame lives in refs and the shared `HandVisual`; the only
 * React state anywhere near this file is the coarse tracking state, and it
 * lives in the hook, not here.
 */

import * as React from "react";

import {
  GestureEngine,
  type HandInput,
} from "@/components/assistant/interactivity/gesture-engine";
import {
  createHandVisual,
  HandCursor,
  type HandVisual,
} from "@/components/assistant/interactivity/hand-cursor";
import {
  SMOOTHING_TUNING,
  type HandPrefs,
} from "@/components/assistant/interactivity/hand-prefs";
import {
  ensureAudio,
  handSound,
  setSoundsEnabled,
} from "@/components/assistant/interactivity/hand-sounds";
import type { HandSource } from "@/components/assistant/interactivity/use-hand-tracking";

// ---------------------------------------------------------------------------
// The drag registry — one drag implementation, two input devices.
// ---------------------------------------------------------------------------

export type DragEntry = {
  onStart: (x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: (x: number, y: number) => void;
  /** A held fist over this target — close it. */
  crush?: () => void;
  /** Two-hand stretch while held: live scale vs the grab moment. */
  resize?: (scale: number) => void;
  resizeEnd?: () => void;
};

export type DragRegistry = {
  /** Register a draggable under the id its `data-hand-drag` carries. */
  register: (id: string, entry: DragEntry) => () => void;
  /** Mouse path: call from a handle's onPointerDown; window listeners do the rest. */
  beginFromPointer: (id: string, e: React.PointerEvent) => void;
};

const DragContext = React.createContext<DragRegistry | null>(null);

export function useDragRegistry(): DragRegistry {
  const ctx = React.useContext(DragContext);
  if (!ctx) throw new Error("useDragRegistry outside HandInteractionLayer");
  return ctx;
}

/** Gesture-triggered actions the host view wires in. */
export type HandActions = {
  /** Held open palm — toggle the areas menu. */
  palm?: () => void;
  /** Fast horizontal sweep — cycle the hero artifact. */
  flick?: (dir: 1 | -1) => void;
};

/**
 * While ANY drag is live, iframes must stop eating the pointer: a live page
 * panel swallows pointermove the moment the cursor crosses it, which
 * freezes a mouse drag mid-air and blinds the sim hand.
 */
function setDragging(on: boolean): void {
  document.body.classList.toggle("arc-hand-dragging", on);
}

/** What the cursor should treat as clickable. */
const CLICKABLE = 'button, a, [role="button"], [data-hand-target]';

/**
 * Pick the PRIMARY hand per the user's setting. MediaPipe's handedness
 * labels assume a mirrored (selfie-flipped) input; our frames go to the
 * model unflipped, so the labels arrive swapped — the user's RIGHT hand
 * reports as "Left". The swap lives here, in exactly one place.
 *
 * With a hand selected, the other hand never drives the cursor — but it is
 * still welcome as the SECOND hand of a two-hand resize.
 */
function orderHands(
  hands: HandInput[],
  want: "any" | "right" | "left",
): HandInput[] | null {
  if (want === "any") return hands;
  const label = want === "right" ? "Left" : "Right";
  const primary = hands.find((h) => h.handedness === label);
  if (!primary) return null;
  return [primary, ...hands.filter((h) => h !== primary)];
}

/** Magnet: pull radius and strength for small targets. */
const MAGNET_RADIUS = 40;
const MAGNET_PULL = 0.4;
const MAGNET_MAX_TARGET = 260;

const POSE_LABEL: Record<string, string> = {
  fist: "HOLD · CLOSE",
  palm: "HOLD · MENU",
  thumbs: "HOLD · APPROVE",
  scroll: "SCROLL",
};

/** Scroll the thing under the cursor — panels, lists, live page iframes. */
function scrollUnder(x: number, y: number, dy: number): void {
  // Touch semantics, not wheel: the hand PUSHES the content. Raising the
  // hand moves the content up, revealing what lies further down.
  const px = -dy * 2.2;
  let el = document.elementFromPoint(x, y);
  while (el) {
    if (el instanceof HTMLIFrameElement) {
      try {
        el.contentWindow?.scrollBy(0, px);
      } catch {
        /* cross-origin frame — nothing to scroll */
      }
      return;
    }
    if (
      el instanceof HTMLElement &&
      el.scrollHeight > el.clientHeight + 4 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY)
    ) {
      el.scrollTop += px;
      return;
    }
    el = el.parentElement;
  }
}

export function HandInteractionLayer({
  source,
  prefs,
  actions,
  children,
}: {
  source: HandSource;
  prefs: HandPrefs;
  actions?: HandActions;
  children: React.ReactNode;
}) {
  // One visual object and one engine for the lifetime of the layer, held
  // as never-set state: stable identity, mutated freely outside render.
  const [visual] = React.useState<HandVisual>(createHandVisual);
  const [engine] = React.useState(() => new GestureEngine());

  const entriesRef = React.useRef<Map<string, DragEntry>>(new Map());
  const actionsRef = React.useRef<HandActions | undefined>(actions);
  const handChoiceRef = React.useRef(prefs.hand);
  React.useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  React.useEffect(() => {
    handChoiceRef.current = prefs.hand;
  }, [prefs.hand]);

  // Live drag bookkeeping, hand path only (the mouse path is self-contained).
  const grabRef = React.useRef<{ id: string; started: boolean } | null>(null);
  const resizingRef = React.useRef(false);
  // Hover cache: hit-testing only when the cursor actually moved.
  const hoverRef = React.useRef<{ x: number; y: number; el: Element | null }>({
    x: -1e9,
    y: -1e9,
    el: null,
  });

  // Settings → the engine and the sounds. Live: the prefs hook re-renders
  // on every settings write, and this effect re-tunes.
  React.useEffect(() => {
    engine.setConfig({ reach: prefs.reach, ...SMOOTHING_TUNING[prefs.smoothing] });
    setSoundsEnabled(prefs.sounds);
  }, [engine, prefs]);

  // WebAudio needs a REAL user gesture; any genuine input wakes it so the
  // first hand gesture can already tick.
  React.useEffect(() => {
    const wake = () => ensureAudio();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  const registry = React.useMemo<DragRegistry>(() => {
    return {
      register: (id, entry) => {
        entriesRef.current.set(id, entry);
        return () => {
          entriesRef.current.delete(id);
        };
      },
      beginFromPointer: (id, e) => {
        const entry = entriesRef.current.get(id);
        if (!entry || e.button !== 0) return;
        e.preventDefault();
        setDragging(true);
        entry.onStart(e.clientX, e.clientY);
        const move = (ev: PointerEvent) => entry.onMove(ev.clientX, ev.clientY);
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          setDragging(false);
          entry.onEnd(ev.clientX, ev.clientY);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    };
  }, []);

  React.useEffect(() => {
    const endGrab = (x: number, y: number) => {
      const grab = grabRef.current;
      if (grab?.started) {
        const entry = entriesRef.current.get(grab.id);
        if (resizingRef.current) entry?.resizeEnd?.();
        entry?.onEnd(x, y);
        handSound.drop();
      }
      grabRef.current = null;
      resizingRef.current = false;
    };

    const onFrame = (rawHands: HandInput[] | null, t: number) => {
      const hands = rawHands
        ? orderHands(rawHands, handChoiceRef.current)
        : null;
      if (!hands) {
        // The hand left the frame: fade the cursor, and if it left while
        // holding something, DROP it where it was.
        const { wasPinched } = engine.reset();
        if (wasPinched) {
          setDragging(false);
          endGrab(visual.x, visual.y);
        }
        visual.visible = false;
        visual.target = null;
        visual.landmarks = null;
        visual.label = "";
        visual.dwell = 0;
        return;
      }

      const frame = engine.process(
        hands,
        t,
        window.innerWidth,
        window.innerHeight,
      );

      // --- hover (throttled to real movement) ---
      const hover = hoverRef.current;
      if (Math.hypot(frame.x - hover.x, frame.y - hover.y) > 4) {
        hover.x = frame.x;
        hover.y = frame.y;
        const prev = hover.el;
        hover.el =
          document
            .elementFromPoint(frame.x, frame.y)
            ?.closest(`${CLICKABLE}, [data-hand-drag]`) ?? null;
        if (hover.el && hover.el !== prev) handSound.hover();
      }

      // --- the magnet: near-misses on small targets become hits ---
      let sx = frame.x;
      let sy = frame.y;
      const magnetEl = hover.el?.closest(CLICKABLE);
      if (magnetEl && !frame.pinching) {
        const r = magnetEl.getBoundingClientRect();
        if (Math.max(r.width, r.height) <= MAGNET_MAX_TARGET) {
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (Math.hypot(cx - frame.x, cy - frame.y) < MAGNET_RADIUS) {
            sx = frame.x + (cx - frame.x) * MAGNET_PULL;
            sy = frame.y + (cy - frame.y) * MAGNET_PULL;
          }
        }
      }

      // --- publish the sample (the cursor extrapolates from these) ---
      visual.visible = true;
      visual.x = sx;
      visual.y = sy;
      visual.vx = frame.vx;
      visual.vy = frame.vy;
      visual.sampleAt = performance.now();
      visual.landmarks = frame.landmarks;
      visual.dwell = frame.dwell;

      // --- gesture edges ---
      if (frame.pinchStart) {
        // Fresh hit-test, not the hover cache: the cache only refreshes
        // after 4px of motion, and a pinch after a still hover would grab
        // whatever the cursor USED to be over.
        const dragEl = document
          .elementFromPoint(frame.x, frame.y)
          ?.closest("[data-hand-drag]");
        const id = dragEl?.getAttribute("data-hand-drag");
        grabRef.current = id ? { id, started: false } : null;
        // Pass-through starts at the PINCH, not at drag-start: the pinched
        // hand may cross an iframe before it has travelled far enough to
        // count as dragging.
        setDragging(true);
      }

      const grab = grabRef.current;
      // The two-hand pinch counts as engagement on its own: stretching with
      // the second hand should not require the first to travel anywhere.
      if ((frame.dragging || frame.twoPinch) && grab) {
        const entry = entriesRef.current.get(grab.id);
        if (entry) {
          if (!grab.started) {
            grab.started = true;
            entry.onStart(frame.x, frame.y);
            handSound.grab();
          }
          // --- two-hand resize: while both pinch, stretch instead of move ---
          if (frame.twoPinch && entry.resize) {
            resizingRef.current = true;
            entry.resize(frame.twoPinchScale);
          } else {
            if (resizingRef.current) {
              resizingRef.current = false;
              entry.resizeEnd?.();
            }
            entry.onMove(frame.x, frame.y);
          }
        }
      }

      if (frame.click) {
        setDragging(false);
        grabRef.current = null;
        const el = hover.el?.closest(CLICKABLE);
        if (el instanceof HTMLElement) {
          el.click();
          handSound.click();
        }
      } else if (frame.drop) {
        setDragging(false);
        endGrab(frame.x, frame.y);
      }

      // --- pose actions ---
      if (frame.crush) {
        // A fist anywhere over a frame counts — hit-test fresh rather than
        // through the hover cache, whose selector stops at clickables.
        const crushEl = document
          .elementFromPoint(frame.x, frame.y)
          ?.closest("[data-hand-crush]");
        const id = crushEl?.getAttribute("data-hand-crush");
        const entry = id ? entriesRef.current.get(id) : null;
        if (entry?.crush) {
          entry.crush();
          handSound.pose();
        }
      }
      if (frame.palmAction && actionsRef.current?.palm) {
        actionsRef.current.palm();
        handSound.pose();
      }
      if (frame.thumbsAction) {
        const approve = document.querySelector("[data-hand-approve]");
        if (approve instanceof HTMLElement) {
          approve.click();
          handSound.pose();
        }
      }
      if (frame.flick && actionsRef.current?.flick) {
        actionsRef.current.flick(frame.flick);
        handSound.pose();
      }
      if (frame.scrollDy !== 0) {
        scrollUnder(frame.x, frame.y, frame.scrollDy);
      }

      // --- visual mode + label + brackets ---
      visual.mode =
        frame.pose === "scroll"
          ? "scroll"
          : frame.pose !== "none"
            ? "pose"
            : frame.dragging
              ? "drag"
              : frame.pinching
                ? "pinch"
                : hover.el
                  ? "hover"
                  : "idle";
      visual.label = frame.twoPinch
        ? "RESIZE"
        : (POSE_LABEL[frame.pose] ?? "");
      if (frame.dragging || frame.pose !== "none") {
        visual.target = null;
      } else if (hover.el) {
        const r = hover.el.getBoundingClientRect();
        visual.target = { left: r.left, top: r.top, width: r.width, height: r.height };
      } else {
        visual.target = null;
      }
    };

    return source.subscribe(onFrame);
  }, [source, visual, engine]);

  return (
    <DragContext.Provider value={registry}>
      {children}
      <HandCursor visual={visual} skeleton={prefs.skeleton} />
    </DragContext.Provider>
  );
}
