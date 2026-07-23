import type { InvoiceItem } from "@/lib/database.types";

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

/**
 * The bank accounts an invoice can be paid into. The generator lets the user
 * pick one per invoice; the choice is stored on `invoices.bank_account` so a
 * re-download or emailed copy prints the same details. The first entry is the
 * default — it's what older invoices (saved before the picker existed) use.
 */
export const INVOICE_BANKS = [
  {
    id: "commercial",
    label: "Commercial Bank — Mohamed Shahid Shamir",
    bankName: "Commercial Bank",
    accountName: "Mohamed Shahid Shamir",
    accountNumber: "1106030714",
    branch: "Bambalapitiya",
  },
  {
    id: "nations-trust",
    label: "Nations Trust Bank — ARC AI PVT LTD",
    bankName: "Nations Trust Bank",
    accountName: "ARC AI PVT LTD",
    accountNumber: "100250017428",
    branch: "Havelock Branch",
  },
] as const;

export type InvoiceBank = (typeof INVOICE_BANKS)[number];
export type InvoiceBankId = InvoiceBank["id"];

export const DEFAULT_INVOICE_BANK_ID: InvoiceBankId = INVOICE_BANKS[0].id;

/** Resolve a stored bank id to its details, falling back to the default. */
export function invoiceBank(id: string | null | undefined): InvoiceBank {
  return INVOICE_BANKS.find((b) => b.id === id) ?? INVOICE_BANKS[0];
}

/** The default account — used wherever there's no per-invoice choice (e.g. WhatsApp replies). */
export const INVOICE_BANK = invoiceBank(DEFAULT_INVOICE_BANK_ID);

/* ------------------------------------------------------------------ */
/* Invoice numbering                                                    */
/* ------------------------------------------------------------------ */

/** Where the series starts when there isn't a single saved invoice yet. */
export const FIRST_INVOICE_NUMBER = "#00200";

type ParsedInvoiceNumber = {
  prefix: string;
  /** Zero-padded width of the numeric part, so "#00200" stays 5 digits wide. */
  width: number;
  value: number;
  suffix: string;
};

/** Split "#00200" into its "#" prefix and the 200 it counts from. */
function parseInvoiceNumber(raw: string): ParsedInvoiceNumber | null {
  const match = /^(.*?)(\d+)(\D*)$/.exec((raw ?? "").trim());
  if (!match) return null;
  return {
    prefix: match[1],
    width: match[2].length,
    value: Number(match[2]),
    suffix: match[3],
  };
}

/**
 * The next number in the series: the highest number across every past invoice,
 * plus one, formatted exactly like that highest one ("#00204" → "#00205").
 * Numbers that carry no digits at all are skipped, and an empty history starts
 * the series at FIRST_INVOICE_NUMBER.
 */
export function nextInvoiceNumber(existing: readonly string[]): string {
  let highest: ParsedInvoiceNumber | null = null;
  for (const raw of existing) {
    const parsed = parseInvoiceNumber(raw);
    if (!parsed) continue;
    if (!highest || parsed.value > highest.value) highest = parsed;
  }
  if (!highest) return FIRST_INVOICE_NUMBER;
  const next = String(highest.value + 1).padStart(highest.width, "0");
  return `${highest.prefix}${next}${highest.suffix}`;
}

export const INVOICE_SIGNOFF = {
  questionsLine:
    "FOR ANY QUESTIONS, PLEASE CONTACT SUPPORT@ARCAI.AGENCY OR +94771852522.",
  signerName: "M S SHAMIR",
  signerTitle: "DIRECTOR",
  /** Tight-cropped transparent PNG of the director's signature. */
  signatureImage: "/signature-mark.png",
};

/**
 * A "paid" rubber stamp slapped over the invoice. The original invoice carries
 * no stamp; once the client pays the deposit we re-issue it with "deposit_paid",
 * and once they settle in full with "payment_received". Stored as plain text on
 * `invoices.stamp` — `null`/absent means no stamp.
 */
export type InvoiceStamp = "deposit_paid" | "payment_received";

/** Choices shown in the generator's stamp picker ("none" = no stamp). */
export const INVOICE_STAMP_OPTIONS: {
  value: "none" | InvoiceStamp;
  label: string;
}[] = [
  { value: "none", label: "No stamp" },
  { value: "deposit_paid", label: "Deposit paid" },
  { value: "payment_received", label: "Payment received" },
];

/** Public image path for a stamp, or `null` when there's no stamp. */
export function stampImage(stamp: string | null | undefined): string | null {
  switch (stamp) {
    case "deposit_paid":
      return "/Deposit-paid.png";
    case "payment_received":
      return "/payment-recieved.png";
    default:
      return null;
  }
}

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

/**
 * Rebuild the generator's editable line items from a saved invoice snapshot.
 * The stored `total` is treated as authoritative (totalManual) so a loaded
 * invoice re-renders exactly as it was saved.
 */
export function lineItemsFromSaved(items: InvoiceItem[]): InvoiceLineItem[] {
  return (items ?? []).map((it, i) => ({
    id: `${i}-${Math.random().toString(36).slice(2, 8)}`,
    item: it.item ?? "",
    description: it.description ?? "",
    qty: it.qty ?? "",
    rate: it.rate ?? "",
    totalManual: true,
    total: String(it.total ?? 0),
  }));
}

/** Parse a loosely-typed money string ("60,000", "Rs. 60000") to a number. */
export function parseAmount(input: string): number {
  const n = Number(String(input).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
