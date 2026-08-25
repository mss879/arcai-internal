"use client";

/**
 * The `table` artifact — every list Arc looked up (clients, invoices, overdue
 * payments, a project's tasks) rendered as a real, working table in the
 * preview canvas.
 *
 * Why it does more than print rows: the canvas is where the user *checks* the
 * answer, so the table has to survive being interrogated. Hence a client-side
 * filter and click-to-sort (no round trip — the rows are already here), rows
 * that open the real record in the app, and a sticky header/total so the
 * numbers stay on screen while scrolling a long list.
 *
 * Presentational only: data in via props, intent out via `onNavigate`.
 */

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ArtifactCell, ArtifactColumn } from "@/lib/assistant-artifacts";
import {
  cellLinkHref,
  formatCell,
  TONE_PILL,
  type ArtifactOf,
} from "./artifact-format";

type SortState = { key: string; dir: "asc" | "desc" } | null;

/**
 * Compare two cells for sorting. Numbers (and numeric strings such as an
 * amount the server already stringified) sort numerically; everything else
 * sorts as text. Blanks always sink to the bottom regardless of direction —
 * an empty cell is not "the smallest value", it is missing information.
 */
function compareCells(a: ArtifactCell, b: ArtifactCell): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof a === "boolean" || typeof b === "boolean") {
    return Number(a) - Number(b);
  }

  const an = typeof a === "number" ? a : Number(String(a).replace(/[,\s]/g, ""));
  const bn = typeof b === "number" ? b : Number(String(b).replace(/[,\s]/g, ""));
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  if (Number.isFinite(an) && Number.isFinite(bn)) return 0;

  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

function alignClass(column: ArtifactColumn): string {
  if (column.align === "right") return "text-right tabular-nums";
  if (column.align === "center") return "text-center";
  return "text-left";
}

export type TableArtifactProps = {
  artifact: ArtifactOf<"table">;
  /** True when the pane is narrow: secondary columns are dropped. */
  dense: boolean;
  /** Open an in-app route (the workspace pushes it and steps down to dock). */
  onNavigate: (href: string) => void;
};

/**
 * Render a `table` artifact: filterable, sortable, click-through rows, sticky
 * header and totals.
 */
