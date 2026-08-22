/**
 * Proposal / project → Invoice handoff.
 *
 * "Generate invoice" carries a customer and their priced line items across to
 * the invoice generator, so the invoice comes out of the branded template with
 * the real numbers instead of being retyped (and mistyped). Two screens hand
 * over today:
 *
 *   • a finished proposal — its client and priced sections;
 *   • a project's Additional expenses tab — the project's total value, each
 *     billable extra cost, and what the client has already paid.
 *
 * The screens are separate routes, so the draft rides in sessionStorage for
 * exactly one hop: the invoice page reads it once on mount and clears it.
 * Nothing is persisted — the invoice only becomes real when the team hits
 * Download, which saves it like any other invoice.
 */

export const INVOICE_HANDOFF_KEY = "arc:invoice-from-proposal";

/** Marks the /invoices visit as one that should pick the draft up. */
export const INVOICE_HANDOFF_PARAM = "from";
export const INVOICE_HANDOFF_SOURCE = "proposal";
export const INVOICE_HANDOFF_SOURCE_PROJECT = "project";

export type InvoiceHandoffItem = {
  item: string;
  description: string;
  total: number;
  /** Optional qty × rate, printed on the invoice when both are given. */
  qty?: string;
  rate?: string;
};

export type InvoiceHandoffDraft = {
  billToName: string;
  billToDetails: string;
  items: InvoiceHandoffItem[];
  /** Shown as a note so whoever finishes the invoice knows where it came from. */
  sourceLabel: string;
  /** Which screen handed over — only changes the wording of that note. */
  sourceKind?: "proposal" | "project";
  /**
   * Money already received against this job. Pre-fills "Amount already paid",
   * so the invoice's balance is the real balance, not the full total.
   */
  amountPaid?: number;
};

/** Stash a draft for the invoice generator to pick up on its next mount. */
export function stashInvoiceDraft(draft: InvoiceHandoffDraft): void {
  try {
    sessionStorage.setItem(INVOICE_HANDOFF_KEY, JSON.stringify(draft));
  } catch {
    // Private mode / storage disabled — the invoice page just opens blank.
  }
}

/** Read and consume the stashed draft. Returns null when there isn't one. */
export function takeInvoiceDraft(): InvoiceHandoffDraft | null {
  try {
    const raw = sessionStorage.getItem(INVOICE_HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(INVOICE_HANDOFF_KEY);
    const parsed = JSON.parse(raw) as InvoiceHandoffDraft;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}
