"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  formatPriceField,
  type PriceField,
  type PricingGroup,
  type PricingPackage,
} from "@/lib/pricing-catalog";
import {
  lineItemFromCatalog,
  lineItemId,
  money,
  recurrenceSuffix,
  type LineRecurrence,
  type ProposalLineItem,
} from "@/lib/proposal";

/**
 * The multi-item line builder.
 *
 * WHY THIS EXISTS: a proposal used to describe exactly ONE package, so a
 * client buying a website AND a monthly social retainer could not be quoted at
 * all — and two thirds of the /pricing list (every retainer, every per-post
 * add-on, every AI automation tier) was unreachable from a proposal because
 * the old picker only mirrored a subset of it.
 *
 * Here the team picks any number of lines straight off the live price list,
 * the package's REAL features come across with them (copied in, then frozen —
 * the catalog will change, this proposal must not), and the price the client
 * actually pays is whatever the team types. The list price it came down from
 * prints struck through beside it.
 */

const RECURRENCE_OPTIONS: { value: LineRecurrence; label: string }[] = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "at_cost", label: "At cost (no figure)" },
];

/** One pickable price on the live /pricing list. */
type CatalogOption = {
  key: string;
  label: string;
  price: string;
  featureCount: number;
};

/**
 * Every LKR price on the price list, grouped exactly as /pricing groups them.
 * USD fields are left out on purpose: the Investment table totals in LKR, and
 * silently mixing currencies into one column would misstate the total — the
 * same reason `lineItemFromCatalog` refuses them.
 */
function catalogOptions(
  groups: PricingGroup[],
): { title: string; options: CatalogOption[] }[] {
  return groups
    .map((group) => ({
      title: group.title,
      options: group.packages.flatMap((pkg) =>
        pkg.prices
          .filter((f) => (f.currency ?? "LKR") === "LKR")
          .map((f) => ({
            key: f.key,
            label: optionLabel(pkg, f),
            price: formatPriceField(f),
            featureCount: pkg.features?.length ?? 0,
          })),
      ),
    }))
    .filter((g) => g.options.length > 0);
}

/** "Halo Media — Intermediate", "Smart Store System — AI layer". A package
 * carrying more than one price needs the price's own label to stay telling. */
function optionLabel(pkg: PricingPackage, field: PriceField): string {
  const name = pkg.name.trim();
  return pkg.prices.length > 1 ? `${name} — ${field.label}` : name;
}

/** Ids have to stay unique inside one proposal — they are how a line is
 * targeted for edit or removal later. Adding the same package twice (two
 * retainers on different brands, say) must not collide. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const next = `${base}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

/** What one line adds up to, for the small total printed on its card. */
function lineTotal(item: ProposalLineItem): string {
  if (item.recurrence === "at_cost") return "At cost";
  const qty = item.quantity && item.quantity > 0 ? item.quantity : 1;
  return `${money((Number(item.amount) || 0) * qty)}${recurrenceSuffix(item.recurrence) ?? ""}`;
}

