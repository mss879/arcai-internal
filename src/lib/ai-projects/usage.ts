import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiUsageKind, AiUsagePurpose, AiUsageStatus, Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { costUsd, priceFor, type PriceQuote, type PriceRow } from "./pricing-core";
import { colomboDay, monthStart } from "./time-core";

type DB = SupabaseClient<Database>;

/**
 * The usage ledger's one writer (0126).
 *
 * Every model call — a reply, a retrieval embedding, an ingest batch, an
 * image description — becomes one `ai_usage_events` row through
 * `recordUsage`, priced from the catalog in force on the Colombo day it
 * happened and carrying those unit prices on the row. A row that cannot be
 * priced (a model missing from the catalog) is still written, at cost 0,
 * and the gap is reported once through `captureError` so it gets fixed
 * rather than silently under-billed forever.
 */

const CATALOG_TTL_MS = 5 * 60_000;
let catalogMemo: { at: number; rows: PriceRow[] } | null = null;

/** The whole catalog, memoised for five minutes. */
export async function loadPriceCatalog(db: DB): Promise<PriceRow[]> {
  if (catalogMemo && Date.now() - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.rows;
  const { data } = await db.from("ai_model_prices").select("*").order("effective_from", { ascending: false });
  const rows: PriceRow[] = (data ?? []).map((r) => ({
    id: r.id,
    model: r.model,
    kind: r.kind,
    input_per_m: Number(r.input_per_m) || 0,
    cached_input_per_m: Number(r.cached_input_per_m) || 0,
    output_per_m: Number(r.output_per_m) || 0,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    is_active: r.is_active,
  }));
  catalogMemo = { at: Date.now(), rows };
  return rows;
}

/** Called after a price edit so the editing instance re-prices at once. */
export function invalidatePriceCatalog(): void {
  catalogMemo = null;
}

export type UsageInput = {
  projectId: string;
  conversationId?: string | null;
  messageId?: string | null;
  kind: AiUsageKind;
  purpose: AiUsagePurpose;
  model: string;
  /** As the API reports it — includes the cached tokens. */
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  billable?: boolean;
  status?: AiUsageStatus;
  latencyMs?: number | null;
  error?: string | null;
  at?: Date;
};

export type UsageRecord = {
  id: string | null;
  costUsd: number;
  /** False when the catalog had no row for the model that day. */
  priced: boolean;
  quote: PriceQuote | null;
};

export async function recordUsage(db: DB, input: UsageInput): Promise<UsageRecord> {
  const at = input.at ?? new Date();
  const day = colomboDay(at);
  const period = monthStart(day);

  let quote: PriceQuote | null = null;
  try {
    quote = priceFor(await loadPriceCatalog(db), input.model, day);
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/usage/catalog", meta: { model: input.model } });
  }
  const tokens = {
    promptTokens: input.promptTokens,
    cachedTokens: input.cachedTokens,
    completionTokens: input.completionTokens,
  };
  const cost = quote ? costUsd(tokens, quote) : 0;

  const { data, error } = await db
    .from("ai_usage_events")
    .insert({
      project_id: input.projectId,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      kind: input.kind,
      purpose: input.purpose,
      model: input.model,
      input_tokens: Math.max(0, Math.floor(input.promptTokens) || 0),
      cached_input_tokens: Math.max(0, Math.floor(input.cachedTokens) || 0),
      output_tokens: Math.max(0, Math.floor(input.completionTokens) || 0),
      input_price_per_m: quote?.inputPerM ?? null,
      cached_price_per_m: quote?.cachedPerM ?? null,
      output_price_per_m: quote?.outputPerM ?? null,
      price_row_id: quote?.rowId ?? null,
      cost_usd: cost,
      billable: input.billable ?? true,
      status: input.status ?? "complete",
      day,
      period,
      latency_ms: input.latencyMs ?? null,
      error: input.error ?? null,
      created_at: at.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    await captureError(new Error(`ai_usage_events insert failed: ${error.message}`), {
      source: "route",
      path: "ai/usage",
      meta: { project: input.projectId, model: input.model, kind: input.kind },
    });
    return { id: null, costUsd: cost, priced: Boolean(quote), quote };
  }
  if (!quote) {
    // Fingerprinted by message, so one model missing from the catalog is
    // one notification, not one per call.
    await captureError(new Error(`No catalog price for model "${input.model}" — usage recorded at $0`), {
      source: "route",
      path: "ai/usage/unpriced",
      meta: { model: input.model, day },
    });
  }
  return { id: data.id, costUsd: cost, priced: Boolean(quote), quote };
}

/** Recompute one project-day's rollups. Best-effort: never throws. */
export async function rollupDay(db: DB, projectId: string, day: string): Promise<void> {
  try {
    const { error } = await db.rpc("ai_usage_rollup_day", { p_project_id: projectId, p_day: day });
    if (error) throw new Error(error.message);
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/rollup", meta: { project: projectId, day } });
  }
}

/** Sum a conversation's ledger onto its row. Best-effort. */
export async function refreshConversationTotals(db: DB, conversationId: string): Promise<void> {
  try {
    const { data } = await db
      .from("ai_usage_events")
      .select("cost_usd, input_tokens, output_tokens")
      .eq("conversation_id", conversationId);
    const rows = data ?? [];
    const cost = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const tokens = rows.reduce((s, r) => s + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0), 0);
    await db
      .from("ai_conversations")
      .update({ total_cost_usd: Math.round(cost * 1e6) / 1e6, total_tokens: tokens })
      .eq("id", conversationId);
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/conversation-totals", meta: { conversation: conversationId } });
  }
}
