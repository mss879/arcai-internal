"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  lineItemId,
  type ProposalBody,
  type ProposalSection,
  type ProposalSectionsMode,
} from "@/lib/proposal";

/**
 * The free-form sections editor.
 *
 * WHY THIS EXISTS: the proposal used to be a FIXED skeleton — Overview,
 * Objectives, Key Features, Educational Strategy, SEO — and the writer had to
 * fill those exact slots whatever it was actually selling. An SEO heading
 * appeared over a proposal with no SEO in it, and a monthly social retainer
 * had nowhere to be described at all.
 *
 * Now the writer composes its own sections, in its own order. The team edits
 * them here. Freedom is in what is SAID and in what ORDER — never in the
 * layout: every block below maps onto a shape the proposal PDF already draws,
 * which is what keeps an arbitrary section looking like an ARC AI proposal.
 */

const BODY_KINDS: { value: ProposalBody["kind"]; label: string }[] = [
  { value: "prose", label: "Paragraphs" },
  { value: "bullets", label: "Bullet list" },
  { value: "groups", label: "Sub-headings with bullets" },
  { value: "features", label: "Two-column feature grid" },
  { value: "steps", label: "Numbered steps" },
  { value: "timeline", label: "Dated timeline" },
  { value: "table", label: "Two-column table" },
  { value: "note", label: "Small footnote" },
];

const MODE_OPTIONS: { value: ProposalSectionsMode; label: string }[] = [
  { value: "replace_narrative", label: "These sections replace the standard write-up" },
  { value: "append", label: "Print after the standard write-up" },
  { value: "replace_all", label: "These sections are the whole proposal (you write the terms too)" },
];

/* ---------------- pipe-separated rows ---------------- */
// The tabular blocks (steps, feature cells, timeline, table rows) are edited as
// one row per line with " | " between the cells. A row editor per cell would
// bury a five-row table in forty inputs; this keeps the whole block readable
// and reorderable in a single textarea, the way the list fields on this page
// already work.

function splitRow(line: string, cells: number): string[] {
  const parts = line.split("|").map((s) => s.trim());
  const out = parts.slice(0, cells);
  while (out.length < cells) out.push("");
  return out;
}

function joinRow(cells: (string | undefined)[]): string {
  return cells
    .map((c) => (c ?? "").trim())
    .join(" | ")
    .replace(/(\s\|\s*)+$/, "");
}

const toLines = (v: string): string[] => v.split("\n");
const trimArr = (a: string[]): string[] =>
  arr(a)
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

/**
 * A value that is genuinely an array, or an empty one.
 *
 * `cleanBody` runs on EVERY preview render and every save, over content that
 * arrived as stored JSON — so a block whose `rows` came back as a string, or
 * whose `steps` is null, reaches it as-is. `?? []` only catches null and
 * undefined; anything else fell straight into `.map` and threw inside React's
 * render, which white-screens the editor and makes that proposal permanently
 * uneditable. The PDF renderer guards every one of these with `Array.isArray`
 * already; this is the same guard on the write path.
 */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** A trimmed string, or "" for anything that is not one. Same reason as `arr`:
 * a stored value typed as a string is not guaranteed to be one. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/* ---------------- cleaning ---------------- */

/**
 * Strip blank rows out of one block, or return null when nothing is left.
 *
 * An UNKNOWN kind passes through untouched: this form runs on every preview
 * render, and quietly deleting a block shape it does not recognise would
 * destroy work another writer did. The PDF already renders nothing for a kind
 * it cannot draw, so passing it through is safe.
 */
