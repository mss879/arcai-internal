/**
 * Formatting, tone and iconography for the Arc Studio preview canvas.
 *
 * Every artifact body component renders values through here rather than
 * inventing its own `toLocaleString` call. Why: an artifact's `format` is
 * decided on the SERVER by whichever tool produced it, so the client must have
 * exactly one place that turns `ArtifactFormat` into pixels — otherwise a
 * money column reads "Rs. 1,234" in the table and "1234" in the record view of
 * the same row, and the user stops trusting the preview.
 *
 * Framework-free apart from the lucide icon *types*: no React, no hooks, so it
 * can be imported from anywhere in the client tree (the conversation's artifact
 * chips need `AREA_META` too).
 */

import {
  BadgeDollarSign,
  BarChart3,
  BrainCircuit,
  CalendarClock,
  Check,
  Clock,
  Copy,
  CreditCard,
  Download,
  Eye,
  ExternalLink,
  FileText,
  FolderKanban,
  FolderOpen,
  Globe,
  KanbanSquare,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  PackageCheck,
  Pencil,
  Plus,
  Radar,
  RefreshCw,
  ScrollText,
  Send,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { ADMIN_NAV, NAV } from "@/components/layout/nav";
import { formatCurrency } from "@/lib/utils";
import type {
  AppArea,
  Artifact,
  ArtifactCell,
  ArtifactFormat,
  ArtifactKind,
  ArtifactTone,
} from "@/lib/assistant-artifacts";

/** Narrow the `Artifact` union to one kind, e.g. `ArtifactOf<"table">`. */
export type ArtifactOf<K extends ArtifactKind> = Extract<Artifact, { kind: K }>;

// ---- Values --------------------------------------------------------------

/**
 * ISO date to en-GB, pinned to midday.
 *
 * The noon trick is deliberate and is copied from `assistant-card.tsx`: a bare
 * `new Date("2026-08-25")` is parsed as UTC midnight, which renders as the
 * 24th in any timezone west of Greenwich. Adding `T12:00:00` makes it local
 * and no timezone can push it across a day boundary.
 */
function formatIsoDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB");
}

/** Render one cell for a given format. Empty values always become an em dash. */
export function formatCell(
  value: ArtifactCell,
  format?: ArtifactFormat,
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && value.trim() === "") return "—";

  switch (format) {
    case "money": {
      const n = Number(value);
      return Number.isFinite(n) ? formatCurrency(n) : String(value);
    }
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value);
    }
    case "percent": {
      const n = Number(value);
      return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(value);
    }
    case "date":
      return formatIsoDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    default:
      return String(value);
  }
}

/**
 * The `href` a cell should link to for link-ish formats, or null.
 * Kept next to `formatCell` so the two can never disagree about what counts
 * as an email versus a phone number.
 */
export function cellLinkHref(
  value: ArtifactCell,
  format?: ArtifactFormat,
): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  switch (format) {
    case "email":
      return text.includes("@") ? `mailto:${text}` : null;
    case "phone":
      return `tel:${text.replace(/[^\d+]/g, "")}`;
    case "url":
      return /^https?:\/\//i.test(text) ? text : `https://${text}`;
    default:
      return null;
  }
}

/** Signed percentage delta, e.g. "12.5%". Never carries its own arrow. */
export function formatDelta(delta: number): string {
  const abs = Math.abs(delta);
  const digits = Number.isInteger(abs) ? 0 : 1;
  return `${abs.toFixed(digits)}%`;
}

/**
 * Tone for a delta when the server didn't pin one. A zero delta is explicitly
 * neutral — showing a green up-arrow next to "0%" is a lie the user will spot.
 */
export function deltaTone(delta: number): ArtifactTone {
  if (delta > 0) return "positive";
  if (delta < 0) return "danger";
  return "neutral";
}

// ---- Tone ----------------------------------------------------------------

/** Pill classes per tone (background + text + ring, for `ring-1 ring-inset`). */
/** The same tone pills on the dark command stage (0104). */
export const TONE_PILL_STAGE: Record<ArtifactTone, string> = {
  neutral: "bg-white/10 text-slate-300 ring-white/15",
  positive: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  danger: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
};

export const TONE_PILL: Record<ArtifactTone, string> = {
  neutral: "bg-slate-100 text-slate-600 ring-slate-200",
  positive: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
  info: "bg-primary-50 text-primary-700 ring-primary-200",
};

/** Text colour per tone — chart marks paint from `currentColor`. */
export const TONE_TEXT: Record<ArtifactTone, string> = {
  neutral: "text-slate-400",
  positive: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-rose-500",
  info: "text-primary-500",
};

// ---- Areas + icons -------------------------------------------------------

/**
 * Where each artifact area lives in the app. The label and icon are looked up
 * from `NAV`/`ADMIN_NAV` by href so the canvas can never drift from the
 * sidebar; only the area-to-href mapping lives here.
 */
const AREA_HREF: Record<AppArea, string> = {
  dashboard: "/dashboard",
  clients: "/clients",
  todos: "/todos",
  projects: "/projects",
  delivery: "/delivery",
  website: "/website-progress",
  crm: "/crm",
  automation: "/automation",
  finance: "/finance",
  intelligence: "/intelligence",
  meetings: "/meetings",
  payments: "/payments",
  invoices: "/invoices",
  notices: "/notices",
  proposals: "/proposals",
  pricing: "/pricing",
  sms: "/sms",
  whatsapp: "/whatsapp",
  content: "/content",
  resources: "/resources",
  team: "/team",
  workspace: "/dashboard",
};

/** Used only when an href isn't in NAV (today: "workspace"). */
const AREA_FALLBACK: Partial<
  Record<AppArea, { label: string; icon: LucideIcon }>
