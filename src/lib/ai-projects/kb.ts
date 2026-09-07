import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { EMBED_BATCH_MAX, OpenAIRateLimitError, openaiEmbed } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { batches, chunkText, contentHash } from "./kb-core";
import { recordUsage } from "./usage";

type DB = SupabaseClient<Database>;

/**
 * The knowledge base's one writer (0126).
 *
 * A source (pasted text, an uploaded file, a page, a crawled page) holds its
 * extracted text; `ingestSource` turns that into chunks and embeddings. It
 * runs inline from the Knowledge tab's "Add" actions and from the `aiIngest`
 * tick pass, and it is resumable: chunks are written in embedding batches
 * and `chunk_count` advances with them, so a run cut off by the platform
 * carries on from where it stopped instead of paying for the same
 * embeddings twice. The resume is keyed by the content hash — text that
 * changed starts over.
 */

/** Sources per tick. Each may take a few embedding calls. */
export const INGEST_MAX_PER_TICK = 3;
/** A source stuck in `processing` this long was killed mid-run; free it. */
export const PROCESSING_STALE_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const CHUNK_INSERT_BATCH = 50;

export type IngestResult =
  | { ok: true; sourceId: string; chunks: number; tokens: number; complete: boolean }
  | { ok: false; sourceId: string; error: string; retry: boolean };

async function markFailed(db: DB, sourceId: string, error: string): Promise<void> {
  await db.from("ai_kb_sources").update({ status: "failed", error: error.slice(0, 500) }).eq("id", sourceId);
}

/**
 * Chunk and embed one pending source. `deadline` (ms epoch) bounds the run;
 * past it the source goes back to `pending` with its progress kept.
 */
