"use client";

/**
 * The free stage — what the command stage becomes when hands are on.
 *
 * The fixed hero/rack/shelf arrangement gives way to a canvas of FLOATING
 * panels: the hero artifact in a movable, stretchable frame, the other
 * artifacts as movable tiles, and pages of the app dragged in from the
 * edge menu, opening as a live panel exactly where they were dropped.
 *
 * Physics, not tweens: a panel released mid-motion keeps its velocity and
 * glides out under friction, banking off the stage edges — and a hard
 * downward throw files it straight to the shelf. A held fist crushes a
 * panel closed; two pinched hands stretch one. Every physical behaviour
 * runs on direct style writes inside its own rAF — a drag, a throw and a
 * resize all cost zero React renders. React re-renders only when a panel
 * is born, dies, changes its persisted place, or the stage resizes.
 *
 * The performance guarantee the classic stage makes is kept, adapted: at
 * most one HEAVY surface (an iframe'd page or PDF) is ever mounted; while
 * a live menu page is open a bleed-kind hero demotes itself to a tile.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { PanelLeftOpen } from "lucide-react";

import { ArtifactGlyph } from "@/components/assistant/command/artifact-glyph";
import { StagePanel } from "@/components/assistant/command/stage-panel";
import { HandMenu } from "@/components/assistant/interactivity/hand-menu";
import {
  useDragRegistry,
  type DragEntry,
} from "@/components/assistant/interactivity/hand-interaction-layer";
import { isBleedArtifact } from "@/components/assistant/preview/artifact-view";
import { STUDIO_KEYS, readPref, writePref } from "@/components/assistant/studio-store";
import { pageArtifact, type Artifact } from "@/lib/assistant-artifacts";
import { cn } from "@/lib/utils";

/** Floating metadata tiles beyond the hero; older artifacts go to the shelf. */
const TILE_MAX = 3;
/** Dropping a panel in the bottom strip minimises it to a chip. */
const SHELF_ZONE_PX = 72;
/** Release faster than this (px/s) and the panel glides on. */
const THROW_MIN_SPEED = 500;
/** A release this strongly downward files the panel to the shelf. */
const THROW_TO_SHELF_VY = 950;

type Point = { x: number; y: number };
type Placement = { x: number; y: number; w?: number; h?: number };
type HandLayout = { hero?: Placement; page?: Placement };

/** A local page opened from the menu — never part of the conversation. */
type OpenPage = { href: string; title: string };

// ---------------------------------------------------------------------------
// Throw physics — shared by every floating frame.
// ---------------------------------------------------------------------------

type Glide = { cancel: () => void };

/**
 * Velocity + friction + edge bounce, on direct style writes. Calls `done`
 * with a synthetic "drop point" when the panel comes to rest (or with a
 * shelf-zone point when the throw was a hard downward flick).
 */
function startGlide(
  el: HTMLElement,
  host: HTMLElement,
  vx: number,
  vy: number,
  done: (viewport: Point) => void,
): Glide {
  let x = parseFloat(el.style.left) || 0;
  let y = parseFloat(el.style.top) || 0;
  let cancelled = false;
  let raf = 0;
  let last = performance.now();

  const step = (now: number) => {
    if (cancelled) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    x += vx * dt;
    y += vy * dt;

    const maxX = Math.max(0, host.clientWidth - el.offsetWidth);
    const maxY = Math.max(0, host.clientHeight - 60);
    if (x < 0) { x = 0; vx = -vx * 0.45; }
    else if (x > maxX) { x = maxX; vx = -vx * 0.45; }
    if (y < 0) { y = 0; vy = -vy * 0.45; }
    else if (y > maxY) { y = maxY; vy = -vy * 0.45; }

    const f = Math.exp(-4.2 * dt);
    vx *= f;
    vy *= f;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    if (Math.hypot(vx, vy) > 60) {
      raf = requestAnimationFrame(step);
    } else {
      const r = el.getBoundingClientRect();
      done({ x: r.left + r.width / 2, y: r.top + 20 });
    }
  };
  raf = requestAnimationFrame(step);
  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
}

/** Velocity from the last ~100ms of drag samples. */
class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];
  push(x: number, y: number): void {
    const t = performance.now();
    this.samples.push({ t, x, y });
    while (this.samples.length > 8 || (this.samples[0] && t - this.samples[0].t > 120)) {
      this.samples.shift();
    }
  }
  read(): { vx: number; vy: number } {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = Math.max((b.t - a.t) / 1000, 1 / 120);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }
  clear(): void {
    this.samples = [];
  }
}

