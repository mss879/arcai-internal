import { describe, expect, it } from "vitest";

import { costUsd, estimateTokens, priceFor, selectableModels, type PriceRow } from "./pricing-core";

const rows: PriceRow[] = [
  {
    id: "sol-promo",
    model: "gpt-5.6-sol",
    kind: "chat",
    input_per_m: 4,
    cached_input_per_m: 0.4,
    output_per_m: 20,
    effective_from: "2026-01-01",
    effective_to: "2026-11-21",
    is_active: true,
  },
  {
    id: "sol-list",
    model: "gpt-5.6-sol",
    kind: "chat",
    input_per_m: 5,
    cached_input_per_m: 0.5,
    output_per_m: 30,
    effective_from: "2026-11-22",
    effective_to: null,
    is_active: true,
  },
  {
    id: "luna",
    model: "gpt-5.6-luna",
    kind: "chat",
    input_per_m: 0.2,
    cached_input_per_m: 0.02,
    output_per_m: 1.2,
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
  },
  {
    id: "retired",
    model: "gpt-4o",
    kind: "chat",
    input_per_m: 2.5,
    cached_input_per_m: 1.25,
    output_per_m: 10,
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: false,
  },
  {
    id: "embed",
    model: "text-embedding-3-small",
    kind: "embedding",
    input_per_m: 0.02,
    cached_input_per_m: 0,
    output_per_m: 0,
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
  },
];

describe("priceFor", () => {
  it("picks the promo row up to its last day and the list row from the next", () => {
    expect(priceFor(rows, "gpt-5.6-sol", "2026-11-21")?.rowId).toBe("sol-promo");
    expect(priceFor(rows, "gpt-5.6-sol", "2026-11-22")?.rowId).toBe("sol-list");
    expect(priceFor(rows, "gpt-5.6-sol", "2026-09-07")?.inputPerM).toBe(4);
  });

  it("is null for an unknown model or a day before any row", () => {
    expect(priceFor(rows, "gpt-9", "2026-09-07")).toBeNull();
    expect(priceFor(rows, "gpt-5.6-luna", "2025-12-31")).toBeNull();
  });

  it("still prices a retired model's old usage", () => {
    expect(priceFor(rows, "GPT-4o", "2026-09-07")?.rowId).toBe("retired");
  });
});

describe("costUsd", () => {
  const luna = priceFor(rows, "gpt-5.6-luna", "2026-09-07")!;

  it("bills the cached part of the prompt at the cached price", () => {
    // 1000 prompt of which 400 cached, 200 completion.
    // (600 × 0.2 + 400 × 0.02 + 200 × 1.2) / 1e6 = (120 + 8 + 240) / 1e6
    expect(costUsd({ promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }, luna)).toBe(0.000368);
  });

  it("rounds to six decimals and never goes negative", () => {
    expect(costUsd({ promptTokens: 1, cachedTokens: 0, completionTokens: 0 }, luna)).toBe(0);
    expect(costUsd({ promptTokens: 10, cachedTokens: 50, completionTokens: 0 }, luna)).toBe(0);
  });

  it("prices an embedding call on input alone", () => {
    const embed = priceFor(rows, "text-embedding-3-small", "2026-09-07")!;
    expect(costUsd({ promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 }, embed)).toBe(0.02);
  });
});

describe("selectableModels", () => {
  it("lists active chat models once each, cheapest first, with today's price", () => {
    const list = selectableModels(rows, "2026-09-07");
    expect(list.map((m) => m.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(list[1]?.quote.rowId).toBe("sol-promo");
  });
});

describe("estimateTokens", () => {
  it("rounds chars/4 up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
