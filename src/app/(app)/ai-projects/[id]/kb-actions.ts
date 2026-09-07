"use server";

import { revalidatePath } from "next/cache";

import { firecrawlScrape, isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import { extractText, FILE_MAX_BYTES } from "@/lib/ai-projects/extract";
import { deleteSource as removeSource, ingestSource } from "@/lib/ai-projects/kb";
import { MAX_SOURCE_CHARS, titleForPage } from "@/lib/ai-projects/kb-core";
import { retrieveChunks } from "@/lib/ai-projects/retrieval";
import { scheduleNext } from "@/lib/ai-projects/crawl-core";
import { requireAdmin } from "@/lib/auth";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import type { ActionResult } from "@/lib/types";

/**
 * The Knowledge tab's actions (0126). Each "add" writes the source and then
 * indexes it inline inside the page's own window (`maxDuration = 60`); a
 * big file that runs out of time goes back to `pending` and the `aiIngest`
 * tick finishes it within five minutes.
 */

const INLINE_MS = 18_000;

async function projectOrError(id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("ai_projects").select("id, status, website_url, crawl_interval_days, last_crawl_at").eq("id", id).maybeSingle();
  return { supabase, project: data };
}

function refresh(id: string) {
  revalidatePath(`/ai-projects/${id}`);
}

type AddResult = ActionResult<{ sourceId: string; complete: boolean; chunks: number }>;

async function indexInline(supabase: Awaited<ReturnType<typeof createClient>>, sourceId: string): Promise<AddResult> {
  const res = await ingestSource(supabase, sourceId, { deadline: Date.now() + INLINE_MS });
  if (!res.ok) {
    if (res.retry) return { ok: true, sourceId, complete: false, chunks: 0 };
    return { ok: false, error: res.error };
  }
  return { ok: true, sourceId, complete: res.complete, chunks: res.chunks };
}

export async function addTextSource(projectId: string, input: { title: string; text: string }): Promise<AddResult> {
  const admin = await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const title = input.title.trim().slice(0, 200);
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!title) return { ok: false, error: "Give this text a title, e.g. “Opening hours” or “Returns policy”." };
  if (text.length < 20) return { ok: false, error: "Paste at least a sentence or two." };
  if (text.length > MAX_SOURCE_CHARS) return { ok: false, error: `Keep one source under ${MAX_SOURCE_CHARS.toLocaleString("en-US")} characters — split it up.` };

  const { data, error } = await supabase
    .from("ai_kb_sources")
    .insert({ project_id: projectId, source_kind: "text", title, content: text, status: "pending", created_by: admin.id })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the text." };
  const res = await indexInline(supabase, data.id);
  refresh(projectId);
  return res;
}