// ---------------------------------------------------------------------------
// A movable, stretchable, crushable frame.
// ---------------------------------------------------------------------------

function Floating({
  dragId,
  pos,
  width,
  height,
  z,
  onDropped,
  onGrab,
  onCrush,
  onResized,
  children,
  className,
}: {
  dragId: string;
  pos: Point;
  width: number;
  height: number;
  z: number;
  /** Final viewport point of a drag or throw — the drop-zone decision. */
  onDropped: (viewport: Point, el: HTMLDivElement) => void;
  onGrab?: () => void;
  /** A held fist over this frame — close it. */
  onCrush?: () => void;
  /** Two-hand stretch finished at this size. */
  onResized?: (w: number, h: number) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const registry = useDragRegistry();
  const elRef = React.useRef<HTMLDivElement | null>(null);
  const grabOffset = React.useRef<Point>({ x: 0, y: 0 });
  const velocity = React.useRef(new VelocityTracker());
  const glideRef = React.useRef<Glide | null>(null);
  const baseSize = React.useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  React.useEffect(() => {
    const entry: DragEntry = {
      onStart: (x, y) => {
        const el = elRef.current;
        if (!el) return;
        glideRef.current?.cancel();
        glideRef.current = null;
        onGrab?.();
        const r = el.getBoundingClientRect();
        grabOffset.current = { x: x - r.left, y: y - r.top };
        baseSize.current = { w: r.width, h: r.height };
        velocity.current.clear();
        el.style.transition = "none";
      },
      onMove: (x, y) => {
        const el = elRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!el || !host) return;
        const hr = host.getBoundingClientRect();
        el.style.left = `${x - grabOffset.current.x - hr.left}px`;
        el.style.top = `${y - grabOffset.current.y - hr.top}px`;
        velocity.current.push(x, y);
      },
      onEnd: (x, y) => {
        const el = elRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!el || !host) return;
        const { vx, vy } = velocity.current.read();
        // A hard downward flick files it straight to the shelf.
        if (vy > THROW_TO_SHELF_VY) {
          const hr = host.getBoundingClientRect();
          onDropped({ x, y: hr.bottom - 10 }, el);
          return;
        }
        if (Math.hypot(vx, vy) > THROW_MIN_SPEED) {
          glideRef.current = startGlide(el, host, vx, vy, (p) => {
            glideRef.current = null;
            onDropped(p, el);
          });
          return;
        }
        onDropped({ x, y }, el);
      },
      crush: onCrush,
      resize: onResized
        ? (scale) => {
            const el = elRef.current;
            const host = el?.offsetParent as HTMLElement | null;
            if (!el || !host) return;
            const w = Math.min(Math.max(baseSize.current.w * scale, 340), host.clientWidth * 0.95);
            const h = Math.min(Math.max(baseSize.current.h * scale, 260), host.clientHeight * 0.95);
            el.style.width = `${w}px`;
            el.style.height = `${h}px`;
          }
        : undefined,
      resizeEnd: onResized
        ? () => {
            const el = elRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            baseSize.current = { w: r.width, h: r.height };
            onResized(r.width, r.height);
          }
        : undefined,
    };
    return registry.register(dragId, entry);
  }, [registry, dragId, onGrab, onDropped, onCrush, onResized]);

  React.useEffect(() => () => glideRef.current?.cancel(), []);

  return (
    <div
      ref={elRef}
      // Crush targets the whole frame — a fist anywhere over the panel
      // counts; the drag grab stays on the header bar alone.
      data-hand-crush={dragId}
      className={cn("absolute", className)}
      style={{ left: pos.x, top: pos.y, width, height, zIndex: z }}
    >
      {children}
      <div
        data-hand-drag={dragId}
        onPointerDown={(e) => registry.beginFromPointer(dragId, e)}
        className="absolute left-0 right-24 top-0 h-11 cursor-grab active:cursor-grabbing"
      />
    </div>
  );
}