export async function ingestSource(
  db: DB,
  sourceId: string,
  opts: { deadline?: number } = {},
): Promise<IngestResult> {
  const deadline = opts.deadline ?? Date.now() + 18_000;

  const { data: before } = await db.from("ai_kb_sources").select("*").eq("id", sourceId).maybeSingle();
  if (!before) return { ok: false, sourceId, error: "That source no longer exists.", retry: false };
  if (before.status !== "pending") return { ok: false, sourceId, error: `Source is ${before.status}, not pending.`, retry: false };

  // Claim: the status filter makes a second caller's update a no-op.
  const { data: claimed } = await db
    .from("ai_kb_sources")
    .update({ status: "processing", error: null, attempts: before.attempts + 1 })
    .eq("id", sourceId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!claimed) return { ok: false, sourceId, error: "Another run has this source.", retry: false };

  const text = before.content ?? "";
  if (!text.trim()) {
    await markFailed(db, sourceId, "No text could be read from this source.");
    return { ok: false, sourceId, error: "No text could be read from this source.", retry: false };
  }

  const hash = contentHash(text);
  const chunks = chunkText(text, { title: before.title });
  if (!chunks.length) {
    await markFailed(db, sourceId, "The text was too short to index.");
    return { ok: false, sourceId, error: "The text was too short to index.", retry: false };
  }

  // Resume when the same text was partly indexed by a run that was cut off.
  let start = 0;
  if (before.content_hash === hash && before.chunk_count > 0) {
    const { count } = await db.from("ai_kb_chunks").select("id", { count: "exact", head: true }).eq("source_id", sourceId);
    start = Math.min(count ?? 0, chunks.length);
    if (start < (count ?? 0)) {
      await db.from("ai_kb_chunks").delete().eq("source_id", sourceId).gte("position", start);
    }
  } else {
    await db.from("ai_kb_chunks").delete().eq("source_id", sourceId);
    await db.from("ai_kb_sources").update({ content_hash: hash, chunk_count: 0, embedding_tokens: 0 }).eq("id", sourceId);
  }

  let written = start;
  let tokens = 0;
  try {
    for (const group of batches(chunks.slice(start), EMBED_BATCH_MAX)) {
      if (Date.now() > deadline) {
        await db.from("ai_kb_sources").update({ status: "pending", chunk_count: written }).eq("id", sourceId);
        return { ok: true, sourceId, chunks: written, tokens, complete: false };
      }
      const embedded = await openaiEmbed(group.map((c) => c.content));
      tokens += embedded.totalTokens;
      await recordUsage(db, {
        projectId: before.project_id,
        kind: "embedding",
        purpose: "ingest",
        model: embedded.model,
        promptTokens: embedded.totalTokens,
        cachedTokens: 0,
        completionTokens: 0,
      });
      const rows = group.map((c, i) => ({
        project_id: before.project_id,
        source_id: sourceId,
        position: c.position,
        content: c.content,
        token_estimate: c.tokenEstimate,
        embedding: embedded.vectors[i]!,
      }));
      for (const slice of batches(rows, CHUNK_INSERT_BATCH)) {
        const { error } = await db.from("ai_kb_chunks").insert(slice);
        if (error) throw new Error(`chunk insert failed: ${error.message}`);
      }
      written += group.length;
      await db
        .from("ai_kb_sources")
        .update({ chunk_count: written, embedding_tokens: before.embedding_tokens + tokens })
        .eq("id", sourceId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof OpenAIRateLimitError) {
      // Not the source's fault: back to the queue, attempts untouched.
      await db.from("ai_kb_sources").update({ status: "pending", attempts: before.attempts, chunk_count: written, error: "Rate-limited by OpenAI; will retry." }).eq("id", sourceId);
      return { ok: false, sourceId, error: message, retry: true };
    }
    await captureError(e, { source: "tick", path: "ai/ingest", meta: { source: sourceId, project: before.project_id } });
    if (before.attempts + 1 >= MAX_ATTEMPTS) {
      await markFailed(db, sourceId, message);
      return { ok: false, sourceId, error: message, retry: false };
    }
    await db.from("ai_kb_sources").update({ status: "pending", chunk_count: written, error: message.slice(0, 500) }).eq("id", sourceId);
    return { ok: false, sourceId, error: message, retry: true };
  }

  await db
    .from("ai_kb_sources")
    .update({
      status: "ready",
      chunk_count: written,
      embedding_tokens: before.embedding_tokens + tokens,
      content_hash: hash,
      error: null,
      last_seen_at: before.last_seen_at ?? new Date().toISOString(),
    })
    .eq("id", sourceId);
  return { ok: true, sourceId, chunks: written, tokens, complete: true };
}

export type IngestPassResult = { processed: number; completed: number; failed: number; freed: number };

/**
 * The `aiIngest` tick pass: free anything a killed run left in
 * `processing`, then work through pending sources, oldest first, inside a
 * small budget. Never throws — it runs beside thirty other passes.
 */
export async function processAiIngest(db: DB, now = new Date()): Promise<IngestPassResult> {
  const result: IngestPassResult = { processed: 0, completed: 0, failed: 0, freed: 0 };
  const budgetEnd = now.getTime() + 6_000;
  try {
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS).toISOString();
    const { data: freed } = await db
      .from("ai_kb_sources")
      .update({ status: "pending" })
      .eq("status", "processing")
      .lt("updated_at", staleBefore)
      .select("id");
    result.freed = freed?.length ?? 0;

    const { data: pending } = await db
      .from("ai_kb_sources")
      .select("id, project_id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(INGEST_MAX_PER_TICK * 3);
    if (!pending?.length) return result;

    // Skip archived projects' sources: nothing will ever read them.
    const projectIds = Array.from(new Set(pending.map((p) => p.project_id)));
    const { data: projects } = await db.from("ai_projects").select("id, status").in("id", projectIds);
    const live = new Set((projects ?? []).filter((p) => p.status !== "archived").map((p) => p.id));

    for (const source of pending.filter((p) => live.has(p.project_id)).slice(0, INGEST_MAX_PER_TICK)) {
      if (Date.now() > budgetEnd) break;
      const res = await ingestSource(db, source.id, { deadline: budgetEnd });
      result.processed += 1;
      if (res.ok && res.complete) result.completed += 1;
      if (!res.ok && !res.retry) result.failed += 1;
      if (res.ok && !res.complete) break;
    }
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/ingest-pass" });
  }
  return result;
}

/** Remove a source and its chunks. */
export async function deleteSource(db: DB, sourceId: string): Promise<{ filePath: string | null }> {
  const { data } = await db.from("ai_kb_sources").select("file_path").eq("id", sourceId).maybeSingle();
  await db.from("ai_kb_chunks").delete().eq("source_id", sourceId);
  await db.from("ai_kb_sources").delete().eq("id", sourceId);
  return { filePath: data?.file_path ?? null };
}
