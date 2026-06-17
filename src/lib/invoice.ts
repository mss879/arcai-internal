/**
 * Static details printed on every invoice. Edit here to update them
 * everywhere — the generator only lets users change the date, invoice
 * number, "bill to" block, line items and amounts.
 */

export const INVOICE_COMPANY = {
  name: "ARC AI (PVT) LTD",
  phones: "+94771852522, +447466368427",
  email: "support@arcai.agency",
  website: "www.arcai.agency",
  addressLines: ["No 8, Milagiriya AV, Colombo 4, Sri Lanka", "Birmingham, UK"],
};

export const INVOICE_BANK = {
  bankName: "Commercial Bank",
  accountName: "Mohamed Shahid Shamir",
  accountNumber: "1106030714",
  branch: "Bambalapitiya",
};

export const INVOICE_SIGNOFF = {
  questionsLine:
    "FOR ANY QUESTIONS, PLEASE CONTACT SUPPORT@ARCAI.AGENCY OR +94771852522.",
  signerName: "M S SHAMIR",
  signerTitle: "DIRECTOR",
  /** Tight-cropped transparent PNG of the director's signature. */
  signatureImage: "/signature-mark.png",
};

export type InvoiceLineItem = {
  id: string;
  item: string;
  description: string;
  qty: string;
  rate: string;
  /** When true, the user typed the total directly; otherwise it's qty × rate. */
  totalManual: boolean;
  total: string;
};

/** A blank line item with a fresh id. */
export function emptyLineItem(): InvoiceLineItem {
  return {
    id: Math.random().toString(36).slice(2, 10),
    item: "",
    description: "",
    qty: "",
    rate: "",
    totalManual: false,
    total: "",
  };
}

/** The computed total for a row: the typed total, or qty × rate (qty defaults to 1). */
export function lineItemTotal(line: InvoiceLineItem): number {
  if (line.totalManual) return parseAmount(line.total);
  const rate = parseAmount(line.rate);
  const qty = line.qty.trim() === "" ? 1 : parseAmount(line.qty);
  return rate * qty;
}

/** Parse a loosely-typed money string ("60,000", "Rs. 60000") to a number. */
export function parseAmount(input: string): number {
  const n = Number(String(input).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
