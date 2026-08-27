"use client";

/**
 * The stage: where results go.
 *
 * The arrangement is one hero panel, a rack of at most two recent artifacts
 * beside it, and a shelf of chips for everything older. That shape exists to
 * protect a guarantee the preview canvas has always made and this surface must
 * not quietly break: **exactly one artifact is ever mounted**. The rack tiles
 * are metadata — a title, an icon, a summary line — not live `ArtifactView`s,
 * so a stage showing three things costs the same as a canvas showing one. A
 * PDF or an embedded page takes the whole stage alone, because an iframe
 * beside a second iframe is where the frame budget actually goes.
 *
 * Memoised, and `level` is deliberately not among its props.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { StagePanel } from "@/components/assistant/command/stage-panel";
import { ArtifactGlyph } from "@/components/assistant/command/artifact-glyph";
import { isBleedArtifact } from "@/components/assistant/preview/artifact-view";
import { useReducedMotionSafe } from "@/components/assistant/studio-store";
import type { Artifact } from "@/lib/assistant-artifacts";
import { cn } from "@/lib/utils";

/** How many artifacts sit in the rack beside the hero. */
const RACK_MAX = 2;

function RackTile({
  artifact,
  onPromote,
}: {
  artifact: Artifact;
  onPromote: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPromote(artifact.id)}
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
        <span className="hud-mono ml-auto shrink-0 text-[8px] uppercase tracking-[0.2em] text-[var(--stage-faint)]/70">
          {artifact.kind}
        </span>
      </span>
      {(artifact.summary || artifact.subtitle) && (
        <span className="line-clamp-3 text-[11px] leading-relaxed text-[var(--stage-faint)]">
          {artifact.summary || artifact.subtitle}
        </span>
      )}
    </button>
  );
}

function CommandStageImpl({
  artifacts,
  heroId,
  onPromote,
  onClose,
  onPrompt,
  onNavigate,
  reloadKeys,
  expanded,
  onToggleExpand,
  empty,
}: {
  /** Open artifacts, oldest first. */
  artifacts: Artifact[];
  heroId: string | null;
  onPromote: (id: string) => void;
  onClose: (id: string) => void;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  reloadKeys: Record<string, number>;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Shown when there is nothing to display — the ambient stage. */
  empty: React.ReactNode;
}) {
  const reduced = useReducedMotionSafe();

  const hero =
    artifacts.find((a) => a.id === heroId) ?? artifacts[artifacts.length - 1] ?? null;

  // A document takes the room to itself. Beyond the frame cost, a PDF squeezed
  // into 70% of a stage beside two tiles is unreadable anyway.
  const solo = hero ? isBleedArtifact(hero) || expanded : false;

  const rest = hero ? artifacts.filter((a) => a.id !== hero.id) : [];
  const rack = solo ? [] : rest.slice(-RACK_MAX).reverse();
  const shelf = solo ? rest : rest.slice(0, Math.max(0, rest.length - RACK_MAX));

  if (!hero) {
    return <div className="min-h-0 flex-1 overflow-hidden">{empty}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3">
      <div className="flex min-h-0 flex-1 gap-3">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={hero.id}
            layout={!reduced}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
            transition={
              reduced
                ? { duration: 0.12 }
                : { type: "spring", duration: 0.4, bounce: 0.12 }
            }
            className="flex min-h-0 min-w-0 flex-1"
          >
            <StagePanel
              artifact={hero}
              onClose={onClose}
              onPrompt={onPrompt}
              onNavigate={onNavigate}
              onToggleExpand={onToggleExpand}
              expanded={expanded}
              reloadKey={reloadKeys[hero.id]}
              className="flex-1"
            />
          </motion.div>
        </AnimatePresence>

        {rack.length > 0 && (
          <div className="hidden w-[248px] shrink-0 flex-col gap-2 overflow-y-auto xl:flex">
            <AnimatePresence initial={false}>
              {rack.map((artifact) => (
                <motion.div
                  key={artifact.id}
                  layout={!reduced}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, x: 18 }}
                  transition={{ duration: 0.22 }}
                >
                  <RackTile artifact={artifact} onPromote={onPromote} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {(shelf.length > 0 || rack.length > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* Below xl the rack column is hidden — its artifacts appear here
              instead of silently disappearing. */}
          {rack.map((artifact) => (
            <button
              key={`sm-${artifact.id}`}
              type="button"
              onClick={() => onPromote(artifact.id)}
              title={artifact.title}
              className={cn(
                "inline-flex max-w-[190px] items-center gap-1.5 rounded-full border px-2.5 py-1 xl:hidden",
                "border-[var(--stage-border)] bg-[var(--stage-panel)] text-[11px] text-[var(--stage-dim)]",
                "transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
              )}
            >
              <ArtifactGlyph artifact={artifact} className="h-3 w-3 shrink-0" />
              <span className="truncate">{artifact.title}</span>
            </button>
          ))}
          {shelf.map((artifact) => {
            return (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onPromote(artifact.id)}
                title={artifact.title}
                className={cn(
                  "inline-flex max-w-[190px] items-center gap-1.5 rounded-full border px-2.5 py-1",
                  "border-[var(--stage-border)] bg-[var(--stage-panel)] text-[11px] text-[var(--stage-dim)]",
                  "transition-colors hover:bg-[var(--stage-panel-hover)] hover:text-[var(--stage-text)]",
                )}
              >
                <ArtifactGlyph artifact={artifact} className="h-3 w-3 shrink-0" />
                <span className="truncate">{artifact.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const CommandStage = React.memo(CommandStageImpl);
