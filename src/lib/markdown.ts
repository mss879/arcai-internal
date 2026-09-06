/**
 * A deliberately small Markdown subset, for text a client will sign.
 *
 * Agreements and knowledge-base pages are written by the team in a textarea
 * and rendered in three places: a public page, a PDF, and a preview. Pulling
 * in a full Markdown library for that would bring HTML passthrough with it —
 * and the whole point of storing Markdown rather than HTML is that a document
 * somebody signs must not be able to contain a script, an iframe or a link
 * dressed up as something else.
 *
 * So: headings, paragraphs, bullet and numbered lists, bold, italic, inline
 * code, and horizontal rules. Everything else is text. Every value is escaped
 * BEFORE any markup is added, so there is no path from input to raw HTML.
 *
 * Pure and dependency-free — the PDF renderer consumes the block form, the web
 * pages consume the HTML.
 */

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

/** HTML-escape. Single quotes too: these values reach attribute contexts. */
export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parse into blocks. Never throws: anything unrecognised is a paragraph,
 * because a contract that fails to render is worse than one that renders
 * plainly.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1].trim());
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(numbered[1].trim());
      continue;
    }

    // A plain line continues the paragraph. A line inside a list that isn't a
    // bullet ends the list — otherwise a stray sentence disappears into it.
    flushList();
    paragraph.push(line.trim());
  }
  flush();

  return blocks;
}

/**
 * One run of inline text and the marks on it.
 *
 * Blocks were never the whole story: `parseMarkdown` leaves `**like this**`
 * sitting in the text, which was fine while only `markdownToHtml` consumed it
 * — and wrong the moment the PDF renderer did, because a contract then printed
 * its own asterisks while the signing page showed bold. Both now read the same
 * tokens, so the document somebody signs and the document that gets filed are
 * marked up identically.
 */
export type InlineToken = {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
};

/** Split the runs that match `re`, adding `mark` to the pieces inside it. */
function markRuns(
  runs: InlineToken[],
  re: RegExp,
  mark: "bold" | "italic" | "code",
): InlineToken[] {
  const out: InlineToken[] = [];
  for (const run of runs) {
    // An already-marked run is not re-scanned for the same mark.
    if (run[mark]) {
      out.push(run);
      continue;
    }
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(run.text); m; m = re.exec(run.text)) {
      if (m.index > last) out.push({ ...run, text: run.text.slice(last, m.index) });
      out.push({ ...run, text: m[1], [mark]: true });
      last = m.index + m[0].length;
    }
    if (last < run.text.length) out.push({ ...run, text: run.text.slice(last) });
  }
  return out;
}

/**
 * Parse inline marks out of one line of text.
 *
 * The order matters and is the order this has always used: bold before italic,
 * or `**word**` is read as an italic inside an italic. Code sits between them
 * so a backtick span is found before its contents can be italicised.
 */
export function parseInline(source: string): InlineToken[] {
  let runs: InlineToken[] = [
    { text: String(source ?? ""), bold: false, italic: false, code: false },
  ];
  runs = markRuns(runs, /\*\*([^*]+)\*\*/g, "bold");
  runs = markRuns(runs, /`([^`]+)`/g, "code");
  // Not preceded by a `*`, so the leftovers of an unmatched bold run don't
  // become a stray italic.
  runs = markRuns(runs, /(?<!\*)\*([^*]+)\*/g, "italic");
  return runs.filter((r) => r.text !== "");
}

/** Inline formatting as HTML. Every value is escaped before markup is added. */
function inline(raw: string): string {
  return parseInline(raw)
    .map((t) => {
      let html = escapeHtml(t.text);
      if (t.code) html = `<code>${html}</code>`;
      if (t.italic) html = `<em>${html}</em>`;
      if (t.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

/** Render to HTML. Safe to inject: every value was escaped before markup. */
export function markdownToHtml(source: string): string {
  const out: string[] = [];
  for (const block of parseMarkdown(source)) {
    switch (block.kind) {
      case "heading":
        out.push(`<h${block.level}>${inline(block.text)}</h${block.level}>`);
        break;
      case "paragraph":
        out.push(`<p>${inline(block.text)}</p>`);
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items
          .map((i) => `<li>${inline(i)}</li>`)
          .join("");
        out.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case "rule":
        out.push("<hr />");
        break;
    }
  }
  return out.join("\n");
}

/** Strip the markup, for a preview line or a plain-text email. */
export function markdownToText(source: string): string {
  return parseMarkdown(source)
    .map((b) => {
      if (b.kind === "rule") return "";
      if (b.kind === "list") return b.items.map((i) => `· ${i}`).join("\n");
      return b.text;
    })
    .filter(Boolean)
    .join("\n\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
