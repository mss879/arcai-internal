"use client";

/**
 * The `record` artifact — one entity in full: a client, a project, an invoice
 * row, a meeting. It is the "pull in any information" half of the user's
 * request: ask about Silva and the whole record appears beside the
 * conversation instead of being read out three fields at a time.
 *
 * A definition list, not a table: fields are label/value pairs, so `<dl>` is
 * the honest markup and screen readers announce the pairing for free.
 *
 * Presentational only: data in via props, intent out via `onNavigate`.
 */

import * as React from "react";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ArtifactField } from "@/lib/assistant-artifacts";
import {
  cellLinkHref,
  deltaTone,
  formatCell,
  formatDelta,
  TONE_PILL,
  type ArtifactOf,
} from "./artifact-format";

function FieldRow({
  field,
  dense,
  onNavigate,
}: {
  field: ArtifactField;
  dense: boolean;
  onNavigate: (href: string) => void;
}): React.ReactElement {
  const text = formatCell(field.value, field.format);
  const mailto = cellLinkHref(field.value, field.format);
  const href = field.href;
  const delta = field.delta;
  const tone = field.tone ?? (delta != null ? deltaTone(delta) : undefined);
  const DeltaIcon = delta != null && delta > 0 ? ArrowUp : ArrowDown;

  return (
    <>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {field.label}
      </dt>
      <dd
        className={cn(
          "flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-slate-800",
          dense && "mb-1",
        )}
      >
        {href ? (
          <button
            type="button"
            onClick={() => onNavigate(href)}
            className="inline-flex items-center gap-1 rounded text-left text-primary-600 underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <span
              className={cn(field.format === "multiline" && "whitespace-pre-wrap")}
            >
              {text}
            </span>
            <ExternalLink aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
          </button>
        ) : mailto ? (
          <a
            href={mailto}
            className="text-primary-600 underline-offset-2 hover:underline"
            {...(field.format === "url"
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {text}
          </a>
        ) : field.format === "status" ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
              TONE_PILL[tone ?? "neutral"],
            )}
          >
            {text}
          </span>
        ) : (
          <span
            className={cn(
              field.format === "multiline" && "whitespace-pre-wrap",
              field.format === "money" && "font-medium tabular-nums",
            )}
          >
            {text}
          </span>
        )}

        {delta != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
              TONE_PILL[tone ?? deltaTone(delta)],
            )}
          >
            {/* No arrow at all when nothing changed — a coloured arrow next to
                "0%" reads as movement that did not happen. */}
            {delta !== 0 && <DeltaIcon aria-hidden className="h-2.5 w-2.5" />}
            {formatDelta(delta)}
          </span>
        )}
      </dd>
    </>
  );
}

function FieldGrid({
  fields,
  dense,
  onNavigate,
}: {
  fields: ArtifactField[];
  dense: boolean;
  onNavigate: (href: string) => void;
}): React.ReactElement {
  return (
    <dl
      className={cn(
        "gap-x-4 gap-y-2.5",
        dense ? "grid grid-cols-1" : "grid grid-cols-[minmax(0,150px)_1fr]",
      )}
    >
      {fields.map((field, i) => (
        <FieldRow
          key={`${field.label}-${i}`}
          field={field}
          dense={dense}
          onNavigate={onNavigate}
        />
      ))}
    </dl>
  );
}

export type RecordArtifactProps = {
  artifact: ArtifactOf<"record">;
  /** True when the pane is narrow: the grid collapses to a single column. */
  dense: boolean;
  onNavigate: (href: string) => void;
};

/** Render a `record` artifact: fields, grouped sections and a prose body. */
export function RecordArtifact({
  artifact,
  dense,
  onNavigate,
}: RecordArtifactProps): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      {artifact.fields.length > 0 && (
        <FieldGrid
          fields={artifact.fields}
          dense={dense}
          onNavigate={onNavigate}
        />
      )}

      {artifact.groups?.map((group, i) => (
        <section key={`${group.label}-${i}`} className="mt-5 border-t border-slate-100 pt-4">
          <h3 className="mb-2.5 text-xs font-semibold text-slate-900">
            {group.label}
          </h3>
          <FieldGrid
            fields={group.fields}
            dense={dense}
            onNavigate={onNavigate}
          />
        </section>
      ))}

      {artifact.body ? (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600">
            {artifact.body}
          </p>
        </div>
      ) : null}

      {artifact.fields.length === 0 &&
      !artifact.groups?.length &&
      !artifact.body ? (
        <p className="py-10 text-center text-[13px] text-slate-400">
          This record came back empty.
        </p>
      ) : null}
    </div>
  );
}
