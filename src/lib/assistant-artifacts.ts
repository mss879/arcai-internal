/**
 * Artifacts — the things Arc SHOWS you, not just the things it tells you.
 *
 * A card (see `@/lib/assistant-cards`) is a small inline block in the
 * transcript, usually something to confirm. An *artifact* is a full document
 * for the preview canvas: a table of clients, a project record, a month of
 * finance, a live PDF, or an embedded page of the app itself. Any tool can
 * return one, and the assistant workspace opens it in the pane beside the
 * conversation so the answer is visible instead of merely spoken.
 *
 * Framework-free and server-safe on purpose (no React, no "server-only") so
 * the server tools and the client UI can share one definition — exactly like
 * `assistant-cards.ts`.
 */

import type {
  AssistantCard,
  InvoiceCardData,
  ProposalCardData,
} from "@/lib/assistant-cards";

/** How a value should be rendered. */
export type ArtifactFormat =
  | "text"
  | "money"
  | "number"
  | "percent"
  | "date"
  | "datetime"
  | "status"
  | "email"
  | "phone"
  | "url"
  | "multiline";

/** Colour intent for pills, deltas and chart bars. */
export type ArtifactTone =
  | "neutral"
  | "positive"
  | "warning"
  | "danger"
  | "info";

export type ArtifactCell = string | number | boolean | null;

export type ArtifactColumn = {
  key: string;
  label: string;
  format?: ArtifactFormat;
  align?: "left" | "right" | "center";
  /** Dropped first when the preview pane is narrow. */
  secondary?: boolean;
};

export type ArtifactRow = {
  /** Stable key. Falls back to the row index when absent. */
  id?: string;
  /** In-app route this row opens (e.g. "/projects/abc"). */
  href?: string;
  /** Colour hint for the row's status cell. */
  tone?: ArtifactTone;
  cells: Record<string, ArtifactCell>;
};

export type ArtifactField = {
  label: string;
  value: ArtifactCell;
  format?: ArtifactFormat;
  tone?: ArtifactTone;
  /** Change vs. the previous period, already computed. */
  delta?: number;
  href?: string;
};

/**
 * A button on an artifact. `href` navigates inside the app; `prompt` sends
 * the text back to Arc as if the user had typed it (so an artifact can offer
 * "Email this to the client" without inventing a second API).
 */
export type ArtifactAction = {
  label: string;
  href?: string;
  prompt?: string;
  /** Lucide icon name, e.g. "Mail" — the UI maps a known subset. */
  icon?: string;
  tone?: ArtifactTone;
};

/** The nav areas an artifact can belong to — drives its icon and accent. */
export type AppArea =
  | "dashboard"
  | "clients"
  | "todos"
  | "projects"
  | "delivery"
  | "website"
  | "crm"
  | "automation"
  | "finance"
  | "intelligence"
  | "meetings"
  | "payments"
  | "invoices"
  | "notices"
  | "proposals"
  | "pricing"
  | "sms"
  | "whatsapp"
  | "content"
  | "resources"
  | "team"
  | "workspace";

type ArtifactBase = {
  /** Unique within a conversation; used as the preview tab key. */
  id: string;
  title: string;
  subtitle?: string;
  /** The page in the app this artifact came from. */
  href?: string;
  area?: AppArea;
  actions?: ArtifactAction[];
  /** One-line plain-English gloss shown under the title. */
  summary?: string;
};

export type Artifact =
  /** Rows and columns — any list the assistant looked up. */
  | (ArtifactBase & {
      kind: "table";
      columns: ArtifactColumn[];
      rows: ArtifactRow[];
      /** Rows that exist beyond the ones included, if the query was capped. */
      truncated?: number;
      total_label?: string;
      total_value?: ArtifactCell;
      total_format?: ArtifactFormat;
      footnote?: string;
    })
  /** One entity in detail. */
  | (ArtifactBase & {
      kind: "record";
      fields: ArtifactField[];
      groups?: { label: string; fields: ArtifactField[] }[];
      /** Free prose (notes, a brief, a description). */
      body?: string;
    })
  /** A row of headline numbers. */
  | (ArtifactBase & { kind: "metrics"; metrics: ArtifactField[] })
  /** A small chart drawn as inline SVG — no chart library. */
  | (ArtifactBase & {
      kind: "chart";
      chart: "bar" | "line" | "donut";
      points: { label: string; value: number; tone?: ArtifactTone }[];
      format?: ArtifactFormat;
    })
  /** Dated events, newest first. */
  | (ArtifactBase & {
      kind: "timeline";
      entries: {
        when: string;
        label: string;
        detail?: string;
        tone?: ArtifactTone;
        href?: string;
      }[];
    })
  /** Prose / markdown-ish body (a brief, a draft, an explanation). */
  | (ArtifactBase & { kind: "text"; body: string })
  /**
   * A real page of the app, embedded in the preview pane via `?embed=1`
   * (which strips the sidebar, topbar and assistant). This is what lets Arc
   * literally show you the CRM board or a project instead of describing it.
   */
  | (ArtifactBase & { kind: "page"; href: string })
  /** A saved invoice, previewed as the actual PDF the client receives. */
  | (ArtifactBase & { kind: "invoice"; invoice: InvoiceCardData })
  /** A saved proposal, previewed as the actual branded PDF. */
  | (ArtifactBase & { kind: "proposal"; proposal: ProposalCardData });