> = {
  workspace: { label: "Workspace", icon: Sparkles },
};

const NAV_BY_HREF = new Map(
  [...NAV, ...ADMIN_NAV].map((item) => [item.href, item] as const),
);

/** Area to nav entry (label + href + icon), derived from the real sidebar. */
export const AREA_META: Record<
  AppArea,
  { label: string; href: string; icon: LucideIcon }
> = (() => {
  const areas = Object.keys(AREA_HREF) as AppArea[];
  const out = {} as Record<
    AppArea,
    { label: string; href: string; icon: LucideIcon }
  >;
  for (const area of areas) {
    const href = AREA_HREF[area];
    const nav = area === "workspace" ? undefined : NAV_BY_HREF.get(href);
    const fallback = AREA_FALLBACK[area];
    out[area] = {
      href,
      label: nav?.label ?? fallback?.label ?? "Workspace",
      icon: nav?.icon ?? fallback?.icon ?? Sparkles,
    };
  }
  return out;
})();

/** Fallback icon per artifact kind, for artifacts with no (or a generic) area. */
const KIND_ICON: Record<ArtifactKind, LucideIcon> = {
  table: Table2,
  record: FileText,
  metrics: BarChart3,
  chart: BarChart3,
  timeline: Clock,
  text: FileText,
  page: Globe,
  invoice: FileText,
  proposal: ScrollText,
  briefing: Sparkles,
  scan: Radar,
};

/** The area an artifact belongs to, inferred from its kind when unset. */
export function artifactArea(artifact: Artifact): AppArea {
  if (artifact.area) return artifact.area;
  if (artifact.kind === "invoice") return "invoices";
  if (artifact.kind === "proposal") return "proposals";
  if (artifact.kind === "scan") return "crm";
  return "workspace";
}

/**
 * The icon for a tab or chip: the artifact's area icon when it has a real
 * one, otherwise something that describes its shape (a table, a chart…).
 */
export function artifactIcon(artifact: Artifact): LucideIcon {
  const area = artifactArea(artifact);
  if (area === "workspace") return KIND_ICON[artifact.kind];
  return AREA_META[area].icon;
}

/**
 * `ArtifactAction.icon` to component. An allow-list, not a dynamic lookup: the
 * icon name arrives from the model, and indexing the whole icon package with
 * model output is an open door. Unknown names fall back to Sparkles.
 */
export const ACTION_ICONS: Record<string, LucideIcon> = {
  Mail,
  Send,
  Download,
  ExternalLink,
  Copy,
  RefreshCw,
  FileText,
  ScrollText,
  CreditCard,
  Users,
  Zap,
  Plus,
  Check,
  Pencil,
  Trash2,
  Eye,
  BarChart3,
  Clock,
  Landmark,
  Globe,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  FolderKanban,
  PackageCheck,
  KanbanSquare,
  BrainCircuit,
  CalendarClock,
  Megaphone,
  BadgeDollarSign,
  MessageSquareText,
  MessageCircle,
  FolderOpen,
  ShieldCheck,
};

/** Resolve an action's icon name to a component (never throws). */
export function actionIcon(name?: string): LucideIcon {
  if (!name) return Sparkles;
  return ACTION_ICONS[name] ?? Sparkles;
}

// ---- Embedding -----------------------------------------------------------

/** Routes that must never render inside a frame. */
const EMBED_DENY = ["/login", "/logout", "/auth", "/portal", "/api"];

/** Control characters can smuggle a scheme past a naive prefix check. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Turn an in-app href into an embeddable one (`?embed=1`), or return null if
 * it isn't safe to frame.
 *
 * Four rules, all mandatory:
 *  1. same-origin path only — anything with a scheme, or protocol-relative,
 *     or a backslash trick (`/\evil.com`) is refused outright;
 *  2. auth surfaces are refused (a login form in a frame is a phishing shape);
 *  3. existing query params survive, `embed=1` is added;
 *  4. the hash is dropped — it would fight the PDF viewer params elsewhere
 *     and carries nothing the embedded page needs.
 */
export function toEmbedHref(href: string): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (CONTROL_CHARS.test(raw)) return null;

  const [beforeHash] = raw.split("#");
  const [path, query = ""] = beforeHash.split("?");
  const lower = path.toLowerCase();
  if (
    EMBED_DENY.some((deny) => lower === deny || lower.startsWith(`${deny}/`))
  ) {
    return null;
  }

  const params = new URLSearchParams(query);
  params.set("embed", "1");
  return `${path}?${params.toString()}`;
}

// ---- Table export --------------------------------------------------------

function visibleCells(artifact: ArtifactOf<"table">): {
  header: string[];
  rows: string[][];
} {
  const header = artifact.columns.map((c) => c.label);
  const rows = artifact.rows.map((row) =>
    artifact.columns.map((c) => formatCell(row.cells[c.key] ?? null, c.format)),
  );
  return { header, rows };
}

/** Tab-separated text — what spreadsheets expect from the clipboard. */
export function tableToTsv(artifact: ArtifactOf<"table">): string {
  const { header, rows } = visibleCells(artifact);
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, " ");
  return [header, ...rows].map((line) => line.map(clean).join("\t")).join("\n");
}

/** RFC 4180 CSV — quoted, with doubled quotes, for the download button. */
export function tableToCsv(artifact: ArtifactOf<"table">): string {
  const { header, rows } = visibleCells(artifact);
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [header, ...rows].map((line) => line.map(quote).join(",")).join("\r\n");
}

/** Safe-ish filename stem from an artifact title. */
export function fileStem(title: string, fallback: string): string {
  const stem = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || fallback;
}
