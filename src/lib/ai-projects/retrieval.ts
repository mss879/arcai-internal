import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { openaiEmbed } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { RETRIEVAL_MAX_CHUNKS, RETRIEVAL_THRESHOLD, type RetrievedChunk } from "./chat-core";
import { recordUsage } from "./usage";

type DB = SupabaseClient<Database>;

/**
 * Retrieval (0126): the question → the nearest ready chunks of ONE project.
 *
 * One embedding call (metered as `retrieval`) and one RPC. Never throws: a
 * retrieval that fails leaves the agent answering without context, which
 * the prompt tells it to admit, rather than leaving the visitor with no
 * answer at all.
 */

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  embeddingTokens: number;
  costUsd: number;
  error: string | null;
};

export async function retrieveChunks(
  db: DB,
  opts: {
    projectId: string;
    query: string;
    conversationId?: string | null;
    billable?: boolean;
    limit?: number;
    threshold?: number;
  },
): Promise<RetrievalResult> {
  const started = Date.now();
  const query = opts.query.trim().slice(0, 2_000);
  if (!query) return { chunks: [], embeddingTokens: 0, costUsd: 0, error: null };

  let vector: number[];
  let embeddingTokens = 0;
  let costUsd = 0;
  try {
    const embedded = await openaiEmbed([query]);
    vector = embedded.vectors[0] ?? [];
    embeddingTokens = embedded.totalTokens;
    const usage = await recordUsage(db, {
      projectId: opts.projectId,
      conversationId: opts.conversationId ?? null,
      kind: "embedding",
      purpose: "retrieval",
      model: embedded.model,
      promptTokens: embedded.totalTokens,
      cachedTokens: 0,
      completionTokens: 0,
      billable: opts.billable ?? true,
      latencyMs: Date.now() - started,
    });
    costUsd = usage.costUsd;
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/retrieval/embed", meta: { project: opts.projectId } });
    return { chunks: [], embeddingTokens, costUsd, error: e instanceof Error ? e.message : "Embedding failed." };
  }
  if (!vector.length) return { chunks: [], embeddingTokens, costUsd, error: "Embedding returned no vector." };

  const { data, error } = await db.rpc("match_ai_chunks", {
    p_project_id: opts.projectId,
    query_embedding: vector,
    match_threshold: opts.threshold ?? RETRIEVAL_THRESHOLD,
    match_count: Math.min(RETRIEVAL_MAX_CHUNKS, Math.max(1, opts.limit ?? RETRIEVAL_MAX_CHUNKS)),
  });
  if (error) {
    await captureError(new Error(`match_ai_chunks failed: ${error.message}`), {
      source: "route",
      path: "ai/retrieval/match",
      meta: { project: opts.projectId },
    });
    return { chunks: [], embeddingTokens, costUsd, error: error.message };
  }

  const chunks: RetrievedChunk[] = (data ?? []).map((row) => ({
    title: row.title,
    url: row.url,
    content: row.content,
    similarity: Number(row.similarity) || 0,
  }));
  return { chunks, embeddingTokens, costUsd, error: null };
}

/** Does the project have anything to retrieve from? */
export async function hasReadySources(db: DB, projectId: string): Promise<boolean> {
  const { count } = await db
    .from("ai_kb_sources")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "ready");
  return (count ?? 0) > 0;
}
