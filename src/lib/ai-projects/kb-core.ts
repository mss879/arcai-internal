import { createHash } from "node:crypto";

/**
 * Text → chunks (0126).
 *
 * What a knowledge source becomes before it is embedded. Pure so the rules
 * can be pinned by tests: the sizes, the overlap, the breadcrumb every chunk
 * carries, and the hash that decides whether a re-crawled page changed.
 *
 * Chunks are ~1,600 characters (roughly 400 tokens) with a 200-character
 * overlap so a fact that straddles a boundary survives in one of the two.
 * Splitting follows the document's own structure first — headings, blank
 * lines — then sentences, and only then a hard cut, because a chunk that
 * begins mid-sentence embeds badly and reads worse in a prompt.
 */

export const CHUNK_TARGET_CHARS = 1_600;
export const CHUNK_OVERLAP_CHARS = 200;
export const CHUNK_MAX_CHARS = 2_200;
export const CHUNK_MIN_CHARS = 40;
export const MAX_CHUNKS_PER_SOURCE = 400;
/** A source larger than this is truncated; nothing a chat agent needs is
 * longer than a short book. */
export const MAX_SOURCE_CHARS = 200_000;

export type KbChunk = {
  position: number;
  content: string;
  tokenEstimate: number;
};

/** Unix newlines, tabs to spaces, no trailing whitespace, no runs of blank lines. */
export function normaliseText(text: string): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The fingerprint a re-crawl compares. Whitespace and case are folded so a
 * page that re-rendered with different indentation is still "unchanged" and
 * costs no embedding tokens.
 */
export function contentHash(text: string): string {
  const folded = normaliseText(text).replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(folded).digest("hex");
}

/** Roughly four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

type Block = { heading: string | null; text: string };

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** Paragraphs, each tagged with the nearest markdown heading above it. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    const lines = p.split("\n");
    const first = lines[0] ?? "";
    const m = first.match(HEADING_RE);
    if (m) {
      heading = (m[1] ?? "").trim() || null;
      const rest = lines.slice(1).join("\n").trim();
      if (rest) blocks.push({ heading, text: rest });
      continue;
    }
    blocks.push({ heading, text: p });
  }
  return blocks;
}

/** Sentences first, then a hard cut, never above `max`. */
function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      if (current.trim()) out.push(current.trim());
      current = "";
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > max) {
      if (current.trim()) out.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The last `n` characters, cut at a word boundary. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const slice = text.slice(-n);
  const space = slice.indexOf(" ");
  return space === -1 ? slice : slice.slice(space + 1);
}

/**
 * Split a source into chunks. Every chunk opens with a breadcrumb line —
 * the source title and the nearest heading — so a chunk read on its own in
 * a prompt still says what it is about, and the model can cite it.
 */
export function chunkText(
  text: string,
  opts: { title: string; target?: number; overlap?: number; max?: number },
): KbChunk[] {
  const target = opts.target ?? CHUNK_TARGET_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP_CHARS;
  const max = Math.max(target, opts.max ?? CHUNK_MAX_CHARS);
  const title = (opts.title ?? "").trim() || "Untitled";

  const norm = normaliseText(text).slice(0, MAX_SOURCE_CHARS);
  if (!norm) return [];

  // A block is cut small enough that the overlap carried in from the
  // previous chunk still leaves the whole under `max`.
  const blockMax = Math.max(CHUNK_MIN_CHARS * 4, max - overlap - 2);
  const blocks = splitBlocks(norm).flatMap((b) =>
    b.text.length > blockMax ? splitLong(b.text, blockMax).map((t) => ({ heading: b.heading, text: t })) : [b],
  );

  const chunks: KbChunk[] = [];
  let body = "";
  let heading: string | null = null;
  let carry = "";

  const flush = () => {
    const trimmed = body.trim();
    if (trimmed.length >= CHUNK_MIN_CHARS) {
      const crumb = heading ? `${title} — ${heading}` : title;
      const content = `${crumb}\n${trimmed}`;
      chunks.push({ position: chunks.length, content, tokenEstimate: estimateTokens(content) });
    }
    carry = trimmed ? tail(trimmed, overlap) : "";
    body = "";
  };

  for (const block of blocks) {
    const candidate = body ? `${body}\n\n${block.text}` : block.text;
    if (body && candidate.length > target) {
      flush();
      heading = block.heading;
      body = carry ? `${carry}\n\n${block.text}` : block.text;
    } else {
      if (!body) heading = block.heading;
      body = candidate;
    }
    if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
  }
  if (chunks.length < MAX_CHUNKS_PER_SOURCE) flush();

  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
}

/** Batches of at most `size` for the embeddings API. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A title for a page from what the crawl returned, else its URL's path. */
export function titleForPage(url: string, title: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (t) return t.slice(0, 200);
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return (path ? `${u.hostname}${path}` : u.hostname).slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}
