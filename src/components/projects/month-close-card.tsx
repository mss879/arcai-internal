"use client";

/**
 * Closing the month the way the board opens it (VIEW-4).
 *
 * The board groups by the month a project was booked, which is half a story:
 * it says what came in the door and nothing about what left it. Six numbers
 * finish the sentence — booked, delivered, collected, still owed, carried
 * forward, margin — and they sit on every month group, not just the current
 * one, because the question "how did March actually go" is asked in April.
 *
 * Every figure comes from the same `derive()` the cards use. Nothing here
 * recomputes money.
 */

import * as React from "react";

import { marginTone } from "@/lib/projects";
import { cn, formatCurrency } from "@/lib/utils";

export type MonthCloseFigures = {
  /** Projects booked in this month, and what they were worth. */
  bookedCount: number;
  bookedValue: number;
  /** Of those, how many reached delivered or aftercare. */
  deliveredCount: number;
  deliveredValue: number;
  /** Cash actually received against them, however it was recorded. */
  collected: number;
  /** What is still owed on them. */
  owed: number;
  /** Still open, so they also appear under the current month. */
  carriedCount: number;
  /** Null until something has been spent — see marginIsMeaningful(). */
  marginPercent: number | null;
  profit: number;
  currency: string;
};

export function MonthCloseCard({
  figures,
  showMargin,
}: {
  figures: MonthCloseFigures;
  /** Margin is admin-only, matching commissions (invariant 9). */
  showMargin: boolean;
}) {
  const {
    bookedCount,
    bookedValue,
    deliveredCount,
    deliveredValue,
    collected,
    owed,
    carriedCount,
    marginPercent,
    profit,
    currency,
  } = figures;

  const collectedPercent =
    bookedValue > 0 ? Math.min(100, Math.round((collected / bookedValue) * 100)) : 0;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200/70 sm:grid-cols-3 lg:grid-cols-6">
      <Figure
        label="Booked"
        value={formatCurrency(bookedValue, currency)}
        hint={`${bookedCount} project${bookedCount === 1 ? "" : "s"}`}
      />
      <Figure
        label="Delivered"
        value={formatCurrency(deliveredValue, currency)}
        hint={
          bookedCount > 0
            ? `${deliveredCount} of ${bookedCount}`
            : "Nothing booked"
        }
      />
      <Figure
        label="Collected"
        value={formatCurrency(collected, currency)}
        hint={bookedValue > 0 ? `${collectedPercent}% of booked` : "—"}
        tone={collected > 0 ? "good" : undefined}
      />
      <Figure
        label="Still owed"
        value={formatCurrency(owed, currency)}
        hint={owed > 0 ? "Chase these" : "All settled"}
        tone={owed > 0 ? "warn" : undefined}
      />
      <Figure
        label="Carried forward"
        value={String(carriedCount)}
        hint={
          carriedCount > 0
            ? "Still open this month"
            : "Nothing left running"
        }
        tone={carriedCount > 0 ? "warn" : undefined}
      />
      {showMargin ? (
        <Figure
          label="Margin"
          value={marginPercent === null ? "—" : `${marginPercent}%`}
          hint={
            marginPercent === null
              ? "No costs recorded"
              : formatCurrency(profit, currency)
          }
          tone={
            marginPercent === null
              ? undefined
              : marginTone(marginPercent) === "good"
                ? "good"
                : marginTone(marginPercent) === "loss"
                  ? "bad"
                  : "warn"
          }
        />
      ) : (
        <Figure label="Margin" value="—" hint="Admins only" />
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-sm font-bold tabular-nums",
          tone === "good"
            ? "text-emerald-600"
            : tone === "warn"
              ? "text-amber-600"
              : tone === "bad"
                ? "text-rose-600"
                : "text-slate-800",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}
