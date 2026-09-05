import "server-only";

import { PROJECT_EXPENSE_CATEGORIES } from "@/lib/constants";
import { isOpenAIConfigured, openaiVisionJSON } from "@/lib/ai/openai";

/**
 * Read a supplier receipt into an expense (MON-8).
 *
 * The same image understanding the WhatsApp onboarding agent already uses on
 * client assets, pointed at the bill instead. It drafts — it never saves: the
 * team sees the parsed fields in the form and corrects anything wrong before
 * anything is written, because a misread amount that goes straight onto an
 * invoice is worse than typing it out.
 */

export type ParsedReceipt = {
  vendor: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
  /** ISO date, or null when the receipt doesn't show one legibly. */
  date: string | null;
  category: string | null;
  /** The model's own confidence, so the UI can say "check this". */
  confidence: "high" | "low";
};

const CATEGORY_VALUES = PROJECT_EXPENSE_CATEGORIES.map((c) => c.value);

const PROMPT = `You are reading a supplier receipt or invoice for a digital agency in Sri Lanka.

Return STRICT JSON with exactly these keys:
{
  "vendor": string|null,        // who was paid, e.g. "Envato", "AWS", "Dialog"
  "description": string|null,   // 3-6 words naming what was bought, invoice-ready
  "amount": number|null,        // the TOTAL paid, digits only, no currency symbol or separators
  "currency": string|null,      // ISO code if visible: "LKR", "USD", "GBP"
  "date": string|null,          // YYYY-MM-DD, only if a date is clearly legible
  "category": string|null,      // one of: ${CATEGORY_VALUES.join(", ")}
  "confidence": "high"|"low"    // "low" if the image is blurry, cropped, or you had to guess the total
}

Rules:
- The amount is the FINAL total actually paid, including tax — not a subtotal or a line item.
- Never invent a value. If something is not legible, use null.
- If this does not look like a receipt or invoice at all, return every field null and confidence "low".
- Output JSON only.`;

/**
 * Parse a receipt image.
 *
 * `imageUrl` may be a data: URL — the form sends the file it already has in
 * the browser rather than uploading first, so a receipt that turns out to be
 * unreadable never leaves a stray object in storage.
 */
