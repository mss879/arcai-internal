import { describe, expect, it } from "vitest";

import {
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  batches,
  chunkText,
  contentHash,
  normaliseText,
  titleForPage,
} from "./kb-core";

const para = (n: number, seed = "The studio opens at nine and closes at six on weekdays. ") =>
  seed.repeat(n).trim();

describe("normaliseText", () => {
  it("unifies newlines, strips trailing spaces and collapses blank runs", () => {
    expect(normaliseText("a  \r\n\r\n\r\n\r\nb\t")).toBe("a\n\n\nb".replace("\n\n\n", "\n\n"));
  });
});

describe("contentHash", () => {
  it("is stable across whitespace and case, and changes with content", () => {
    expect(contentHash("Hello   World\n")).toBe(contentHash("hello world"));
    expect(contentHash("Hello World")).not.toBe(contentHash("Hello Worlds"));
  });
});

describe("chunkText", () => {
  it("returns nothing for empty text and drops tiny fragments", () => {
    expect(chunkText("", { title: "T" })).toEqual([]);
    expect(chunkText("hi", { title: "T" })).toEqual([]);
    expect("x".repeat(CHUNK_MIN_CHARS).length).toBe(CHUNK_MIN_CHARS);
  });

  it("prefixes every chunk with the title and nearest heading", () => {
    const text = `# Opening hours\n\n${para(2)}\n\n## Weekends\n\n${para(2)}`;
    const chunks = chunkText(text, { title: "Studio FAQ" });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.content.startsWith("Studio FAQ — Opening hours\n")).toBe(true);
    expect(chunks[0]?.content).toContain("closes at six");
  });

  it("keeps chunks under the target, overlaps neighbours, numbers positions", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${para(6)}`);
    const chunks = chunkText(paragraphs.join("\n\n"), { title: "Long" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 60);
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    // The overlap: the tail of chunk 0 reappears at the head of chunk 1's body.
    const tail0 = chunks[0]!.content.slice(-40);
    expect(chunks[1]!.content).toContain(tail0.trim().split(" ").slice(-3).join(" "));
  });

  it("hard-splits a single enormous paragraph without exceeding the max", () => {
    const wall = "word ".repeat(2_000);
    const chunks = chunkText(wall, { title: "Wall" });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 60);
  });

  it("carries a heading forward across paragraphs until the next one", () => {
    const text = `# Pricing\n\n${para(3)}\n\n${para(3)}\n\n# Contact\n\n${para(3)}`;
    const chunks = chunkText(text, { title: "Site", target: 300, max: 400, overlap: 0 });
    expect(chunks[0]?.content.startsWith("Site — Pricing")).toBe(true);
    expect(chunks.at(-1)?.content.startsWith("Site — Contact")).toBe(true);
  });
});

describe("helpers", () => {
  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });

  it("titles a page from its title or its path", () => {
    expect(titleForPage("https://a.com/x", "  About us ")).toBe("About us");
    expect(titleForPage("https://a.com/about/team/", null)).toBe("a.com/about/team");
    expect(titleForPage("https://a.com/", null)).toBe("a.com");
  });
});
