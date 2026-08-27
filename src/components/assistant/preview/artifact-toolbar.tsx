"use client";

/**
 * Everything you can DO to the artifact on screen, in one strip.
 *
 * Concentrating the affordances here keeps the eight body components pure
 * renderers — none of them owns a download, a clipboard write or a router
 * push. It also means a new action (the server sends `artifact.actions`) shows
 * up consistently, in the same place, whatever the artifact happens to be.
 */

import * as React from "react";
import {
  Copy,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Artifact, ArtifactAction } from "@/lib/assistant-artifacts";
import { downloadProposalPdf } from "@/app/(app)/proposals/download-pdf";
import {
  actionIcon,
  artifactArea,
  artifactIcon,
  AREA_META,
  fileStem,
  tableToCsv,
  tableToTsv,
} from "./artifact-format";
import { pdfRequest } from "./pdf-artifact";

/**
 * Hand the browser a blob as a file.
 *
 * The URL is revoked on a later task, never in the same tick as the click:
 * Firefox and Safari read the href asynchronously, and revoking synchronously
 * cancels the download before it starts (the button silently does nothing).
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type ArtifactToolbarProps = {
  artifact: Artifact;
  /** True when the pane is narrow: buttons lose their labels. */
  dense: boolean;
  /** Send text back to Arc as if the user had typed it. */
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  /** Collapse the canvas entirely. */
  onCollapse: () => void;
  /** Canvas is currently taking the whole panel. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Force a fresh load of a `page` artifact. */
  onReload: () => void;
};

/**
 * The header row above an artifact: what it is on the left, what you can do
 * with it on the right.
 */
export function ArtifactToolbar({
  artifact,
  dense,
  onPrompt,
  onNavigate,
  onCollapse,
  expanded,
  onToggleExpand,
  onReload,
}: ArtifactToolbarProps): React.ReactElement {
  const [saving, setSaving] = React.useState(false);
  const area = AREA_META[artifactArea(artifact)];
  const subtitle = artifact.summary ?? artifact.subtitle ?? area.label;

  const copyTable = React.useCallback(async () => {
    if (artifact.kind !== "table") return;
    try {
      await navigator.clipboard.writeText(tableToTsv(artifact));
      toast.success("Copied — paste it straight into a spreadsheet.");
    } catch {
      toast.error("Couldn't copy that.");
    }
  }, [artifact]);

  const downloadCsv = React.useCallback(() => {
    if (artifact.kind !== "table") return;
    const blob = new Blob([tableToCsv(artifact)], {
      type: "text/csv;charset=utf-8",
    });
    saveBlob(blob, `${fileStem(artifact.title, "table")}.csv`);
  }, [artifact]);

  const downloadPdf = React.useCallback(async () => {
    if (artifact.kind !== "invoice" && artifact.kind !== "proposal") return;
    setSaving(true);
    try {
      if (artifact.kind === "proposal") {
        const p = artifact.proposal;
        await downloadProposalPdf({
          client_name: p.client_name,
          project_name: p.project_name,
          proposal_date: p.proposal_date,
          selection: p.selection,
          content: p.content,
        });
      } else {
        const request = pdfRequest(artifact);
        const res = await fetch(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.payload),
        });
        if (!res.ok) throw new Error("Couldn't generate the PDF.");
        saveBlob(await res.blob(), request.filename);
      }
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't generate the PDF.",
      );
    } finally {
      setSaving(false);
    }
  }, [artifact]);

  const runAction = React.useCallback(
    (action: ArtifactAction) => {
      if (action.prompt) onPrompt(action.prompt);
      else if (action.href) onNavigate(action.href);
    },
    [onNavigate, onPrompt],
  );

  // Icon-only below 560px, so the strip never wraps into two rows.
  const showLabels = !dense;

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-slate-200/70 bg-white/60 px-4 py-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-600">
        {/* createElement, not `const Icon = …`: a capitalised binding assigned
            from a call in a component body reads to the linter as a component
            defined during render, which remounts on every keystroke. */}
        {React.createElement(artifactIcon(artifact), {
          className: "h-4.5 w-4.5",
          "aria-hidden": true,
        })}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">
          {artifact.title}
        </p>
        <p className="truncate text-[11px] text-slate-500">{subtitle}</p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {artifact.kind === "table" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={copyTable}
              aria-label="Copy this table"
            >
              <Copy className="h-3.5 w-3.5" />
              {showLabels && <span>Copy</span>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={downloadCsv}
              aria-label="Download this table as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              {showLabels && <span>CSV</span>}
            </Button>
          </>
        )}

        {artifact.kind === "text" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPrompt(`Revise this: ${artifact.title}`)}
            aria-label="Ask Arcus to revise this"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {showLabels && <span>Revise</span>}
          </Button>
        )}

        {artifact.kind === "page" && (
          <Button
            size="sm"
            variant="outline"
            onClick={onReload}
            aria-label="Reload this page"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {showLabels && <span>Reload</span>}
          </Button>
        )}

        {(artifact.kind === "invoice" || artifact.kind === "proposal") && (
          <Button
            size="sm"
            variant="outline"
            loading={saving}
            onClick={downloadPdf}
            aria-label="Download this PDF"
          >
            <Download className="h-3.5 w-3.5" />
            {showLabels && <span>Download PDF</span>}
          </Button>
        )}

        {(artifact.actions ?? []).map((action, i) => {
          const ActionIcon = actionIcon(action.icon);
          return (
            <Button
              key={`${action.label}-${i}`}
              size="sm"
              variant={action.tone === "danger" ? "danger" : "outline"}
              onClick={() => runAction(action)}
            >
              <ActionIcon className="h-3.5 w-3.5" />
              {showLabels && <span>{action.label}</span>}
            </Button>
          );
        })}

        {artifact.href && artifact.kind !== "page" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate(artifact.href as string)}
            aria-label={`Open ${artifact.title} in the app`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {showLabels && <span>Open</span>}
          </Button>
        )}

        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? "Shrink the preview" : "Expand the preview"}
          aria-pressed={expanded}
          className={cn(
            "grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition",
            "hover:bg-slate-100 hover:text-slate-900",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
          )}
        >
          {expanded ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide the preview panel"
          className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