export type ArtifactKind = Artifact["kind"];

// ---- Constructors --------------------------------------------------------
// Terse helpers so tool code reads as data, not plumbing.

let seq = 0;
/** Unique-per-process artifact id with a readable prefix. */
export function artifactId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString(36)}-${Date.now().toString(36)}`;
}

export function tableArtifact(
  input: Omit<Extract<Artifact, { kind: "table" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "table", id: id ?? artifactId("table"), ...rest };
}

export function recordArtifact(
  input: Omit<Extract<Artifact, { kind: "record" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "record", id: id ?? artifactId("record"), ...rest };
}

export function metricsArtifact(
  input: Omit<Extract<Artifact, { kind: "metrics" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "metrics", id: id ?? artifactId("metrics"), ...rest };
}

export function chartArtifact(
  input: Omit<Extract<Artifact, { kind: "chart" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "chart", id: id ?? artifactId("chart"), ...rest };
}

export function timelineArtifact(
  input: Omit<Extract<Artifact, { kind: "timeline" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "timeline", id: id ?? artifactId("timeline"), ...rest };
}

export function textArtifact(
  input: Omit<Extract<Artifact, { kind: "text" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "text", id: id ?? artifactId("text"), ...rest };
}

export function pageArtifact(
  input: Omit<Extract<Artifact, { kind: "page" }>, "kind" | "id"> & {
    id?: string;
  },
): Artifact {
  const { id, ...rest } = input;
  return { kind: "page", id: id ?? artifactId("page"), ...rest };
}

/**
 * Build a table artifact from plain rows: `columns` describes the shape and
 * `pick` maps each source row to its cells (plus an optional href/tone).
 */
export function rowsToTable<T>(
  rows: T[],
  columns: ArtifactColumn[],
  pick: (row: T, index: number) => Omit<ArtifactRow, "id"> & { id?: string },
): ArtifactRow[] {
  return rows.map((row, i) => {
    const built = pick(row, i);
    return { id: built.id ?? String(i), ...built };
  });
}

// ---- Cards that are also documents ---------------------------------------

/**
 * A card is a small block in the transcript; an artifact is the full document
 * in the preview canvas. A proposal and an invoice are BOTH — you want the
 * summary next to the conversation and the real PDF beside it. These two
 * helpers are the single bridge between the pair, so the id is derived the
 * same way everywhere.
 */

function rs(amount: number): string {
  const v = Number.isFinite(amount) ? amount : 0;
  return "Rs. " + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The canvas id for a card that is also a document, or null for a card that
 * is only a confirmation (an SMS has nothing to preview).
 *
 * Derived from the SAVED ROW's id rather than generated. That is what makes
 * "make it 140 thousand" replace the proposal tab already open instead of
 * stacking a second, nearly identical one — `update_proposal` writes the same
 * row, so it produces the same id.
 */
export function cardArtifactId(card: AssistantCard): string | null {
  switch (card.type) {
    case "proposal":
      return card.proposal.id ? `proposal-${card.proposal.id}` : null;
    case "invoice":
    case "confirm_send":
      return card.invoice.id ? `invoice-${card.invoice.id}` : null;
    default:
      return null;
  }
}

/**
 * Promote a card to its preview-canvas artifact, or null when it has no
 * document behind it.
 *
 * Tools do not have to send the same payload twice: returning the card is
 * enough, and the client promotes it. Any tool that DOES send an artifact for
 * one of these should use `cardArtifactId()` for its id so the two collapse
 * into one tab rather than opening two.
 */
export function cardToArtifact(card: AssistantCard): Artifact | null {
  const id = cardArtifactId(card);
  if (!id) return null;

  if (card.type === "proposal") {
    const p = card.proposal;
    return {
      kind: "proposal",
      id,
      title: `Proposal — ${p.client_name || p.project_name || "draft"}`,
      subtitle: p.package_summary,
      summary: `${p.project_name || "Proposal"} · ${rs(p.grand_total)} one-time`,
      href: "/proposals",
      area: "proposals",
      proposal: p,
    };
  }

  // Narrowing: `cardArtifactId` already excluded the SMS card, but the
  // compiler cannot see through a helper's return value.
  if (card.type !== "invoice" && card.type !== "confirm_send") return null;

  const inv = card.invoice;
  return {
    kind: "invoice",
    id,
    title: `Invoice ${inv.invoice_number || ""}`.trim(),
    subtitle: inv.bill_to_name || undefined,
    summary:
      inv.due_today > 0 && inv.due_today !== inv.grand_total
        ? `${rs(inv.grand_total)} total · ${rs(inv.due_today)} due today`
        : rs(inv.grand_total),
    href: "/invoices",
    area: "invoices",
    invoice: inv,
  };
}
