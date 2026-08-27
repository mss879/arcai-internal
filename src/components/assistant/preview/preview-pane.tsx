"use client";

/**
 * The preview canvas — the right-hand column of Arc Studio.
 *
 * This is the answer to "I want to see the proposal while I'm still talking to
 * the agent". Every artifact Arc produces gets a tab here; the active one is
 * rendered full size while the conversation carries on beside it.
 *
 * Only the ACTIVE artifact is mounted. Keeping the others alive would mean a
 * pile of live iframes and PDF documents nobody is looking at; persistence
 * across tab switches comes from the PDF blob cache instead, which is far
 * cheaper than a mounted document.
 */

import * as React from "react";
import { Layers, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Artifact } from "@/lib/assistant-artifacts";
import { ArtifactToolbar } from "./artifact-toolbar";
import { ArtifactView, isBleedArtifact } from "./artifact-view";
import { artifactIcon } from "./artifact-format";

/** Below this pane width, secondary detail is dropped from every artifact. */
const DENSE_PX = 560;

const EMPTY_CHIPS = [
  "Show me my clients",
  "This month's numbers",
  "Draft a proposal",
];

export type PreviewPaneProps = {
  /** Oldest → newest, already de-duped by id. */
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAll: () => void;
  /** Send text back to Arc as if the user had typed it. */
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  /** Collapse the canvas entirely. */
  onCollapse: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  style?: React.CSSProperties;
  className?: string;
};

function PreviewPaneImpl({
  artifacts,
  activeId,
  onSelect,
  onCloseTab,
  onCloseAll,
  onPrompt,
  onNavigate,
  onCollapse,
  expanded,
  onToggleExpand,
  style,
  className,
}: PreviewPaneProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [dense, setDense] = React.useState(false);
  // Reload is per-tab so reloading one embedded page doesn't disturb another.
  const [reloadKeys, setReloadKeys] = React.useState<Record<string, number>>({});

  // Density is measured, not guessed from a breakpoint: the pane's width is
  // whatever the user dragged the divider to, which no breakpoint knows.
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setDense(width > 0 && width < DENSE_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const active =
    artifacts.find((a) => a.id === activeId) ??
    artifacts[artifacts.length - 1] ??
    null;

  const onTabKeyDown = React.useCallback(
    (event: React.KeyboardEvent, index: number) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next =
          (index + delta + artifacts.length) % Math.max(artifacts.length, 1);
        const target = artifacts[next];
        if (target) onSelect(target.id);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onCloseTab(artifacts[index].id);
      }
    },
    [artifacts, onCloseTab, onSelect],
  );

  const reload = React.useCallback((id: string) => {
    setReloadKeys((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="Preview"
      style={style}
      className={cn(
        "flex min-h-0 min-w-[360px] shrink-0 flex-col border-l border-slate-200/70 bg-slate-50/70",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300",
        className,
      )}
    >
      {artifacts.length > 0 && (
        <div
          role="tablist"
          aria-label="Open previews"
          className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200/70 bg-white/70 px-2 py-1.5"
        >
          {artifacts.map((artifact, index) => {
            const Icon = artifactIcon(artifact);
            const selected = active?.id === artifact.id;
            return (
              <div
                key={artifact.id}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(artifact.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(artifact.id);
                    return;
                  }
                  onTabKeyDown(e, index);
                }}
                className={cn(
                  "group inline-flex max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium text-slate-500 transition",
                  "hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
                  selected &&
                    "bg-white text-slate-900 shadow-[var(--shadow-soft)] ring-1 ring-slate-200",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{artifact.title}</span>
                <button
                  type="button"
                  aria-label={`Close ${artifact.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(artifact.id);
                  }}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-300 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          {artifacts.length > 1 && (
            <button
              type="button"
              onClick={onCloseAll}
              className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              Close all
            </button>
          )}
        </div>
      )}

      {active ? (
        <>
          <ArtifactToolbar
            artifact={active}
            dense={dense}
            onPrompt={onPrompt}
            onNavigate={onNavigate}
            onCollapse={onCollapse}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onReload={() => reload(active.id)}
          />
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto",
              isBleedArtifact(active) ? "p-0" : "p-4",
            )}
          >
            <ArtifactView
              artifact={active}
              dense={dense}
              active
              onNavigate={onNavigate}
              reloadKey={reloadKeys[active.id] ?? 0}
              onPrompt={onPrompt}
            />
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-50 text-primary-500">
            <Layers className="h-6 w-6" />
          </div>
          <p className="mt-4 text-base font-semibold text-slate-900">
            Nothing to preview yet
          </p>
          <p className="mt-1 max-w-xs text-sm text-slate-500">
            Ask Arcus for a proposal, an invoice, your client list or this
            month&apos;s numbers — it&apos;ll open right here.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {EMPTY_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => onPrompt(chip)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-600 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The preview canvas. Memoised because the workspace re-renders on every
 * microphone level tick (~60×/s) and none of that concerns the canvas.
 */
export const PreviewPane = React.memo(PreviewPaneImpl);
PreviewPane.displayName = "PreviewPane";
