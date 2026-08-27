"use client";

/**
 * The frame an artifact wears on the stage.
 *
 * The artifact renderers themselves are shared with the classic canvas, where
 * the surface is white. Rather than fork every component, the ones that carry
 * the most traffic — table, metrics, chart and the live scan — take a `stage`
 * prop and paint themselves dark. Everything else (a PDF, an embedded page, a
 * briefing) renders on a deliberate white island inside this frame: a document
 * on a desk, which is honest, rather than a half-restyled component with grey
 * text on grey, which is broken.
 *
 * `isBleedArtifact` decides padding. It is one of the two places a new artifact
 * kind can slip through without the compiler noticing, so it is called here
 * rather than reimplemented.
 */

import * as React from "react";
import { Maximize2, Minimize2, X } from "lucide-react";

import { ArtifactView, isBleedArtifact } from "@/components/assistant/preview/artifact-view";
import { actionIcon } from "@/components/assistant/preview/artifact-format";
import { ArtifactGlyph } from "@/components/assistant/command/artifact-glyph";
import type { Artifact } from "@/lib/assistant-artifacts";
import { cn } from "@/lib/utils";

/**
 * Kinds that paint themselves dark when handed `stage`. Everything absent
 * from this set gets the white island below, which is why adding a kind here
 * without giving it a dark pass is the one way to make a panel look broken.
 */
const STAGE_NATIVE = new Set<Artifact["kind"]>([
  "table",
  "metrics",
  "chart",
  "scan",
]);

export function StagePanel({
  artifact,
  onClose,
  onPrompt,
  onNavigate,
  onToggleExpand,
  expanded,
  reloadKey,
  className,
}: {
  artifact: Artifact;
  onClose: (id: string) => void;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  onToggleExpand?: () => void;
  expanded?: boolean;
  reloadKey?: number;
  className?: string;
}) {
  const native = STAGE_NATIVE.has(artifact.kind);
  const bleed = isBleedArtifact(artifact);

  return (
    <section
      className={cn(
        "hud-panel hud-ticks relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--stage-border)] px-3">
        <ArtifactGlyph
          artifact={artifact}
          className="h-4 w-4 shrink-0 text-[var(--stage-accent)]"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[var(--stage-text)]">
            {artifact.title}
          </p>
          {artifact.subtitle && (
            <p className="hud-mono truncate text-[10px] uppercase tracking-[0.16em] text-[var(--stage-faint)]">
              {artifact.subtitle}
            </p>
          )}
        </div>
        <span className="hud-mono hidden shrink-0 text-[9px] uppercase tracking-[0.24em] text-[var(--stage-faint)]/70 md:block">
          {artifact.kind}
        </span>

        {onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={expanded ? "Shrink this panel" : "Fill the stage"}
            className="grid h-7 w-7 place-items-center rounded-lg text-[var(--stage-dim)] transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]"
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onClose(artifact.id)}
          aria-label="Close this panel"
          className="grid h-7 w-7 place-items-center rounded-lg text-[var(--stage-dim)] transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          !bleed && (native ? "p-4" : "p-3"),
        )}
      >
        {native || bleed ? (
          <ArtifactView
            artifact={artifact}
            active
            stage
            dense={false}
            onNavigate={onNavigate}
            onPrompt={onPrompt}
            reloadKey={reloadKey}
          />
        ) : (
          // The white island. Deliberate, not a fallback: these kinds are
          // documents, and a document is white.
          <div className="rounded-xl bg-white p-3 text-slate-900 shadow-lg">
            <ArtifactView
              artifact={artifact}
              active
              dense={false}
              onNavigate={onNavigate}
              onPrompt={onPrompt}
              reloadKey={reloadKey}
            />
          </div>
        )}
      </div>

      {/* Server-supplied actions. `prompt` sends text back to Arcus as though
          the user typed it — the mechanism the scan panel uses to offer
          "Import the qualified leads" without inventing a new channel. */}
      {artifact.actions?.length ? (
        <footer className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--stage-border)] px-3 py-2.5">
          {artifact.actions.map((action, i) => {
            const ActionIcon = actionIcon(action.icon);
            return (
              <button
                key={`${action.label}-${i}`}
                type="button"
                onClick={() => {
                  if (action.prompt) onPrompt(action.prompt);
                  else if (action.href) onNavigate(action.href);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--stage-border-strong)] bg-[var(--stage-panel)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--stage-text)] transition-colors hover:bg-[var(--stage-panel-hover)]"
              >
                <ActionIcon className="h-3.5 w-3.5 text-[var(--stage-accent)]" />
                {action.label}
              </button>
            );
          })}
        </footer>
      ) : null}
    </section>
  );
}
