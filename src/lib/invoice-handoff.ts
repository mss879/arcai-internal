/**
 * Proposal → Invoice handoff.
 *
 * "Generate invoice" on a finished proposal carries that proposal's customer
 * and its priced line items across to the invoice generator, so the invoice
 * comes out of the branded template with the proposal's own numbers instead
 * of being retyped (and mistyped).
 *
 * The two screens are separate routes, so the draft rides in sessionStorage
 * for exactly one hop: the invoice page reads it once on mount and clears it.
 * Nothing is persisted — the invoice only becomes real when the team hits
 * Download, which saves it like any other invoice.
 */

export const INVOICE_HANDOFF_KEY = "arc:invoice-from-proposal";

/** Marks the /invoices visit as one that should pick the draft up. */
export const INVOICE_HANDOFF_PARAM = "from";
export const INVOICE_HANDOFF_SOURCE = "proposal";

export type InvoiceHandoffItem = {
  item: string;
  description: string;
  total: number;
};

export type InvoiceHandoffDraft = {
  billToName: string;
  billToDetails: string;
  items: InvoiceHandoffItem[];
  /** Shown as a note so whoever finishes the invoice knows where it came from. */
  sourceLabel: string;
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
