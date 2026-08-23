"use client";

/**
 * Lead → quote → proposal → project → invoice → payment (BIG-2, 0099).
 *
 * Every one of those already existed as a record; four of the five joins
 * existed too. What was missing was the two links that let you walk the chain
 * — and the screen that walks it.
 *
 * This is the answer to "what did this deal actually earn us": the price it
 * was sold at, the price it was delivered at, and every document in between,
 * each one clickable.
 */

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  FileSignature,
  FileText,
  FolderKanban,
  Link2,
  Receipt,
  Target,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";

export type ChainLink = {
  kind: "lead" | "quote" | "proposal" | "project" | "invoice" | "payment";
  label: string;
  sublabel: string | null;
  href: string | null;
  amount: number | null;
  /** Several invoices or payments collapse into one node with a count. */
  count?: number;
};

const ICONS = {
  lead: Target,
  quote: FileText,
  proposal: FileSignature,
  project: FolderKanban,
  invoice: Receipt,
  payment: Wallet,
} as const;

const TONE = {
  lead: "bg-sky-50 text-sky-600",
  quote: "bg-violet-50 text-violet-600",
  proposal: "bg-fuchsia-50 text-fuchsia-600",
  project: "bg-primary-50 text-primary-600",
  invoice: "bg-amber-50 text-amber-600",
  payment: "bg-emerald-50 text-emerald-600",
} as const;

export function ChainCard({
  links,
  currency,
  quoted,
  delivered,
}: {
  links: ChainLink[];
  currency: string;
  /** What the quote said. Null when no quote is linked. */
  quoted: number | null;
  /** What the project is actually worth now, extras included. */
  delivered: number;
}) {
  // A chain of one is the project on its own — nothing to walk.
  const linked = links.filter((l) => l.kind !== "project").length;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Link2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">The whole chain</h2>
          <p className="text-xs text-slate-400">
            {linked === 0
              ? "Nothing linked yet — attach the lead or quote this came from"
              : "Where this job came from, and what it has produced"}
          </p>
        </div>
      </div>

      {/* Quoted vs delivered — the comparison the chain exists to make */}
      {quoted !== null && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
          <Figure label="Quoted at" value={formatCurrency(quoted, currency)} />
          <ArrowRight className="h-4 w-4 text-slate-300" />
          <Figure
            label="Now worth"
            value={formatCurrency(delivered, currency)}
            tone={
              delivered > quoted ? "good" : delivered < quoted ? "warn" : undefined
            }
          />
          {delivered !== quoted && (
            <Badge
              className={
                delivered > quoted
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-amber-50 text-amber-700 ring-amber-200"
              }
            >
              {delivered > quoted ? "+" : ""}
              {formatCurrency(delivered - quoted, currency)}{" "}
              {delivered > quoted ? "in extras" : "below quote"}
            </Badge>
          )}
        </div>
      )}

      <ol className="divide-y divide-slate-100">
        {links.map((link, i) => {
          const Icon = ICONS[link.kind];
          const body = (
            <div className="flex items-center gap-3 px-5 py-3">
              <span
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  TONE[link.kind],
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {link.label}
                  {link.count && link.count > 1 && (
                    <span className="ml-1.5 text-xs font-normal text-slate-400">
                      ×{link.count}
                    </span>
                  )}
                </p>
                {link.sublabel && (
                  <p className="truncate text-xs text-slate-400">{link.sublabel}</p>
                )}
              </div>
              {link.amount !== null && (
                <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-600">
                  {formatCurrency(link.amount, currency)}
                </span>
              )}
            </div>
          );

          return (
            <li key={`${link.kind}-${i}`}>
              {link.href ? (
                <Link href={link.href} className="block transition hover:bg-slate-50">
                  {body}
                </Link>
              ) : (
                <div className={link.kind === "project" ? "bg-primary-50/30" : ""}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {linked === 0 && (
        <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-400">
          Projects created from a quote link themselves automatically. For older
          work, the link can be set from the project&apos;s edit form — it is what
          makes &ldquo;what did this lead earn us&rdquo; answerable.
        </p>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn";
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p
        className={cn(
          "text-sm font-bold tabular-nums",
          tone === "good"
            ? "text-emerald-600"
            : tone === "warn"
              ? "text-amber-600"
              : "text-slate-800",
        )}
      >
        {value}
      </p>
    </div>
  );
}