export async function uploadKbFile(projectId: string, formData: FormData): Promise<AddResult> {
  const admin = await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) return { ok: false, error: "Pick a file first." };
  if (file.size > FILE_MAX_BYTES) return { ok: false, error: "That file is over 10 MB." };
  const title = String(formData.get("title") ?? "").trim().slice(0, 200) || file.name.slice(0, 200);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extracted = await extractText(supabase, projectId, { bytes, mime: file.type || "", name: file.name });
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
  const path = `${projectId}/${crypto.randomUUID()}-${safe}`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKETS.aiKnowledge)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  const { data, error } = await supabase
    .from("ai_kb_sources")
    .insert({
      project_id: projectId,
      source_kind: "file",
      title,
      file_path: path,
      mime: file.type || null,
      size_bytes: file.size,
      content: extracted.text.slice(0, MAX_SOURCE_CHARS),
      status: "pending",
      created_by: admin.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the file." };
  const res = await indexInline(supabase, data.id);
  refresh(projectId);
  return res;
}

function cleanUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export async function addUrlSource(projectId: string, input: { url: string }): Promise<AddResult> {
  const admin = await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  if (!isFirecrawlConfigured()) return { ok: false, error: "Reading web pages needs FIRECRAWL_API_KEY on the server." };
  const url = cleanUrl(input.url);
  if (!url) return { ok: false, error: "That doesn't look like a web address." };

  const page = await firecrawlScrape(url);
  if (!page || !page.markdown.trim()) return { ok: false, error: "That page could not be read — it may block crawlers or have no text." };

  const { data: existing } = await supabase.from("ai_kb_sources").select("id").eq("project_id", projectId).eq("url", url).maybeSingle();
  let sourceId: string;
  if (existing) {
    const { error } = await supabase
      .from("ai_kb_sources")
      .update({ title: titleForPage(url, page.title), content: page.markdown.slice(0, MAX_SOURCE_CHARS), content_hash: null, chunk_count: 0, status: "pending", error: null, last_seen_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    sourceId = existing.id;
  } else {
    const { data, error } = await supabase
      .from("ai_kb_sources")
      .insert({
        project_id: projectId,
        source_kind: "url",
        url,
        title: titleForPage(url, page.title),
        content: page.markdown.slice(0, MAX_SOURCE_CHARS),
        status: "pending",
        last_seen_at: new Date().toISOString(),
        created_by: admin.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Could not save the page." };
    sourceId = data.id;
  }
  const res = await indexInline(supabase, sourceId);
  refresh(projectId);
  return res;
}

export async function deleteKbSource(projectId: string, sourceId: string): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const { data: row } = await supabase.from("ai_kb_sources").select("id, project_id").eq("id", sourceId).maybeSingle();
  if (!row || row.project_id !== projectId) return { ok: false, error: "That source no longer exists." };
  const { filePath } = await removeSource(supabase, sourceId);
  if (filePath) await supabase.storage.from(STORAGE_BUCKETS.aiKnowledge).remove([filePath]);
  refresh(projectId);
  return { ok: true };
}

/** Re-read (for a page) and re-embed a source from scratch. */
export async function reindexKbSource(projectId: string, sourceId: string): Promise<AddResult> {
  await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const { data: row } = await supabase.from("ai_kb_sources").select("id, project_id, source_kind, url, status").eq("id", sourceId).maybeSingle();
  if (!row || row.project_id !== projectId) return { ok: false, error: "That source no longer exists." };
  if (row.status === "processing") return { ok: false, error: "It is being indexed right now." };

  const patch: Database["public"]["Tables"]["ai_kb_sources"]["Update"] = { status: "pending", content_hash: null, chunk_count: 0, error: null };
  if ((row.source_kind === "url" || row.source_kind === "crawl") && row.url) {
    if (!isFirecrawlConfigured()) return { ok: false, error: "Re-reading a page needs FIRECRAWL_API_KEY on the server." };
    const page = await firecrawlScrape(row.url);
    if (!page || !page.markdown.trim()) return { ok: false, error: "That page could not be read again." };
    patch.content = page.markdown.slice(0, MAX_SOURCE_CHARS);
    patch.title = titleForPage(row.url, page.title);
    patch.last_seen_at = new Date().toISOString();
  }
  const { error } = await supabase.from("ai_kb_sources").update(patch).eq("id", sourceId);
  if (error) return { ok: false, error: error.message };
  const res = await indexInline(supabase, sourceId);
  refresh(projectId);
  return res;
}

/** Manual (0), weekly (7) or fortnightly (14). The first scheduled crawl runs
 * on the next tick; later ones an interval after each finishes. */
export async function updateCrawlSchedule(projectId: string, intervalDays: number): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  if (![0, 7, 14].includes(intervalDays)) return { ok: false, error: "Pick manual, weekly or fortnightly." };
  if (intervalDays && !project.website_url) return { ok: false, error: "Set the project's website first (Overview tab)." };
  const now = new Date().toISOString();
  const next = intervalDays
    ? project.last_crawl_at
      ? scheduleNext(project.last_crawl_at, intervalDays)
      : now
    : null;
  const { error } = await supabase
    .from("ai_projects")
    .update({ crawl_interval_days: intervalDays || null, next_crawl_at: next && next < now ? now : next })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };
  refresh(projectId);
  return { ok: true };
}

export type RetrievalHit = { title: string; url: string | null; similarity: number; excerpt: string };

/** Ask the knowledge base a question and see what the agent would be given. */
export async function testRetrieval(projectId: string, question: string): Promise<ActionResult<{ hits: RetrievalHit[]; error: string | null }>> {
  await requireAdmin();
  const { supabase, project } = await projectOrError(projectId);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const q = question.trim();
  if (!q) return { ok: false, error: "Type a question first." };
  const res = await retrieveChunks(supabase, { projectId, query: q, billable: false });
  return {
    ok: true,
    error: res.error,
    hits: res.chunks.map((c) => ({
      title: c.title,
      url: c.url,
      similarity: Math.round(c.similarity * 100),
      excerpt: c.content.length > 400 ? `${c.content.slice(0, 400)}…` : c.content,
    })),
  };
}
