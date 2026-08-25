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
import { ChartArtifact } from "./chart-artifact";
import { MetricsArtifact } from "./metrics-artifact";
import { PageArtifact } from "./page-artifact";
import { PdfArtifact } from "./pdf-artifact";
import { RecordArtifact } from "./record-artifact";
import { TableArtifact } from "./table-artifact";
import { TextArtifact } from "./text-artifact";
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
}: ArtifactViewProps): React.ReactElement | null {
  switch (artifact.kind) {
    case "table":
      return (
        <TableArtifact artifact={artifact} dense={dense} onNavigate={onNavigate} />
      );
    case "record":
      return (
        <RecordArtifact artifact={artifact} dense={dense} onNavigate={onNavigate} />
      );
    case "metrics":
      return (
        <MetricsArtifact artifact={artifact} dense={dense} onNavigate={onNavigate} />
      );
    case "chart":
      return <ChartArtifact artifact={artifact} dense={dense} />;
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
    artifact.kind === "proposal"
  );
}
