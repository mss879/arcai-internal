import { describe, expect, it } from "vitest";

import { aggregateByModel, compactTokens, composeAiInvoice, type AiInvoiceInput } from "./billing-core";

const base: AiInvoiceInput = {
  period: "2026-09-01",
  agentName: "Ava",
  websiteUrl: "https://client.lk",
  conversations: 42,
  models: [
    { model: "gpt-5.6-luna", calls: 120, input_tokens: 150_000, cached_input_tokens: 60_000, output_tokens: 30_000, cost_usd: 0.0552 },
    { model: "text-embedding-3-small", calls: 120, input_tokens: 4_000, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0.00008 },
  ],
  embeddingTokens: 4_000,
  fee: 0,
  markup: 1,
  minimum: 0,
  currency: "USD",
  fxLkrPerUsd: null,
  wasActive: true,
};

describe("composeAiInvoice", () => {
  it("passes exact cost through at markup 1 with no fee", () => {
    const res = composeAiInvoice(base);
    if (!res.ok) throw new Error(res.error);
    expect(res.skip).toBe(false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.item).toBe("AI Assistant — usage, September 2026");
    expect(res.usageUsd).toBe(0.05528);
    expect(res.grandTotal).toBe(0.06);
    expect(res.items[0]?.description).toContain("42 conversations");
    expect(res.items[0]?.description).toContain("154k input / 60k cached / 30k output tokens");
    expect(res.items[0]?.description).not.toMatch(/\$|usd/i);
  });

  it("applies the markup to usage only, never to the fee", () => {
    const res = composeAiInvoice({ ...base, fee: 50, markup: 2.5 });
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.total)).toEqual([50, 0.14]);
    expect(res.billedUsageUsd).toBe(0.1382);
    expect(res.grandTotal).toBe(50.14);
  });

  it("converts the usage line to LKR at the project's rate, rounding per line", () => {
    const res = composeAiInvoice({ ...base, fee: 15_000, markup: 3, currency: "LKR", fxLkrPerUsd: 305.5 });
    if (!res.ok) throw new Error(res.error);
    // 0.05528 × 3 × 305.5 = 50.664… → 50.66
    expect(res.items.map((i) => i.total)).toEqual([15_000, 50.66]);
    expect(res.grandTotal).toBe(15_050.66);
    expect(res.fx).toBe(305.5);
  });

  it("refuses an LKR invoice without a rate", () => {
    const res = composeAiInvoice({ ...base, currency: "LKR", fxLkrPerUsd: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("LKR rate");
  });

  it("tops up to the minimum only when the project was active", () => {
    const active = composeAiInvoice({ ...base, minimum: 20 });
    if (!active.ok) throw new Error(active.error);
    expect(active.items.map((i) => i.total)).toEqual([0.06, 19.94]);
    expect(active.grandTotal).toBe(20);

    const paused = composeAiInvoice({ ...base, models: [], embeddingTokens: 0, minimum: 20, wasActive: false });
    if (!paused.ok) throw new Error(paused.error);
    expect(paused.skip).toBe(true);
  });

  it("invoices a fee-only month and skips an empty one", () => {
    const feeOnly = composeAiInvoice({ ...base, models: [], embeddingTokens: 0, fee: 30 });
    if (!feeOnly.ok) throw new Error(feeOnly.error);
    expect(feeOnly.skip).toBe(false);
    expect(feeOnly.items).toHaveLength(1);
    expect(feeOnly.grandTotal).toBe(30);

    const empty = composeAiInvoice({ ...base, models: [], embeddingTokens: 0 });
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.skip).toBe(true);
    expect(empty.items).toEqual([]);
  });

  it("rejects a negative markup", () => {
    expect(composeAiInvoice({ ...base, markup: -1 }).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("compacts token counts", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(1_234)).toBe("1.2k");
    expect(compactTokens(154_000)).toBe("154k");
    expect(compactTokens(2_500_000)).toBe("2.50M");
  });

  it("aggregates usage rows by model, most expensive first", () => {
    const { models, embeddingTokens } = aggregateByModel([
      { model: "a", kind: "chat", input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, cost_usd: 0.001 },
      { model: "a", kind: "chat", input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, cost_usd: 0.002 },
      { model: "e", kind: "embedding", input_tokens: 7, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0.000001 },
    ]);
    expect(models.map((m) => m.model)).toEqual(["a", "e"]);
    expect(models[0]).toMatchObject({ calls: 2, input_tokens: 20, cached_input_tokens: 2, output_tokens: 10, cost_usd: 0.003 });
    expect(embeddingTokens).toBe(7);
  });
});
