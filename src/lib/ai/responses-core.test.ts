import { describe, expect, it } from "vitest";

import {
  isPreviousResponseError,
  isUnknownModelError,
  isUnsupportedParamError,
  parseResponseBody,
  readResponsesUsage,
  safeJsonParse,
  toChatUsage,
} from "./responses-core";

/**
 * The Responses wire format is not the Chat Completions one, and every
 * difference is a silent failure: text read from the wrong field is null,
 * usage read from the wrong field meters every agent call at $0.
 */

const completed = {
  id: "resp_1",
  status: "completed",
  model: "gpt-6-astra",
  output: [
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "sri lanka sme ai adoption 2026" },
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: '{"summary":"ok"}',
          annotations: [
            { type: "url_citation", url: "https://a.example/x", title: "A" },
            { type: "url_citation", url: "https://a.example/x", title: "A again" },
            { type: "url_citation", url: "https://b.example/y", title: "B" },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 120 },
  },
};

describe("parseResponseBody", () => {
  it("reads text, citations (deduplicated) and web searches", () => {
    const r = parseResponseBody(completed);
    expect(r.status).toBe("completed");
    expect(r.text).toBe('{"summary":"ok"}');
    expect(r.citations).toEqual([
      { url: "https://a.example/x", title: "A" },
      { url: "https://b.example/y", title: "B" },
    ]);
    expect(r.webSearchCalls).toEqual([
      { id: "ws_1", status: "completed", query: "sri lanka sme ai adoption 2026" },
    ]);
    expect(r.functionCalls).toEqual([]);
  });

  it("reads function calls with their call_id and raw arguments", () => {
    const r = parseResponseBody({
      id: "resp_2",
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_brand_profile", arguments: "{}" },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "list_recent_posts", arguments: '{"days":30}' },
      ],
    });
    expect(r.functionCalls.map((c) => [c.callId, c.name, c.arguments])).toEqual([
      ["call_1", "get_brand_profile", "{}"],
      ["call_2", "list_recent_posts", '{"days":30}'],
    ]);
    expect(r.text).toBeNull();
  });

  it("surfaces incomplete and failed reasons", () => {
    const cut = parseResponseBody({
      id: "resp_3",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    });
    expect(cut.status).toBe("incomplete");
    expect(cut.incompleteReason).toBe("max_output_tokens");
    expect(cut.error).toBe("incomplete: max_output_tokens");

    const failed = parseResponseBody({ id: "r", status: "failed", error: { message: "boom" } });
    expect(failed.error).toBe("boom");
    expect(parseResponseBody({ id: "r", status: "weird" }).status).toBe("failed");
  });
});

describe("usage", () => {
  it("maps input/output/cached/reasoning and keeps the Chat conventions", () => {
    const u = readResponsesUsage(completed);
    expect(u).toEqual({ promptTokens: 1200, cachedTokens: 1000, completionTokens: 300, reasoningTokens: 120 });
    expect(toChatUsage(u!)).toEqual({ promptTokens: 1200, cachedTokens: 1000, completionTokens: 300 });
    expect(readResponsesUsage({})).toBeNull();
  });
});

describe("error classifiers", () => {
  it("recognises a missing model, an unsupported parameter and a refused continuation", () => {
    expect(isUnknownModelError("OpenAI responses failed (404): The model `gpt-6-astra` does not exist")).toBe(true);
    expect(isUnknownModelError("OpenAI responses failed (400): model_not_found")).toBe(true);
    expect(isUnknownModelError("OpenAI responses failed (400): Invalid schema")).toBe(false);
    expect(isUnsupportedParamError("Unsupported parameter: 'temperature' is not supported with this model.", "temperature")).toBe(true);
    expect(isUnsupportedParamError("Unsupported parameter: 'temperature'", "reasoning")).toBe(false);
    expect(isPreviousResponseError("Previous response with id 'resp_x' not found (previous_response_id).")).toBe(true);
  });
});

describe("safeJsonParse", () => {
  it("parses plain, fenced and prefixed JSON, and returns null on junk", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(safeJsonParse('Here you go: {"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("nope")).toBeNull();
    expect(safeJsonParse(null)).toBeNull();
  });
});
