import type { AiProjectStatus } from "@/lib/database.types";

/** Presentation helpers shared by the AI Projects pages and panels. Plain
 * module on purpose: server pages and client panels both import it. */

export const AI_STATUS_META: Record<AiProjectStatus, { label: string; className: string; dot: string; blurb: string }> = {
  draft: {
    label: "Draft",
    className: "bg-slate-100 text-slate-600 ring-slate-200",
    dot: "bg-slate-400",
    blurb: "Being set up. The widget works only in the preview here; nothing is billed.",
  },
  active: {
    label: "Live",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
    blurb: "Serving the client's website. Usage is metered and billed monthly.",
  },
  paused: {
    label: "Paused",
    className: "bg-amber-50 text-amber-700 ring-amber-200",
    dot: "bg-amber-500",
    blurb: "The widget hides itself on the client's site. Nothing is served or billed.",
  },
  archived: {
    label: "Archived",
    className: "bg-rose-50 text-rose-700 ring-rose-200",
    dot: "bg-rose-400",
    blurb: "Kept for the ledger and past invoices; gone from the list.",
  },
};

/** $0.0042 for tiny amounts, $12.34 otherwise. */
export function usd(n: number): string {
  const v = Number(n) || 0;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : 2,
  })}`;
}

/** 1,234,567 → "1.23M", 12,345 → "12.3k". */
export function compact(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "pk_" + the last four characters — enough to recognise, not enough to use. */
export function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}${"•".repeat(12)}${key.slice(-4)}` : key;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
