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
