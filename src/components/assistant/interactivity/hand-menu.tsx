"use client";

/**
 * The edge menu — the app's areas as hand-sized targets.
 *
 * Rendered down the stage's left edge while hands are on: every nav area as
 * a tile big enough to pinch without aiming (the reason it exists at all —
 * the sidebar's 36px rows are mouse furniture). Two gestures per tile:
 *
 *  - a quick pinch (or a mouse click) opens the page as a live panel at its
 *    remembered spot;
 *  - pinch-DRAG a tile onto the stage and the page opens exactly where it
 *    was dropped — the Iron Man gesture the whole mode is named for.
 *
 * The drag ghost is a real element moved by style writes, so dragging a
 * tile costs no renders. Admin-only areas are excluded: the workspace
 * doesn't know the viewer's role, and a menu that 404s for members is
 * worse than a shorter menu.
 */

import * as React from "react";

import { PanelLeftClose } from "lucide-react";

import { useDragRegistry } from "@/components/assistant/interactivity/hand-interaction-layer";
import { NAV, type NavItem } from "@/components/layout/nav";
import { cn } from "@/lib/utils";

const ITEMS: NavItem[] = NAV.filter((item) => !item.adminOnly);

function MenuTile({
  item,
  onOpen,
  onDrop,
}: {
  item: NavItem;
  onOpen: (href: string, title: string, at: null) => void;
  onDrop: (href: string, title: string, at: { x: number; y: number }) => boolean;
}) {
  const registry = useDragRegistry();
  const ghostRef = React.useRef<HTMLDivElement | null>(null);
  const start = React.useRef({ x: 0, y: 0 });
  const draggedRef = React.useRef(false);
  const dragId = `menu:${item.href}`;

  // Registered fresh whenever the callbacks change — registration is a Map
  // write, so re-running this effect is cheaper than the ref-mirror dance.
  React.useEffect(() => {
    return registry.register(dragId, {
      onStart: (x, y) => {
        start.current = { x, y };
        draggedRef.current = false;
      },
      onMove: (x, y) => {
        const ghost = ghostRef.current;
        if (!ghost) return;
        // The ghost appears only once the pinch has clearly travelled —
        // otherwise every plain click flashes one.
        if (
          !draggedRef.current &&
          Math.hypot(x - start.current.x, y - start.current.y) > 8
        ) {
          draggedRef.current = true;
          ghost.style.opacity = "1";
        }
        ghost.style.transform = `translate3d(${x - 52}px, ${y - 20}px, 0)`;
      },
      onEnd: (x, y) => {
        const ghost = ghostRef.current;
        if (ghost) ghost.style.opacity = "0";
        if (draggedRef.current) onDrop(item.href, item.label, { x, y });
      },
    });
  }, [registry, dragId, item.href, item.label, onDrop]);

  const Icon = item.icon;

  return (
    <>
      <button
        type="button"
        data-hand-drag={dragId}
        onPointerDown={(e) => registry.beginFromPointer(dragId, e)}
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          onOpen(item.href, item.label, null);
        }}
        title={`${item.label} — pinch to open, pinch-drag onto the stage`}
        className={cn(
          "hud-panel hud-panel--tight flex w-full cursor-grab flex-col items-center gap-1 px-1 py-2.5 text-center",
          "transition-colors hover:bg-[var(--stage-panel-hover)] active:cursor-grabbing",
        )}
      >
        <Icon className="h-5 w-5 text-[var(--stage-accent)]" />
        <span className="w-full truncate px-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--stage-dim)]">
          {item.label}
        </span>
      </button>

      {/* The drag ghost — fixed, style-driven, invisible until a real drag. */}
      <div
        ref={ghostRef}
        aria-hidden
        className="hud-panel hud-panel--tight pointer-events-none fixed left-0 top-0 z-[110] flex w-[104px] flex-col items-center gap-1 px-1 py-2 opacity-0"
      >
        <Icon className="h-5 w-5 text-[var(--stage-accent)]" />
        <span className="w-full truncate text-center text-[9px] font-medium uppercase tracking-wide text-[var(--stage-dim)]">
          {item.label}
        </span>
      </div>
    </>
  );
}

export function HandMenu({
  onOpen,
  onDrop,
  onCollapse,
}: {
  onOpen: (href: string, title: string, at: null) => void;
  onDrop: (href: string, title: string, at: { x: number; y: number }) => boolean;
  /** Tuck the menu away — also reachable by holding an open palm. */
  onCollapse?: () => void;
}) {
  return (
    <div className="flex w-[104px] shrink-0 flex-col gap-1.5 overflow-y-auto py-2 pl-1 pr-1.5">
      <div className="flex items-center justify-between px-1 pb-0.5">
        <p className="hud-title">Areas</p>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide the menu (or hold an open palm)"
            aria-label="Hide the areas menu"
            className="grid h-6 w-6 place-items-center rounded text-[var(--stage-faint)] transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {ITEMS.map((item) => (
        <MenuTile key={item.href} item={item} onOpen={onOpen} onDrop={onDrop} />
      ))}
    </div>
  );
}