export function TableArtifact({
  artifact,
  dense,
  onNavigate,
}: TableArtifactProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(null);

  // A new artifact in the same tab (e.g. "now only the overdue ones") must not
  // inherit the previous one's filter — that would silently hide rows.
  React.useEffect(() => {
    setQuery("");
    setSort(null);
  }, [artifact.id]);

  const columns = React.useMemo(
    () => (dense ? artifact.columns.filter((c) => !c.secondary) : artifact.columns),
    [artifact.columns, dense],
  );

  const statusKey = React.useMemo(
    () => artifact.columns.find((c) => c.format === "status")?.key ?? null,
    [artifact.columns],
  );

  const rows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    let out = artifact.rows;

    if (needle) {
      out = out.filter((row) =>
        artifact.columns.some((column) =>
          formatCell(row.cells[column.key] ?? null, column.format)
            .toLowerCase()
            .includes(needle),
        ),
      );
    }

    if (sort) {
      const { key, dir } = sort;
      // Copy first: `artifact.rows` is props and must never be sorted in place.
      out = [...out].sort((a, b) => {
        const result = compareCells(a.cells[key] ?? null, b.cells[key] ?? null);
        return dir === "asc" ? result : -result;
      });
    }

    return out;
  }, [artifact.columns, artifact.rows, query, sort]);

  const toggleSort = React.useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);

  const filtering = query.trim().length > 0;
  const showFilter = artifact.rows.length > 6;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showFilter && (
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200/70 px-4 py-2.5">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${artifact.rows.length} rows`}
              aria-label={`Filter ${artifact.title}`}
              className="h-8 w-full rounded-xl border border-slate-200 bg-white pl-8 pr-2.5 text-[13px] text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-primary-300 focus:ring-4 focus:ring-primary-100"
            />
          </div>
          {filtering && (
            <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
              {rows.length} / {artifact.rows.length}
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            {artifact.title}
            {artifact.summary ? ` — ${artifact.summary}` : ""}
          </caption>
          <thead>
            <tr className="sticky top-0 z-10 bg-white/95 backdrop-blur">
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const SortIcon = !active
                  ? ChevronsUpDown
                  : sort?.dir === "asc"
                    ? ArrowUp
                    : ArrowDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active
                        ? sort?.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={cn(
                      "border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400",
                      alignClass(column),
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      aria-label={`Sort by ${column.label}`}
                      className={cn(
                        "group inline-flex max-w-full items-center gap-1 rounded transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
                        active && "text-primary-600",
                        column.align === "right" && "flex-row-reverse",
                      )}
                    >
                      <span className="truncate">{column.label}</span>
                      <SortIcon
                        aria-hidden
                        className={cn(
                          "h-3 w-3 shrink-0 transition-opacity",
                          active
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60",
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(columns.length, 1)}
                  className="px-3 py-10 text-center text-[13px] text-slate-400"
                >
                  {filtering
                    ? `Nothing matches “${query.trim()}”.`
                    : "This list came back empty."}
                </td>
              </tr>
            )}

            {rows.map((row, index) => {
              const href = row.href;
              const key = row.id ?? String(index);
              return (
                <tr
                  key={key}
                  {...(href
                    ? {
                        role: "link",
                        tabIndex: 0,
                        onClick: () => onNavigate(href),
                        onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          // Space scrolls the pane if we let it through.
                          e.preventDefault();
                          onNavigate(href);
                        },
                      }
                    : {})}
                  className={cn(
                    "border-b border-slate-100 text-[13px] text-slate-700 transition",
                    index % 2 === 1 && "bg-slate-50/50",
                    href &&
                      "cursor-pointer hover:bg-primary-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300",
                  )}
                >
                  {columns.map((column) => {
                    const value = row.cells[column.key] ?? null;
                    const text = formatCell(value, column.format);
                    const link = cellLinkHref(value, column.format);
                    const isStatus =
                      column.format === "status" || column.key === statusKey;

                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "px-3 py-2.5 align-top",
                          alignClass(column),
                          column.format === "multiline" && "whitespace-pre-wrap",
                        )}
                      >
                        {isStatus && text !== "—" ? (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                              TONE_PILL[row.tone ?? "neutral"],
                            )}
                          >
                            {text}
                          </span>
                        ) : link ? (
                          <a
                            href={link}
                            // The row may itself be a link; the cell wins.
                            onClick={(e) => e.stopPropagation()}
                            className="text-primary-600 underline-offset-2 hover:underline"
                            {...(column.format === "url"
                              ? { target: "_blank", rel: "noopener noreferrer" }
                              : {})}
                          >
                            {text}
                          </a>
                        ) : (
                          <span className="block truncate" title={text}>
                            {text}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>

          {artifact.total_label != null && (
            <tfoot>
              <tr className="sticky bottom-0 z-10 bg-white/95 backdrop-blur">
                <th
                  scope="row"
                  colSpan={Math.max(columns.length - 1, 1)}
                  className="border-t border-slate-200 px-3 py-2.5 text-left text-[13px] font-semibold text-slate-500"
                >
                  {artifact.total_label}
                </th>
                <td className="border-t border-slate-200 px-3 py-2.5 text-right text-[13px] font-semibold tabular-nums text-slate-900">
                  {formatCell(
                    artifact.total_value ?? null,
                    artifact.total_format ?? "money",
                  )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {(artifact.truncated || artifact.footnote || dense) && (
        <div className="shrink-0 space-y-0.5 border-t border-slate-200/70 px-4 py-2 text-[11px] text-slate-400">
          {artifact.truncated ? (
            <p>
              Showing {artifact.rows.length} of{" "}
              {artifact.rows.length + artifact.truncated}
            </p>
          ) : null}
          {artifact.footnote ? <p>{artifact.footnote}</p> : null}
          {dense && columns.length < artifact.columns.length ? (
            <p>Widen the preview to see all {artifact.columns.length} columns.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
