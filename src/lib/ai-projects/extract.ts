import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { openaiVisionJSON, type ChatUsage } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";

import { recordUsage } from "./usage";

type DB = SupabaseClient<Database>;

/**
 * File → text (0126). What an uploaded knowledge file becomes before it is
 * chunked: plain text and markdown as they are, PDFs through `unpdf` (the
 * same reader the project document brief uses), images described by a
 * vision model and metered as `describe`. Anything else is refused with a
 * sentence rather than indexed as garbage.
 */

export const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "text/html"]);
export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export type ExtractResult = { ok: true; text: string } | { ok: false; error: string };

function kindOf(mime: string, name: string): "text" | "pdf" | "image" | "unknown" {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (IMAGE_MIMES.has(mime) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (TEXT_MIMES.has(mime) || ["txt", "md", "markdown", "csv", "html", "htm"].includes(ext)) return "text";
  return "unknown";
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n");
}

export async function extractText(
  db: DB,
  projectId: string,
  input: { bytes: Uint8Array; mime: string; name: string },
): Promise<ExtractResult> {
  const kind = kindOf(input.mime, input.name);
  if (kind === "unknown") {
    return { ok: false, error: "Only text, Markdown, CSV, HTML, PDF and image files can be added to the knowledge base." };
  }
  if (input.bytes.byteLength > FILE_MAX_BYTES) return { ok: false, error: "Files must be under 10 MB." };

  if (kind === "text") {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
    const text = input.mime === "text/html" || /\.html?$/i.test(input.name) ? htmlToText(raw) : raw;
    return text.trim() ? { ok: true, text } : { ok: false, error: "The file is empty." };
  }

  if (kind === "pdf") {
    try {
      const { extractText: readPdf, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(input.bytes);
      const { text } = await readPdf(pdf, { mergePages: true });
      const clean = (text ?? "").trim();
      if (!clean) return { ok: false, error: "No text could be read from the PDF — it may be scanned images. Export it as text first." };
      return { ok: true, text: clean };
    } catch (e) {
      return { ok: false, error: `Could not read the PDF: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Image: describe it, transcribe any text, meter the call.
  if (input.bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, error: "Images must be under 4 MB." };
  const mime = IMAGE_MIMES.has(input.mime) ? input.mime : "image/png";
  const dataUri = `data:${mime};base64,${Buffer.from(input.bytes).toString("base64")}`;
  const started = Date.now();
  let usage: ChatUsage | null = null;
  let model = process.env.OPENAI_VISION_MODEL?.trim() || "";
  try {
    const raw = await openaiVisionJSON(
      dataUri,
      'Describe this image for a customer-facing website assistant that will answer visitors\' questions, and transcribe any text in it exactly. Reply as JSON: {"description": string, "text": string}.',
      { onUsage: (u) => (usage = u), timeoutMs: 40_000 },
    );
    if (!model) model = "gpt-4o-mini";
    const parsed = JSON.parse(raw) as { description?: unknown; text?: unknown };
    const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
    const transcribed = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const text = [description && `Image description: ${description}`, transcribed && `Text in the image:\n${transcribed}`]
      .filter(Boolean)
      .join("\n\n");
    return text ? { ok: true, text } : { ok: false, error: "The model could not describe this image." };
  } catch (e) {
    return { ok: false, error: `Could not read the image: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    const u = usage as ChatUsage | null;
    if (u) {
      await recordUsage(db, {
        projectId,
        kind: "vision",
        purpose: "describe",
        model,
        promptTokens: u.promptTokens,
        cachedTokens: u.cachedTokens,
        completionTokens: u.completionTokens,
        latencyMs: Date.now() - started,
      });
    }
  }
}
