import Link from "next/link";
import { Target } from "lucide-react";

import type { TargetProgress } from "@/lib/targets";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * This month's targets, beside the numbers they are measured against (0119).
 *
 * The dashboard's money tiles say what happened; this says what was supposed
 * to. Team targets first, then the person furthest behind — the order the
 * team page uses, so the two never tell a different story.
 */

const LABEL: Record<TargetProgress["kind"], string> = {
  revenue: "Revenue",
  deals_won: "Deals won",
  deliveries: "Delivered",
  leads: "New leads",
  hours: "Hours",
};

export function TargetsTile({ progress }: { progress: TargetProgress[] }) {
  if (!progress.length) return null;
  const shown = progress.slice(0, 4);

  return (
    <Link
      href="/team"
      className="group block rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-transparent transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[var(--shadow-lift)] hover:ring-primary-200"
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-primary-500/10 bg-primary-500/10 text-primary-600">
            <Target className="h-4.5 w-4.5" />
          </span>
          This month&apos;s targets
        </h3>
        {progress.length > shown.length && (
          <span className="text-xs text-slate-400">+{progress.length - shown.length} more</span>
        )}
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {shown.map((p) => (
          <li key={`${p.kind}-${p.userId ?? "team"}`}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-slate-600">
                {p.name ? `${p.name} · ` : ""}
                {LABEL[p.kind]}
              </span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {p.kind === "revenue"
                  ? `${formatCurrency(p.actual)} / ${formatCurrency(p.target)}`
                  : `${p.actual} / ${p.target}`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn(
                  "h-full rounded-full",
                  p.percent >= 100
                    ? "bg-emerald-500"
                    : p.percent >= 60
                      ? "bg-primary-500"
                      : "bg-amber-500",
                )}
                style={{ width: `${Math.min(100, Math.max(2, p.percent))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </Link>
  );
}