export function ItemBuilder({
  items,
  catalog,
  onChange,
}: {
  items: ProposalLineItem[];
  /** The live /pricing catalog, team overrides already applied. */
  catalog: PricingGroup[];
  onChange: (next: ProposalLineItem[]) => void;
}) {
  const groups = React.useMemo(() => catalogOptions(catalog), [catalog]);
  const taken = React.useMemo(() => new Set(items.map((i) => i.id)), [items]);

  function addFromCatalog(key: string) {
    const built = lineItemFromCatalog(catalog, key);
    if (!built) return;
    onChange([...items, { ...built, id: uniqueId(built.id, taken) }]);
  }

  function addBespoke() {
    onChange([
      ...items,
      {
        id: uniqueId(`custom-${items.length + 1}`, taken),
        catalogKey: null,
        label: "",
        features: [],
        amount: 0,
        recurrence: "one_time",
      },
    ]);
  }

  function patch(index: number, next: ProposalLineItem) {
    onChange(items.map((it, i) => (i === index ? next : it)));
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="rounded-xl border border-dashed border-amber-200 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-700">
          No lines yet. Until you add one this proposal is still priced from the
          single package below — add the packages the client is buying.
        </p>
      )}

      {items.map((item, i) => (
        <ItemRow
          key={item.id}
          item={item}
          index={i}
          count={items.length}
          onChange={(next) => patch(i, next)}
          onMove={(delta) => move(i, delta)}
          onRemove={() => onChange(items.filter((_, j) => j !== i))}
        />
      ))}

      <Field
        label="Add from the price list"
        hint="Everything on /pricing — websites, e-commerce, AI, social retainers, add-ons. The package's features come across with it."
      >
        <Select
          value=""
          onChange={(e) => {
            if (e.target.value) addFromCatalog(e.target.value);
          }}
        >
          <option value="">Choose a package…</option>
          {groups.map((g) => (
            <optgroup key={g.title} label={g.title}>
              {g.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label} — {o.price}
                  {o.featureCount > 0 ? ` (${o.featureCount} features)` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-center"
        onClick={addBespoke}
      >
        <Plus className="h-4 w-4" /> Add a bespoke line
      </Button>
    </div>
  );
}

function ItemRow({
  item,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  item: ProposalLineItem;
  index: number;
  count: number;
  onChange: (next: ProposalLineItem) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [openFeatures, setOpenFeatures] = React.useState(false);
  const features = Array.isArray(item.features) ? item.features : [];
  const showFeatures = item.showFeatures !== false;

  /** Optional numbers are DELETED, never stored as 0 or NaN: an absent
   * `listAmount` means "no struck-through price", and 0 would read as one. */
  function patchNumber(field: "listAmount" | "quantity", raw: string) {
    const next = { ...item };
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) delete next[field];
    else next[field] = n;
    onChange(next);
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="flex items-center gap-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-900 text-[11px] font-bold text-white">
          {index + 1}
        </span>
        <Input
          value={item.label}
          onChange={(e) => onChange({ ...item, label: e.target.value })}
          placeholder="Line name, e.g. Smart Business Website"
          className="h-9 flex-1"
        />
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label="Move up"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label="Move down"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove line"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Price (LKR)">
          <Input
            type="number"
            className="h-9"
            value={item.amount || ""}
            disabled={item.recurrence === "at_cost"}
            onChange={(e) =>
              onChange({ ...item, amount: Number(e.target.value) || 0 })
            }
            placeholder="0"
          />
        </Field>
        <Field label="Was (optional)">
          <Input
            type="number"
            className="h-9"
            value={item.listAmount ?? ""}
            disabled={item.recurrence === "at_cost"}
            onChange={(e) => patchNumber("listAmount", e.target.value)}
            placeholder="List price"
          />
        </Field>
        <Field label="Billing">
          <Select
            className="h-9"
            value={item.recurrence}
            onChange={(e) => {
              const recurrence = e.target.value as LineRecurrence;
              // An at-cost line carries no figure at all — it prints the words
              // "At cost" and never moves a total, so a leftover amount would
              // be a number nobody is being charged.
              onChange(
                recurrence === "at_cost"
                  ? { ...item, recurrence, amount: 0 }
                  : { ...item, recurrence },
              );
            }}
          >
            {RECURRENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-[80px_1fr] gap-2">
        <Field label="Qty">
          <Input
            type="number"
            className="h-9"
            value={item.quantity ?? ""}
            onChange={(e) => patchNumber("quantity", e.target.value)}
            placeholder="1"
          />
        </Field>
        <Field label="Note (optional)">
          <Input
            className="h-9"
            value={item.note ?? ""}
            onChange={(e) => {
              const next = { ...item };
              if (e.target.value.trim()) next.note = e.target.value;
              else delete next.note;
              onChange(next);
            }}
            placeholder="e.g. agreed rate, 12 months"
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpenFeatures((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary-700 transition hover:text-primary-800"
        >
          {openFeatures ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          What&rsquo;s included ({features.length})
        </button>
        <span className="text-xs font-semibold text-slate-900">
          {lineTotal(item)}
        </span>
      </div>

      {openFeatures && (
        <div className="space-y-2">
          <Textarea
            rows={4}
            value={features.join("\n")}
            onChange={(e) =>
              onChange({ ...item, features: e.target.value.split("\n") })
            }
            placeholder="One feature per line — these print under the line on the proposal"
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...item };
              // Absent means "show them" — only an explicit false hides them,
              // so the flag is deleted rather than set back to true.
              if (showFeatures) next.showFeatures = false;
              else delete next.showFeatures;
              onChange(next);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition",
              showFeatures
                ? "border-primary-300 bg-primary-50 text-primary-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            <span
              className={cn(
                "grid h-4 w-4 place-items-center rounded border",
                showFeatures
                  ? "border-primary-500 bg-primary-500 text-white"
                  : "border-slate-300",
              )}
            >
              {showFeatures && "✓"}
            </span>
            Print these features under the line
          </button>
        </div>
      )}
    </div>
  );
}

/** A bespoke line the team typed, ready for `ItemBuilder`. Exported so the
 * generator can seed the list when converting a single-package proposal. */
export function bespokeLine(
  label: string,
  amount: number,
  features: string[] = [],
): ProposalLineItem {
  return {
    id: lineItemId(label),
    catalogKey: null,
    label,
    features,
    amount,
    recurrence: "one_time",
  };
}
