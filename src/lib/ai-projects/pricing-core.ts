/**
 * Tokens → dollars (0126).
 *
 * The one place a token count becomes a cost. Prices come from the
 * `ai_model_prices` catalog — effective-dated rows, several per model when a
 * price changes — and the row chosen is recorded on the usage event with the
 * unit prices it carried, so a later catalog edit never rewrites history.
 *
 * Pure: the caller passes the catalog rows in.
 */

export type PriceRow = {
  id: string;
  model: string;
  kind: "chat" | "embedding";
  input_per_m: number;
  cached_input_per_m: number;
  output_per_m: number;
  /** YYYY-MM-DD, inclusive. */
  effective_from: string;
  /** YYYY-MM-DD, inclusive; null = open-ended. */
  effective_to: string | null;
  is_active: boolean;
};

/** The unit prices a call is costed with, USD per 1M tokens. */
export type PriceQuote = {
  rowId: string | null;
  inputPerM: number;
  cachedPerM: number;
  outputPerM: number;
};

export type TokenCounts = {
  /** As the API reports it — INCLUDES cachedTokens. */
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
};

/**
 * The catalog row in force for `model` on `day`.
 *
 * When several rows cover the day (a promo row ending and a list row
 * starting on adjacent dates leave no overlap, but a hand edit might), the
 * latest `effective_from` wins — the most recently decided price. Inactive
 * rows still price old usage; `is_active` only governs what the Agent tab
 * offers.
 */
export function priceFor(rows: readonly PriceRow[], model: string, day: string): PriceQuote | null {
  const name = model.trim().toLowerCase();
  const candidates = rows.filter(
    (r) =>
      r.model.trim().toLowerCase() === name &&
      r.effective_from <= day &&
      (!r.effective_to || r.effective_to >= day),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0));
  const row = candidates[0]!;
  return {
    rowId: row.id,
    inputPerM: Number(row.input_per_m) || 0,
    cachedPerM: Number(row.cached_input_per_m) || 0,
    outputPerM: Number(row.output_per_m) || 0,
  };
}

/** Six decimal places — the ledger column's own precision. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The cost of one call.
 *
 * `promptTokens` includes the cached ones, so the uncached remainder is
 * billed at the input price and the cached part at the cached price. A
 * cached count larger than the prompt (never seen, but cheap to guard)
 * is clamped rather than producing a negative charge.
 */
export function costUsd(tokens: TokenCounts, price: PriceQuote): number {
  const prompt = Math.max(0, Math.floor(tokens.promptTokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Math.floor(tokens.cachedTokens) || 0));
  const completion = Math.max(0, Math.floor(tokens.completionTokens) || 0);
  const usd =
    ((prompt - cached) * price.inputPerM + cached * price.cachedPerM + completion * price.outputPerM) /
    1_000_000;
  return round6(usd);
}

/** Roughly four characters per token — the estimate used when a call was cut
 * off before the API could report a count. Always an over-estimate for
 * English prose, which is the safe direction for a bill. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

/** The models a project may pick: active chat rows, one entry per model, with
 * today's prices for the dropdown. */
export function selectableModels(
  rows: readonly PriceRow[],
  day: string,
): { model: string; quote: PriceQuote }[] {
  const seen = new Set<string>();
  const out: { model: string; quote: PriceQuote }[] = [];
  for (const row of rows) {
    if (row.kind !== "chat" || !row.is_active) continue;
    if (seen.has(row.model)) continue;
    const quote = priceFor(rows, row.model, day);
    if (!quote) continue;
    seen.add(row.model);
    out.push({ model: row.model, quote });
  }
  return out.sort((a, b) => a.quote.inputPerM - b.quote.inputPerM || a.model.localeCompare(b.model));
}