function cleanBody(body: ProposalBody): ProposalBody | null {
  if (!body || typeof body !== "object") return null;
  switch (body.kind) {
    case "prose": {
      const paragraphs = trimArr(body.paragraphs);
      return paragraphs.length ? { kind: "prose", paragraphs } : null;
    }
    case "bullets": {
      const items = trimArr(body.items);
      return items.length ? { kind: "bullets", items } : null;
    }
    case "groups": {
      const groups = arr<(typeof body.groups)[number]>(body.groups)
        .map((g) => {
          const o = g ?? { heading: "", items: [] };
          const out: { heading: string; intro?: string; items: string[] } = {
            heading: (o.heading ?? "").trim(),
            items: trimArr(o.items),
          };
          if (o.intro?.trim()) out.intro = o.intro.trim();
          return out;
        })
        .filter((g) => g.heading && g.items.length > 0);
      return groups.length ? { kind: "groups", groups } : null;
    }
    case "steps": {
      const steps = arr<(typeof body.steps)[number]>(body.steps)
        .map((s) => {
          const o = s ?? { title: "" };
          const out: { title: string; description?: string } = {
            title: (o.title ?? "").trim(),
          };
          if (o.description?.trim()) out.description = o.description.trim();
          return out;
        })
        .filter((s) => s.title);
      return steps.length ? { kind: "steps", steps } : null;
    }
    case "features": {
      const items = arr<(typeof body.items)[number]>(body.items)
        .map((f) => {
          const o = f ?? { title: "" };
          const out: { title: string; description?: string } = {
            title: (o.title ?? "").trim(),
          };
          if (o.description?.trim()) out.description = o.description.trim();
          return out;
        })
        .filter((f) => f.title);
      return items.length ? { kind: "features", items } : null;
    }
    case "timeline": {
      const steps = arr<(typeof body.steps)[number]>(body.steps)
        .map((s) => {
          const o = s ?? { title: "", description: "", duration: "" };
          return {
            title: (o.title ?? "").trim(),
            description: (o.description ?? "").trim(),
            duration: (o.duration ?? "").trim(),
          };
        })
        .filter((s) => s.title);
      return steps.length ? { kind: "timeline", steps } : null;
    }
    case "table": {
      const rows = arr<unknown>(body.rows)
        // A row must be a PAIR. A bare string row used to be indexed as if it
        // were one — `"ab"[0]` is "a" — so a malformed row silently became a
        // table cell holding a single letter. The PDF drops a non-array row;
        // this drops it too, so the two agree on what a row is.
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r): [string, string] => [
          (typeof r[0] === "string" ? r[0] : "").trim(),
          (typeof r[1] === "string" ? r[1] : "").trim(),
        ])
        .filter((r) => r[0] || r[1]);
      if (!rows.length) return null;
      const cols = arr<unknown>(body.columns);
      const out: Extract<ProposalBody, { kind: "table" }> = {
        kind: "table",
        columns: [
          (typeof cols[0] === "string" ? cols[0] : "").trim(),
          (typeof cols[1] === "string" ? cols[1] : "").trim(),
        ],
        rows,
      };
      if (str(body.labelWidth)) out.labelWidth = str(body.labelWidth);
      return out;
    }
    case "note": {
      const text = str(body.text);
      return text ? { kind: "note", text } : null;
    }
    default:
      return body;
  }
}

/**
 * Clean the free-form sections, or return `undefined` when there are none.
 *
 * `undefined` — never `[]` — is the whole point: PRESENCE of `content.sections`
 * is what tells the PDF this proposal was composed rather than templated, so a
 * proposal that has none must come out of this form with no `sections` key at
 * all, exactly as it went in.
 */
export function cleanSections(
  sections: ProposalSection[] | undefined,
): ProposalSection[] | undefined {
  if (!Array.isArray(sections) || sections.length === 0) return undefined;
  const out: ProposalSection[] = [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    const heading = (sec.heading ?? "").trim();
    const body = (Array.isArray(sec.body) ? sec.body : [])
      .map(cleanBody)
      .filter((b): b is ProposalBody => b !== null);
    if (!heading || body.length === 0) continue;
    const next: ProposalSection = {
      id: (sec.id ?? "").trim() || lineItemId(heading),
      heading,
      body,
    };
    // Kept verbatim when it was stored, rather than normalised away: "before"
    // is the default, but rewriting a stored value is still a rewrite.
    if (sec.placement === "after" || sec.placement === "before") {
      next.placement = sec.placement;
    }
    out.push(next);
  }
  return out.length > 0 ? out : undefined;
}

/* ---------------- editor ---------------- */

function emptyBody(kind: ProposalBody["kind"]): ProposalBody {
  switch (kind) {
    case "bullets":
      return { kind: "bullets", items: [] };
    case "groups":
      return { kind: "groups", groups: [{ heading: "", items: [] }] };
    case "steps":
      return { kind: "steps", steps: [] };
    case "features":
      return { kind: "features", items: [] };
    case "timeline":
      return { kind: "timeline", steps: [] };
    case "table":
      return { kind: "table", columns: ["Item", "Detail"], rows: [] };
    case "note":
      return { kind: "note", text: "" };
    default:
      return { kind: "prose", paragraphs: [] };
  }
}

