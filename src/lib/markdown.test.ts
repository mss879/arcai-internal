import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  markdownToHtml,
  markdownToText,
  parseMarkdown,
} from "./markdown";

describe("escapeHtml", () => {
  it("escapes everything that can break out of markup", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });
});

describe("parseMarkdown", () => {
  it("reads headings by level", () => {
    expect(parseMarkdown("# One\n## Two\n### Three")).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 3, text: "Three" },
    ]);
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", text: "one two" },
      { kind: "paragraph", text: "three" },
    ]);
  });

  it("reads bullet and numbered lists, and keeps them apart", () => {
    expect(parseMarkdown("- a\n- b\n\n1. x\n2. y")).toEqual([
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["x", "y"] },
    ]);
  });

  it("ends a list when prose follows, rather than swallowing the sentence", () => {
    expect(parseMarkdown("- a\nThis is not a bullet.")).toEqual([
      { kind: "list", ordered: false, items: ["a"] },
      { kind: "paragraph", text: "This is not a bullet." },
    ]);
  });

  it("reads a horizontal rule", () => {
    expect(parseMarkdown("---")).toEqual([{ kind: "rule" }]);
  });

  it("returns nothing for nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("markdownToHtml", () => {
  it("escapes before adding markup, so HTML in the source is inert", () => {
    // A document somebody signs must not be able to carry a script.
    const html = markdownToHtml('<img src=x onerror="alert(1)">');
    expect(html).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
    expect(html).not.toContain("<img");
  });

  it("renders bold, italic and code", () => {
    expect(markdownToHtml("**bold** and *soft* and `code`")).toBe(
      "<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>",
    );
  });

  it("does not read a bold run as nested italics", () => {
    expect(markdownToHtml("**two words**")).toBe("<p><strong>two words</strong></p>");
  });

  it("renders lists with the right tag", () => {
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("escapes inside list items too", () => {
    expect(markdownToHtml("- <b>x</b>")).toBe("<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>");
  });
});

describe("markdownToText", () => {
  it("strips the markup and keeps the words", () => {
    expect(markdownToText("# Title\n\n**Bold** text\n\n- one\n- two")).toBe(
      "Title\n\nBold text\n\n· one\n· two",
    );
  });
});
