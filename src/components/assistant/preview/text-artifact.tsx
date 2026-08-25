"use client";

/**
 * The `text` artifact — prose Arc wrote: a brief, an explanation, a draft
 * message, a summary of a month.
 *
 * It renders a deliberately tiny subset of markdown by hand (`##` headings,
 * `-`/`•` bullets, `**bold**`) instead of pulling in a markdown package. Why:
 * the body comes from a language model, a full markdown renderer is a large
 * dependency plus an HTML-injection surface, and everything past this subset
 * (tables, images, raw HTML) is something the other artifact kinds already do
 * better and more safely.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import type { ArtifactOf } from "./artifact-format";

/** Split `**bold**` runs into plain and strong spans. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-slate-900">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>;
  });
}

type Block =
  | { type: "h3" | "h4" | "p"; text: string }
  | { type: "ul"; items: string[] };

/** Group raw lines into headings, bullet lists and paragraphs. */
function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushBullets = () => {
    if (bullets.length) blocks.push({ type: "ul", items: bullets });
    bullets = [];
  };
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushBullets();
      flushParagraph();
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushBullets();
      flushParagraph();
      blocks.push({ type: "h4", text: trimmed.slice(4) });
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushBullets();
      flushParagraph();
      blocks.push({ type: "h3", text: trimmed.slice(3) });
      continue;
    }
    if (/^([-•*])\s+/.test(trimmed)) {
      flushParagraph();
      bullets.push(trimmed.replace(/^([-•*])\s+/, ""));
      continue;
    }
    flushBullets();
    paragraph.push(trimmed);
  }
  flushBullets();
  flushParagraph();
  return blocks;
}

export type TextArtifactProps = {
  artifact: ArtifactOf<"text">;
  /** True when the pane is narrow; the measure tightens. */
  dense: boolean;
};

/**
 * Renders a `text` artifact as readable prose.
 *
 * The revise/copy affordances live in `<ArtifactToolbar>`, not here, so this
 * stays a pure renderer with no callbacks of its own.
 */
export function TextArtifact({
  artifact,
  dense,
}: TextArtifactProps): React.ReactElement {
  const blocks = React.useMemo(() => toBlocks(artifact.body), [artifact.body]);

  return (
    <div
      className={cn(
        "mx-auto text-[14px] leading-[1.7] text-slate-700",
        dense ? "max-w-full" : "max-w-[68ch]",
      )}
    >
      {blocks.map((block, i) => {
        if (block.type === "h3") {
          return (
            <h3
              key={i}
              className="mt-6 mb-2 text-[15px] font-semibold text-slate-900 first:mt-0"
            >
              {inline(block.text, `h3-${i}`)}
            </h3>
          );
        }
        if (block.type === "h4") {
          return (
            <h4
              key={i}
              className="mt-5 mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-slate-500 first:mt-0"
            >
              {inline(block.text, `h4-${i}`)}
            </h4>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={i} className="my-3 list-disc space-y-1.5 pl-5 marker:text-slate-300">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `li-${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="my-3 whitespace-pre-wrap first:mt-0">
            {inline(block.text, `p-${i}`)}
          </p>
        );
      })}
    </div>
  );
}