export async function parseReceipt(imageUrl: string): Promise<ParsedReceipt | null> {
  if (!isOpenAIConfigured()) return null;

  try {
    const raw = await openaiVisionJSON(imageUrl, PROMPT, { timeoutMs: 45_000 });
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const amount = Number(parsed.amount);
    const date = typeof parsed.date === "string" ? parsed.date : null;

    return {
      vendor: str(parsed.vendor),
      description: str(parsed.description),
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      currency: str(parsed.currency)?.toUpperCase() ?? null,
      // Guard against a hallucinated date shape reaching a date input.
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      category:
        typeof parsed.category === "string" &&
        (CATEGORY_VALUES as readonly string[]).includes(parsed.category)
          ? parsed.category
          : null,
      confidence: parsed.confidence === "high" ? "high" : "low",
    };
  } catch (e) {
    console.error("[receipt] parse failed:", e);
    return null;
  }
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Bank-transfer slips (0120)
// ---------------------------------------------------------------------------

export type ParsedSlip = {
  amount: number | null;
  currency: string | null;
  /** The bank's transaction / reference number, as printed. */
  reference: string | null;
  bank: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** The account holder who paid, when the slip names them. */
  payer: string | null;
  confidence: "high" | "low";
};

const SLIP_PROMPT = `You are reading a bank transfer slip, deposit slip or payment confirmation screenshot sent by a customer in Sri Lanka to pay an invoice.

Return STRICT JSON with exactly these keys:
{
  "amount": number|null,      // the amount TRANSFERRED, digits only, no currency symbol or separators
  "currency": string|null,    // ISO code if visible: "LKR", "USD", "GBP"
  "reference": string|null,   // the bank's transaction / reference / receipt number, exactly as printed
  "bank": string|null,        // the sending bank, e.g. "Commercial Bank", "Sampath", "HNB"
  "date": string|null,        // YYYY-MM-DD, only if clearly legible
  "payer": string|null,       // the name of the account holder who paid, if shown
  "confidence": "high"|"low"  // "low" if blurry, cropped, or you had to guess the amount
}

Rules:
- The amount is what was TRANSFERRED — not a balance, not a fee, not an available-balance line.
- Never invent a value. If something is not legible, use null.
- If this is not a payment slip or transfer confirmation at all, return every field null and confidence "low".
- Output JSON only.`;

/** Parse a slip image (a URL or a data: URL). Null when the reader isn't configured. */
export async function parseSlipImage(imageUrl: string): Promise<ParsedSlip | null> {
  if (!isOpenAIConfigured()) return null;
  try {
    const raw = await openaiVisionJSON(imageUrl, SLIP_PROMPT, { timeoutMs: 45_000 });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const amount = Number(parsed.amount);
    const date = typeof parsed.date === "string" ? parsed.date : null;
    return {
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      currency: str(parsed.currency)?.toUpperCase() ?? null,
      reference: str(parsed.reference),
      bank: str(parsed.bank),
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      payer: str(parsed.payer),
      confidence: parsed.confidence === "high" ? "high" : "low",
    };
  } catch (e) {
    console.error("[receipt] slip parse failed:", e);
    return null;
  }
}

/**
 * Parse a slip PDF from its text — no model, on purpose.
 *
 * Bank PDFs are machine-written, so the words are exact; a regex finds the
 * biggest money-looking figure and a reference line more reliably than a
 * model reads a screenshot, and it costs nothing. Everything is best-effort:
 * a human confirms before any of it becomes a payment.
 */
export function parseSlipText(text: string): ParsedSlip {
  const flat = text.replace(/\s+/g, " ");

  const amounts: number[] = [];
  const amountRe =
    /(?:LKR|Rs\.?|USD|GBP|\$|£)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?)/gi;
  for (const m of flat.matchAll(amountRe)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 100) amounts.push(n);
  }
  // A transfer slip prints the amount once or twice and a balance beside it;
  // the amount TRANSFERRED is almost never the largest figure on the page
  // when a balance is shown, but is when it isn't. Prefer a labelled amount.
  const labelled = flat.match(
    /(?:amount|transferred|transfer amount|paid|total)\s*[:\-]?\s*(?:LKR|Rs\.?|USD|GBP)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{3,}(?:\.\d{1,2})?)/i,
  );
  const amount = labelled
    ? Number(labelled[1].replace(/,/g, ""))
    : amounts.length
      ? amounts[0]
      : null;

  const reference =
    flat.match(/(?:reference|ref\.?|transaction (?:id|no\.?)|txn(?: id)?|receipt no\.?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/]{4,})/i)?.[1] ??
    null;
  const bank =
    flat.match(
      /\b(Commercial Bank|Sampath|HNB|Hatton National|Bank of Ceylon|BOC|People'?s Bank|NDB|DFCC|Seylan|Nations Trust|NTB|Union Bank|Pan Asia|Cargills|Amana|HSBC|Standard Chartered)\b/i,
    )?.[1] ?? null;
  const dateMatch =
    flat.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/) ??
    flat.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2})\b/);
  let date: string | null = null;
  if (dateMatch) {
    const [a, b, c] = dateMatch.slice(1).map(Number);
    const [y, mo, d] = a > 31 ? [a, b, c] : [c, b, a];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const currency = /\bUSD\b|\$/.test(flat) ? "USD" : /\bGBP\b|£/.test(flat) ? "GBP" : /\bLKR\b|Rs\.?/i.test(flat) ? "LKR" : null;

  return {
    amount: amount && Number.isFinite(amount) && amount > 0 ? amount : null,
    currency,
    reference,
    bank,
    date,
    payer: null,
    confidence: amount && reference ? "high" : "low",
  };
}
