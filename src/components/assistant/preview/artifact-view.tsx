"use client";

/**
 * The one place that turns an `Artifact` into pixels.
 *
 * Everything else in the canvas — the tab strip, the toolbar, the resize
 * handle — is chrome; this is the switch. It carries no layout of its own so
 * the pane owns padding and scrolling, and it ends in a `never` guard: add a
 * new artifact kind on the server and this file stops compiling until it has
 * somewhere to render, which is exactly the failure we want.
 */

import * as React from "react";

import type { Artifact } from "@/lib/assistant-artifacts";
import { BriefingArtifact } from "./briefing-artifact";
import { ChartArtifact } from "./chart-artifact";
import { MetricsArtifact } from "./metrics-artifact";
import { PageArtifact } from "./page-artifact";
import { PdfArtifact } from "./pdf-artifact";
import { RecordArtifact } from "./record-artifact";
import { TableArtifact } from "./table-artifact";
import { TextArtifact } from "./text-artifact";
import { ScanArtifact } from "./scan-artifact";
import { TimelineArtifact } from "./timeline-artifact";

export type ArtifactViewProps = {
  artifact: Artifact;
  /** True when the pane is narrow (< 560px): secondary detail is dropped. */
  dense: boolean;
  /** False while the tab is not selected — gates iframe and PDF work. */
  active: boolean;
  /** Open an in-app route; the workspace pushes it and steps down to dock. */
  onNavigate: (href: string) => void;
  /** Bumped by the toolbar's Reload button (page artifacts only). */
  reloadKey?: number;
  /** Send text back as if the user typed it (briefing priority chips). */
  onPrompt?: (text: string) => void;
  /**
   * Render for the dark command stage (0104).
   *
   * Only the kinds that carry the most traffic honour this — table, metrics
   * and chart. Everything else ignores it and is placed on a white island by
   * `StagePanel` instead, because a half-restyled component reads as a bug
   * while a document on a dark desk reads as a document.
   */
  stage?: boolean;
};

/**
 * Render one artifact. Which body appears is decided purely by
 * `artifact.kind`; each branch narrows the union for its component.
 */
export function ArtifactView({
  artifact,
  dense,
  active,
  onNavigate,
  reloadKey,
  onPrompt,
  stage,
}: ArtifactViewProps): React.ReactElement | null {
  switch (artifact.kind) {
    case "table":
      return (
        <TableArtifact
          artifact={artifact}
          dense={dense}
          onNavigate={onNavigate}
          stage={stage}
        />
      );
    case "record":
      return (
        <RecordArtifact artifact={artifact} dense={dense} onNavigate={onNavigate} />
      );
    case "metrics":
      return (
        <MetricsArtifact
          artifact={artifact}
          dense={dense}
          onNavigate={onNavigate}
          stage={stage}
        />
      );
    case "chart":
      return <ChartArtifact artifact={artifact} dense={dense} stage={stage} />;
    case "timeline":
      return (
        <TimelineArtifact
          artifact={artifact}
          dense={dense}
          onNavigate={onNavigate}
        />
      );
    case "text":
      return <TextArtifact artifact={artifact} dense={dense} />;
    case "briefing":
      return (
        <BriefingArtifact
          artifact={artifact}
          dense={dense}
          onPrompt={onPrompt}
          onNavigate={onNavigate}
        />
      );
    case "scan":
      return (
        <ScanArtifact
          artifact={artifact}
          active={active}
          stage={stage}
          onPrompt={onPrompt}
          onNavigate={onNavigate}
        />
      );
    case "page":
      return (
        <PageArtifact artifact={artifact} active={active} reloadKey={reloadKey} />
      );
    case "invoice":
    case "proposal":
      return <PdfArtifact artifact={artifact} active={active} />;
    default: {
      // Exhaustiveness guard — see the file header.
      const _exhaustive: never = artifact;
      return _exhaustive;
    }
  }
}

/**
 * Kinds that fill their own container edge-to-edge (a PDF page, an embedded
 * route). The pane drops its padding for these so the document isn't framed
 * in a stripe of grey.
 */
export function isBleedArtifact(artifact: Artifact): boolean {
  return (
    artifact.kind === "page" ||
    artifact.kind === "invoice" ||
    artifact.kind === "proposal" ||
    // The scan panel manages its own padding and wants the full width for
    // the candidate list (and, later, the map).
    artifact.kind === "scan"
  );
}
