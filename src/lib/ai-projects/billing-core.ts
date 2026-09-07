import type { InvoiceItem } from "@/lib/database.types";

import { round2, round6 } from "./pricing-core";
import { periodLabel } from "./time-core";

/**
 * The monthly bill, composed (0126).
 *
 * What a month of usage becomes on an invoice. Pure and pinned by tests,
 * because the number at the bottom is one a client pays and the ways it can
 * be wrong — a markup applied twice, an FX rate applied to the fee, a
 * rounding that drifts a cent — are all silent.
 *
 * The terms (owner's decisions):
 *   total = fee + (usage cost in USD × markup, converted to the billing
 *           currency) and, when that comes to less than the monthly minimum
 *           on a month the project was live, topped up to the minimum.
 *   fee and minimum are in the billing currency already; only the usage
 *   line crosses from USD, at the project's own rate for LKR.
 *
 * The client's invoice never prints the provider cost or the markup. The
 * usage line says what was used — conversations and tokens — and the
 * per-model USD breakdown stays on the `ai_invoices` row for the agency.
 */

export type ModelAggregate = {
  model: string;
  calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type AiInvoiceInput = {
  /** YYYY-MM-01. */
  period: string;
  agentName: string;
  websiteUrl: string | null;
  conversations: number;
  models: ModelAggregate[];
  /** Tokens spent on embeddings (retrieval + ingest); already inside `models`' cost. */
  embeddingTokens: number;
  fee: number;
  markup: number;
  minimum: number;
  currency: "USD" | "LKR";
  fxLkrPerUsd: number | null;
  /** Was the project live at any point in the period? The minimum applies only then. */
  wasActive: boolean;
};

export type AiInvoiceTokens = {
  input: number;
  cached: number;
  output: number;
  embedding: number;
};

export type AiInvoiceComposition =
  | {
      ok: true;
      /** Nothing to bill: no fee, no usage, no applicable minimum. */
      skip: boolean;
      items: InvoiceItem[];
      grandTotal: number;
      /** Σ cost_usd over the month, before markup. */
      usageUsd: number;
      /** usageUsd × markup, still USD. */
      billedUsageUsd: number;
      currency: "USD" | "LKR";
      fx: number | null;
      tokens: AiInvoiceTokens;
      modelBreakdown: ModelAggregate[];
    }
  | { ok: false; error: string };

/** 12,345 → "12.3k"; 950 → "950". Tokens on an invoice line, readable. */
export function compactTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 2 : 1)}M`;
}

/** The words on the usage line. Never a dollar figure. */
export function usageDescription(input: AiInvoiceInput, tokens: AiInvoiceTokens): string {
  const models = Array.from(new Set(input.models.filter((m) => m.calls > 0).map((m) => m.model))).sort();
  const parts = [
    `${input.conversations.toLocaleString("en-US")} conversation${input.conversations === 1 ? "" : "s"}`,
    `${compactTokens(tokens.input)} input / ${compactTokens(tokens.cached)} cached / ${compactTokens(tokens.output)} output tokens`,
  ];
  if (models.length) parts.push(models.join(", "));
  return parts.join(" · ");
}

export function composeAiInvoice(input: AiInvoiceInput): AiInvoiceComposition {
  const label = periodLabel(input.period);
  const fee = round2(Math.max(0, Number(input.fee) || 0));
  const minimum = round2(Math.max(0, Number(input.minimum) || 0));
  const markup = Number(input.markup);
  if (!Number.isFinite(markup) || markup < 0) {
    return { ok: false, error: "The usage markup must be a number of at least 0." };
  }

  const usageUsd = round6(input.models.reduce((sum, m) => sum + (Number(m.cost_usd) || 0), 0));
  const billedUsageUsd = round6(usageUsd * markup);

  let fx: number | null = null;
  if (input.currency === "LKR") {
    fx = Number(input.fxLkrPerUsd);
    if (!Number.isFinite(fx) || fx <= 0) {
      return { ok: false, error: "Set the LKR rate (LKR per USD) on the project before raising an LKR invoice." };
    }
  }

  const tokens: AiInvoiceTokens = {
    input: input.models.reduce((s, m) => s + (Number(m.input_tokens) || 0), 0),
    cached: input.models.reduce((s, m) => s + (Number(m.cached_input_tokens) || 0), 0),
    output: input.models.reduce((s, m) => s + (Number(m.output_tokens) || 0), 0),
    embedding: Math.max(0, Number(input.embeddingTokens) || 0),
  };

  const minimumApplies = minimum > 0 && input.wasActive;
  if (fee === 0 && usageUsd === 0 && !minimumApplies) {
    return {
      ok: true,
      skip: true,
      items: [],
      grandTotal: 0,
      usageUsd,
      billedUsageUsd,
      currency: input.currency,
      fx,
      tokens,
      modelBreakdown: input.models,
    };
  }

  const where = `${input.agentName || "AI Assistant"}${input.websiteUrl ? ` on ${input.websiteUrl}` : ""}`;
  const items: InvoiceItem[] = [];

  if (fee > 0) {
    items.push({
      item: "AI Assistant — monthly fee",
      description: `${label} · ${where}`,
      qty: "1",
      rate: String(fee),
      total: fee,
    });
  }

  const usageAmount = round2(billedUsageUsd * (fx ?? 1));
  if (usageUsd > 0) {
    items.push({
      item: `AI Assistant — usage, ${label}`,
      description: usageDescription(input, tokens),
      qty: "1",
      rate: String(usageAmount),
      total: usageAmount,
    });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  if (minimumApplies && subtotal < minimum) {
    const topUp = round2(minimum - subtotal);
    items.push({
      item: "Minimum monthly charge adjustment",
      description: `Brings ${label} up to the agreed monthly minimum`,
      qty: "1",
      rate: String(topUp),
      total: topUp,
    });
  }

  const grandTotal = round2(items.reduce((s, i) => s + i.total, 0));
  return {
    ok: true,
    skip: false,
    items,
    grandTotal,
    usageUsd,
    billedUsageUsd,
    currency: input.currency,
    fx,
    tokens,
    modelBreakdown: input.models,
  };
}

/** Fold usage rows (one per model) into the aggregate shape the composer takes. */
export function aggregateByModel(
  rows: readonly {
    model: string;
    kind: string;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }[],
): { models: ModelAggregate[]; embeddingTokens: number } {
  const byModel = new Map<string, ModelAggregate>();
  let embeddingTokens = 0;
  for (const r of rows) {
    if (r.kind === "embedding") embeddingTokens += Number(r.input_tokens) || 0;
    const agg = byModel.get(r.model) ?? {
      model: r.model,
      calls: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    agg.calls += 1;
    agg.input_tokens += Number(r.input_tokens) || 0;
    agg.cached_input_tokens += Number(r.cached_input_tokens) || 0;
    agg.output_tokens += Number(r.output_tokens) || 0;
    agg.cost_usd = round6(agg.cost_usd + (Number(r.cost_usd) || 0));
    byModel.set(r.model, agg);
  }
  return {
    models: Array.from(byModel.values()).sort((a, b) => b.cost_usd - a.cost_usd),
    embeddingTokens,
  };
}