export function SectionsEditor({
  sections,
  mode,
  onChange,
}: {
  sections: ProposalSection[];
  mode: ProposalSectionsMode | undefined;
  /** Both at once — dropping the last section must clear the mode with it. */
  onChange: (
    sections: ProposalSection[],
    mode: ProposalSectionsMode | undefined,
  ) => void;
}) {
  const effectiveMode: ProposalSectionsMode = mode ?? "replace_narrative";

  function setSections(next: ProposalSection[]) {
    onChange(next, next.length > 0 ? effectiveMode : undefined);
  }

  function patch(index: number, next: ProposalSection) {
    setSections(sections.map((s, i) => (i === index ? next : s)));
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= sections.length) return;
    const next = [...sections];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    setSections(next);
  }

  function addSection() {
    const id = `section-${sections.length + 1}-${Date.now().toString(36)}`;
    setSections([
      ...sections,
      { id, heading: "", body: [{ kind: "prose", paragraphs: [] }] },
    ]);
  }

  return (
    <div className="space-y-3">
      {sections.length > 0 && (
        <Field
          label="How these sections are used"
          hint="The Investment table, terms and sign-off always print — this only decides what happens to the standard write-up."
        >
          <Select
            value={effectiveMode}
            onChange={(e) =>
              onChange(sections, e.target.value as ProposalSectionsMode)
            }
          >
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {sections.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
          No written sections — the proposal prints the standard write-up
          (Overview, Objectives, Key features, and so on).
        </p>
      )}

      {sections.map((sec, i) => (
        <SectionRow
          key={sec.id || i}
          section={sec}
          index={i}
          count={sections.length}
          onChange={(next) => patch(i, next)}
          onMove={(delta) => move(i, delta)}
          onRemove={() => setSections(sections.filter((_, j) => j !== i))}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-center"
        onClick={addSection}
      >
        <Plus className="h-4 w-4" /> Add a section
      </Button>
    </div>
  );
}

function SectionRow({
  section,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  section: ProposalSection;
  index: number;
  count: number;
  onChange: (next: ProposalSection) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = React.useState(true);
  const body = Array.isArray(section.body) ? section.body : [];

  function setBody(next: ProposalBody[]) {
    onChange({ ...section, body: next });
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="flex items-center gap-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-900 text-[11px] font-bold text-white">
          {index + 1}
        </span>
        <Input
          value={section.heading}
          onChange={(e) => onChange({ ...section, heading: e.target.value })}
          placeholder="Section heading, e.g. Social Media — Halo Media"
          className="h-9 flex-1"
        />
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label="Move section up"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label="Move section down"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove section"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary-700 transition hover:text-primary-800"
        >
          {open ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          {body.length} block{body.length === 1 ? "" : "s"}
        </button>
        <Select
          className="h-8 w-40 text-xs"
          value={section.placement ?? "before"}
          onChange={(e) =>
            onChange({
              ...section,
              placement: e.target.value === "after" ? "after" : "before",
            })
          }
        >
          <option value="before">Before Investment</option>
          <option value="after">After Investment</option>
        </Select>
      </div>

      {open && (
        <div className="space-y-2.5">
          {body.map((b, i) => (
            <div
              key={i}
              className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {BODY_KINDS.find((k) => k.value === b.kind)?.label ?? b.kind}
                </span>
                <button
                  type="button"
                  onClick={() => setBody(body.filter((_, j) => j !== i))}
                  aria-label="Remove block"
                  className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <BodyEditor
                body={b}
                onChange={(next) =>
                  setBody(body.map((x, j) => (j === i ? next : x)))
                }
              />
            </div>
          ))}

          <Select
            className="h-9 text-xs"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setBody([...body, emptyBody(e.target.value as ProposalBody["kind"])]);
            }}
          >
            <option value="">Add a block…</option>
            {BODY_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}

function BodyEditor({
  body,
  onChange,
}: {
  body: ProposalBody;
  onChange: (next: ProposalBody) => void;
}) {
  switch (body.kind) {
    case "prose":
      return (
        <Textarea
          rows={4}
          value={(body.paragraphs ?? []).join("\n")}
          onChange={(e) =>
            onChange({ kind: "prose", paragraphs: toLines(e.target.value) })
          }
          placeholder="One paragraph per line"
        />
      );

    case "bullets":
      return (
        <Textarea
          rows={4}
          value={(body.items ?? []).join("\n")}
          onChange={(e) =>
            onChange({ kind: "bullets", items: toLines(e.target.value) })
          }
          placeholder="One bullet per line"
        />
      );

    case "groups":
      return (
        <div className="space-y-2">
          {(body.groups ?? []).map((g, i) => (
            <div key={i} className="space-y-1.5 rounded-lg bg-slate-50 p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-8 flex-1 text-xs"
                  value={g.heading}
                  onChange={(e) =>
                    onChange({
                      kind: "groups",
                      groups: (body.groups ?? []).map((x, j) =>
                        j === i ? { ...x, heading: e.target.value } : x,
                      ),
                    })
                  }
                  placeholder="Sub-heading"
                />
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      kind: "groups",
                      groups: (body.groups ?? []).filter((_, j) => j !== i),
                    })
                  }
                  aria-label="Remove sub-heading"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input
                className="h-8 text-xs"
                value={g.intro ?? ""}
                onChange={(e) =>
                  onChange({
                    kind: "groups",
                    groups: (body.groups ?? []).map((x, j) =>
                      j === i ? { ...x, intro: e.target.value } : x,
                    ),
                  })
                }
                placeholder="Short intro (optional)"
              />
              <Textarea
                rows={3}
                value={(g.items ?? []).join("\n")}
                onChange={(e) =>
                  onChange({
                    kind: "groups",
                    groups: (body.groups ?? []).map((x, j) =>
                      j === i ? { ...x, items: toLines(e.target.value) } : x,
                    ),
                  })
                }
                placeholder="One bullet per line"
              />
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-center text-xs"
            onClick={() =>
              onChange({
                kind: "groups",
                groups: [...(body.groups ?? []), { heading: "", items: [] }],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add sub-heading
          </Button>
        </div>
      );

    case "steps":
      return (
        <Field hint="One step per line — Title | what happens">
          <Textarea
            rows={4}
            value={(body.steps ?? [])
              .map((s) => joinRow([s.title, s.description]))
              .join("\n")}
            onChange={(e) =>
              onChange({
                kind: "steps",
                steps: toLines(e.target.value).map((line) => {
                  const [title, description] = splitRow(line, 2);
                  return { title, description };
                }),
              })
            }
            placeholder="Kickoff | We agree scope and get your assets"
          />
        </Field>
      );

    case "features":
      return (
        <Field hint="One cell per line — Title | one short line under it">
          <Textarea
            rows={4}
            value={(body.items ?? [])
              .map((f) => joinRow([f.title, f.description]))
              .join("\n")}
            onChange={(e) =>
              onChange({
                kind: "features",
                items: toLines(e.target.value).map((line) => {
                  const [title, description] = splitRow(line, 2);
                  return { title, description };
                }),
              })
            }
            placeholder="Advanced CRM | Every lead scored and routed automatically"
          />
        </Field>
      );

    case "timeline":
      return (
        <Field hint="One step per line — Title | what happens | how long">
          <Textarea
            rows={4}
            value={(body.steps ?? [])
              .map((s) => joinRow([s.title, s.description, s.duration]))
              .join("\n")}
            onChange={(e) =>
              onChange({
                kind: "timeline",
                steps: toLines(e.target.value).map((line) => {
                  const [title, description, duration] = splitRow(line, 3);
                  return { title, description, duration };
                }),
              })
            }
            placeholder="Design & Content | UI polish and copy | Day 3-5"
          />
        </Field>
      );

    case "table":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input
              className="h-8 text-xs"
              value={body.columns?.[0] ?? ""}
              onChange={(e) =>
                onChange({
                  ...body,
                  columns: [e.target.value, body.columns?.[1] ?? ""],
                })
              }
              placeholder="Left column"
            />
            <Input
              className="h-8 text-xs"
              value={body.columns?.[1] ?? ""}
              onChange={(e) =>
                onChange({
                  ...body,
                  columns: [body.columns?.[0] ?? "", e.target.value],
                })
              }
              placeholder="Right column"
            />
          </div>
          <Field hint="One row per line — Left | Right">
            <Textarea
              rows={4}
              value={(body.rows ?? [])
                .map((r) => joinRow([r?.[0], r?.[1]]))
                .join("\n")}
              onChange={(e) =>
                onChange({
                  ...body,
                  rows: toLines(e.target.value).map((line) => {
                    const [a, b] = splitRow(line, 2);
                    return [a, b] as [string, string];
                  }),
                })
              }
              placeholder="Smart Business Website | One-time"
            />
          </Field>
        </div>
      );

    case "note":
      return (
        <Input
          className="h-9"
          value={body.text ?? ""}
          onChange={(e) => onChange({ kind: "note", text: e.target.value })}
          placeholder="Small footnote"
        />
      );

    default:
      // A block shape this form doesn't know — shown, never edited, never
      // dropped. See cleanBody().
      return (
        <p className="text-[11px] text-slate-400">
          This block was written elsewhere and prints as it is.
        </p>
      );
  }
}