/** A floating metadata tile — an artifact you can place, pinch to promote. */
function FloatTile({
  artifact,
  pos,
  z,
  onGrab,
  onDropped,
  onPromote,
  onCrush,
}: {
  artifact: Artifact;
  pos: Point;
  z: number;
  onGrab: () => void;
  onDropped: (viewport: Point, el: HTMLDivElement) => void;
  onPromote: (id: string) => void;
  onCrush: () => void;
}) {
  const registry = useDragRegistry();
  const elRef = React.useRef<HTMLDivElement | null>(null);
  const grabOffset = React.useRef<Point>({ x: 0, y: 0 });
  const start = React.useRef<Point>({ x: 0, y: 0 });
  // A drag that travelled must not ALSO count as the click that promotes.
  const draggedRef = React.useRef(false);
  const dragId = `tile:${artifact.id}`;

  React.useEffect(() => {
    return registry.register(dragId, {
      onStart: (x, y) => {
        const el = elRef.current;
        if (!el) return;
        onGrab?.();
        const r = el.getBoundingClientRect();
        grabOffset.current = { x: x - r.left, y: y - r.top };
        start.current = { x, y };
        draggedRef.current = false;
      },
      onMove: (x, y) => {
        const el = elRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!el || !host) return;
        if (Math.hypot(x - start.current.x, y - start.current.y) > 8) {
          draggedRef.current = true;
        }
        const hr = host.getBoundingClientRect();
        el.style.left = `${x - grabOffset.current.x - hr.left}px`;
        el.style.top = `${y - grabOffset.current.y - hr.top}px`;
      },
      onEnd: (x, y) => {
        const el = elRef.current;
        if (el && draggedRef.current) onDropped({ x, y }, el);
      },
      crush: onCrush,
    });
  }, [registry, dragId, onGrab, onDropped, onCrush]);

  return (
    <div
      ref={elRef}
      data-hand-drag={dragId}
      data-hand-crush={dragId}
      onPointerDown={(e) => registry.beginFromPointer(dragId, e)}
      className="absolute w-[236px] cursor-grab active:cursor-grabbing"
      style={{ left: pos.x, top: pos.y, zIndex: z }}
    >
      <button
        type="button"
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          onPromote(artifact.id);
        }}
        className="hud-panel hud-panel--tight group relative flex w-full flex-col gap-1.5 p-3 text-left transition-colors hover:bg-[var(--stage-panel-hover)]"
      >
        <span className="flex items-center gap-2">
          <ArtifactGlyph
            artifact={artifact}
            className="h-3.5 w-3.5 shrink-0 text-[var(--stage-accent)]"
          />
          <span className="truncate text-[12px] font-semibold text-[var(--stage-text)]">
            {artifact.title}
          </span>
        </span>
        {(artifact.summary || artifact.subtitle) && (
          <span className="line-clamp-2 text-[11px] leading-relaxed text-[var(--stage-faint)]">
            {artifact.summary || artifact.subtitle}
          </span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export function InteractiveStage({
  artifacts,
  heroId,
  onPromote,
  onClose,
  onPrompt,
  onNavigate,
  reloadKeys,
  empty,
  menuOpen,
  onToggleMenu,
}: {
  artifacts: Artifact[];
  heroId: string | null;
  onPromote: (id: string) => void;
  onClose: (id: string) => void;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  reloadKeys: Record<string, number>;
  empty: React.ReactNode;
  /** The areas menu — toggled by the button here and by the palm gesture. */
  menuOpen: boolean;
  onToggleMenu: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [page, setPage] = React.useState<OpenPage | null>(null);
  const [pageChips, setPageChips] = React.useState<OpenPage[]>([]);
  /** Bumps whichever panel was touched last to the front. */
  const [front, setFront] = React.useState<"hero" | "page">("page");

  // Panel placements are real state, but written exactly once per DROP or
  // resize — the drag itself moves elements by style writes.
  const [layout, setLayout] = React.useState<HandLayout>(() =>
    readPref<HandLayout>(STUDIO_KEYS.handLayout, {}),
  );
  const placePanel = React.useCallback(
    (which: "hero" | "page", patch: Partial<Placement>) => {
      setLayout((prev) => {
        const next = {
          ...prev,
          [which]: { x: 0, y: 0, ...prev[which], ...patch },
        };
        writePref(STUDIO_KEYS.handLayout, next);
        return next;
      });
    },
    [],
  );

  const [tilePositions, setTilePositions] = React.useState<
    ReadonlyMap<string, Point>
  >(() => new Map());

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const hero =
    artifacts.find((a) => a.id === heroId) ?? artifacts[artifacts.length - 1] ?? null;
  // The one-heavy-surface rule: a live menu page demotes a bleed hero.
  const heroAsTile = Boolean(page && hero && isBleedArtifact(hero));
  const rest = hero ? artifacts.filter((a) => a.id !== hero.id) : [];
  const tileArtifacts = [
    ...(heroAsTile && hero ? [hero] : []),
    ...rest.slice(-TILE_MAX).reverse(),
  ];
  const shelf = rest.slice(0, Math.max(0, rest.length - TILE_MAX));

  const ready = size.w > 0;
  const heroW = layout.hero?.w ?? Math.min(760, Math.max(420, size.w * 0.52));
  const heroH = layout.hero?.h ?? Math.max(320, size.h * 0.72);
  const pageW = layout.page?.w ?? Math.min(720, Math.max(420, size.w * 0.46));
  const pageH = layout.page?.h ?? Math.max(320, size.h * 0.66);

  // Pure in the measured size — it runs during render for the panels'
  // resting positions, so it must not touch a ref.
  const clampPos = React.useCallback(
    (p: Point, w: number): Point => ({
      x: Math.min(Math.max(p.x, 0), Math.max(0, size.w - w)),
      y: Math.min(Math.max(p.y, 0), Math.max(0, size.h - 96)),
    }),
    [size.w, size.h],
  );

  /** Stage-local point for a viewport one. */
  const toLocal = React.useCallback((p: Point): Point => {
    const r = hostRef.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left, y: p.y - r.top } : p;
  }, []);

  const inShelfZone = React.useCallback((viewport: Point): boolean => {
    const r = hostRef.current?.getBoundingClientRect();
    return Boolean(r && viewport.y > r.bottom - SHELF_ZONE_PX);
  }, []);

  const openPageAt = React.useCallback(
    (href: string, title: string, at: Point | null) => {
      setPageChips((chips) => chips.filter((c) => c.href !== href));
      const local = at
        ? clampPos({ x: toLocal(at).x - 120, y: toLocal(at).y - 20 }, 420)
        : null;
      if (local) placePanel("page", local);
      setPage({ href, title });
      setFront("page");
    },
    [clampPos, toLocal, placePanel],
  );

  /** Menu tiles land here; accepted only inside the stage. */
  const dropPage = React.useCallback(
    (href: string, title: string, viewport: Point): boolean => {
      const r = hostRef.current?.getBoundingClientRect();
      const inside =
        r &&
        viewport.x >= r.left &&
        viewport.x <= r.right &&
        viewport.y >= r.top &&
        viewport.y <= r.bottom;
      if (!inside) return false;
      openPageAt(href, title, viewport);
      return true;
    },
    [openPageAt],
  );

  const settle = React.useCallback(
    (which: "hero" | "page", viewport: Point, el: HTMLDivElement) => {
      // Shelf drop minimises the PAGE panel; the hero just settles in place.
      if (which === "page" && page && inShelfZone(viewport)) {
        setPageChips((chips) =>
          chips.some((c) => c.href === page.href) ? chips : [...chips, page],
        );
        setPage(null);
        return;
      }
      const host = el.offsetParent as HTMLElement | null;
      const hr = host?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const p = clampPos(
        { x: r.left - (hr?.left ?? 0), y: r.top - (hr?.top ?? 0) },
        r.width,
      );
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      placePanel(which, p);
    },
    [page, inShelfZone, clampPos, placePanel],
  );

  const settleHero = React.useCallback(
    (v: Point, el: HTMLDivElement) => settle("hero", v, el),
    [settle],
  );
  const settlePage = React.useCallback(
    (v: Point, el: HTMLDivElement) => settle("page", v, el),
    [settle],
  );
  const resizeHero = React.useCallback(
    (w: number, h: number) => placePanel("hero", { w, h }),
    [placePanel],
  );
  const resizePage = React.useCallback(
    (w: number, h: number) => placePanel("page", { w, h }),
    [placePanel],
  );
  const frontHero = React.useCallback(() => setFront("hero"), []);
  const frontPage = React.useCallback(() => setFront("page"), []);
  const crushHero = React.useCallback(() => {
    if (hero) onClose(hero.id);
  }, [hero, onClose]);
  const crushPage = React.useCallback(() => setPage(null), []);

  /** Tiles dropped onto the hero frame promote their artifact. */
  const settleTile = React.useCallback(
    (artifact: Artifact, viewport: Point, el: HTMLDivElement) => {
      const heroEl = el.offsetParent?.querySelector("[data-hand-hero]");
      const hr = heroEl?.getBoundingClientRect();
      if (
        hr &&
        viewport.x >= hr.left &&
        viewport.x <= hr.right &&
        viewport.y >= hr.top &&
        viewport.y <= hr.bottom
      ) {
        onPromote(artifact.id);
        return;
      }
      const host = el.offsetParent as HTMLElement | null;
      const hostR = host?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setTilePositions((prev) =>
        new Map(prev).set(artifact.id, {
          x: r.left - (hostR?.left ?? 0),
          y: r.top - (hostR?.top ?? 0),
        }),
      );
    },
    [onPromote],
  );

  const heroPos = clampPos(layout.hero ?? { x: 16, y: 8 }, ready ? heroW : 420);
  const pagePos = clampPos(
    layout.page ?? { x: Math.max(24, size.w - pageW - 24), y: 24 },
    ready ? pageW : 420,
  );
  const tilePos = (id: string, i: number): Point =>
    tilePositions.get(id) ??
    { x: Math.max(16, size.w - 260), y: heroH * 0.12 + i * 96 };

  const emptyStage = !hero && !page;

  return (
    <div className="flex min-h-0 flex-1">
      {menuOpen ? (
        <HandMenu onOpen={openPageAt} onDrop={dropPage} onCollapse={onToggleMenu} />
      ) : (
        <div className="flex w-9 shrink-0 flex-col items-center pt-2">
          <button
            type="button"
            onClick={onToggleMenu}
            title="Open the areas menu (or hold an open palm)"
            aria-label="Open the areas menu"
            className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--stage-border)] text-[var(--stage-dim)] transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </div>
      )}

      <div ref={hostRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {emptyStage ? (
          <div className="absolute inset-0">{empty}</div>
        ) : (
          <>
            {ready && hero && !heroAsTile && (
              <Floating
                dragId="panel:hero"
                pos={heroPos}
                width={heroW}
                height={heroH}
                z={front === "hero" ? 40 : 30}
                onGrab={frontHero}
                onDropped={settleHero}
                onCrush={crushHero}
                onResized={resizeHero}
              >
                <div data-hand-hero className="flex h-full">
                  <StagePanel
                    artifact={hero}
                    onClose={onClose}
                    onPrompt={onPrompt}
                    onNavigate={onNavigate}
                    reloadKey={reloadKeys[hero.id]}
                    className="flex-1 shadow-2xl shadow-black/40"
                  />
                </div>
              </Floating>
            )}

            <AnimatePresence>
              {ready && page && (
                <motion.div
                  key={page.href}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", duration: 0.35, bounce: 0.14 }}
                >
                  <Floating
                    dragId="panel:page"
                    pos={pagePos}
                    width={pageW}
                    height={pageH}
                    z={front === "page" ? 40 : 30}
                    onGrab={frontPage}
                    onDropped={settlePage}
                    onCrush={crushPage}
                    onResized={resizePage}
                  >
                    <StagePanel
                      artifact={pageArtifact({
                        id: `hand-page:${page.href}`,
                        href: page.href,
                        title: page.title,
                        subtitle: "Live page",
                      })}
                      onClose={crushPage}
                      onPrompt={onPrompt}
                      onNavigate={onNavigate}
                      className="h-full shadow-2xl shadow-black/40"
                    />
                  </Floating>
                </motion.div>
              )}
            </AnimatePresence>

            {ready &&
              tileArtifacts.map((artifact, i) => (
                <FloatTile
                  key={artifact.id}
                  artifact={artifact}
                  pos={tilePos(artifact.id, i)}
                  z={20}
                  onGrab={() => undefined}
                  onDropped={(v, el) => settleTile(artifact, v, el)}
                  onPromote={onPromote}
                  onCrush={() => onClose(artifact.id)}
                />
              ))}
          </>
        )}

        {/* The shelf — chips, and the drop zone that minimises a panel. */}
        {(shelf.length > 0 || pageChips.length > 0 || page) && (
          <div
            className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 overflow-x-auto px-4 pb-3 pt-4"
            style={{ height: SHELF_ZONE_PX }}
          >
            {pageChips.map((chip) => (
              <button
                key={chip.href}
                type="button"
                onClick={() => openPageAt(chip.href, chip.title, null)}
                title={chip.title}
                className={cn(
                  "inline-flex max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1",
                  "border-primary-400/40 bg-primary-400/10 text-[11px] text-[var(--stage-dim)]",
                  "transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
                )}
              >
                <span className="truncate">{chip.title}</span>
              </button>
            ))}
            {shelf.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onPromote(artifact.id)}
                title={artifact.title}
                className={cn(
                  "inline-flex max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1",
                  "border-[var(--stage-border)] bg-[var(--stage-panel)] text-[11px] text-[var(--stage-dim)]",
                  "transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
                )}
              >
                <ArtifactGlyph artifact={artifact} className="h-3 w-3 shrink-0" />
                <span className="truncate">{artifact.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
