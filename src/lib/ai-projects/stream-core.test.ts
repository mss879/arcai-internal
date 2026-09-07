import { describe, expect, it } from "vitest";

import { createSseParser, sseFrame, type AiStreamEvent } from "./stream-core";

describe("SSE framing", () => {
  it("round-trips a sequence of events", () => {
    const events: AiStreamEvent[] = [
      { type: "meta", conversation: "c1", session: "s1" },
      { type: "delta", text: "Hello " },
      { type: "delta", text: "there\n\nnew paragraph" },
      { type: "tool", name: "capture_lead", label: "Saving your details…" },
      { type: "action", kind: "booking", url: "https://cal.com/x" },
      { type: "done", reply: "Hello there" },
    ];
    const wire = events.map(sseFrame).join("");
    const parse = createSseParser();
    expect(parse(wire)).toEqual(events);
  });

  it("buffers a frame split across chunks and ignores garbage", () => {
    const parse = createSseParser();
    const frame = sseFrame({ type: "delta", text: "split" });
    const head = frame.slice(0, 10);
    const tail = frame.slice(10);
    expect(parse(head)).toEqual([]);
    expect(parse(tail)).toEqual([{ type: "delta", text: "split" }]);
    expect(parse("data: not json\n\n")).toEqual([]);
    expect(parse(": comment\n\n")).toEqual([]);
  });

  it("delivers an error frame intact", () => {
    const parse = createSseParser();
    const [event] = parse(sseFrame({ type: "error", code: "rate_limited", message: "slow down", retryAfter: 3 }));
    expect(event).toEqual({ type: "error", code: "rate_limited", message: "slow down", retryAfter: 3 });
  });
});
