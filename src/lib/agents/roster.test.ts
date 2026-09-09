import { describe, expect, it } from "vitest";

import { OFFICE_TOOL_NAMES } from "./tool-names";
import { AGENT_KEYS, ROSTER, mergeRosterOverrides, modelChainFor } from "./roster";

/**
 * The roster is configuration the whole office keys off. A duplicate key,
 * an empty model chain or a tool that does not exist is a robot that stands
 * at its desk forever.
 */

describe("ROSTER", () => {
  it("has ten unique agents, each with a model chain and real tools", () => {
    expect(ROSTER).toHaveLength(10);
    expect(new Set(AGENT_KEYS).size).toBe(10);
    for (const a of ROSTER) {
      expect(a.modelChain.length).toBeGreaterThan(0);
      expect(a.persona.length).toBeGreaterThan(20);
      for (const t of a.tools) expect(OFFICE_TOOL_NAMES).toContain(t);
    }
  });

  it("puts the Director on gpt-6-astra first, with fallbacks", () => {
    const manager = ROSTER.find((a) => a.key === "manager")!;
    expect(manager.modelChain[0]).toBe("gpt-6-astra");
    expect(manager.modelChain.length).toBeGreaterThanOrEqual(2);
  });

  it("the researcher and the generalists search the web; only the designer drafts", () => {
    expect(ROSTER.filter((a) => a.webSearch).map((a) => a.key)).toEqual(["research", "ops_a", "ops_b"]);
    // The generalists are the only ones who can reach a client — and only via the approvals tray.
    expect(ROSTER.filter((a) => a.tools.includes("prepare_message")).map((a) => a.key)).toEqual(["ops_a", "ops_b"]);
    // Two agents share the studio without standing on each other.
    const studio = ROSTER.filter((a) => a.zone === "opsStudio");
    expect(new Set(studio.map((a) => a.seat ?? 0)).size).toBe(studio.length);
    expect(ROSTER.filter((a) => a.tools.includes("create_carousel_draft")).map((a) => a.key)).toEqual(["designer"]);
    // queue_post is gated at runtime; nobody carries it by default.
    expect(ROSTER.some((a) => a.tools.includes("queue_post"))).toBe(false);
  });
});

describe("overrides", () => {
  const writer = ROSTER.find((a) => a.key === "writer")!;

  it("env, then the row, then the code chain — without duplicates", () => {
    expect(modelChainFor(writer, null)).toEqual(writer.modelChain);
    expect(modelChainFor(writer, "gpt-5.5")).toEqual(["gpt-5.5", "gpt-5.6-terra"]);
    expect(modelChainFor(writer, "gpt-5.5", { OPENAI_AGENT_WRITER_MODEL: "gpt-6-astra" })).toEqual([
      "gpt-6-astra",
      "gpt-5.5",
      "gpt-5.6-terra",
    ]);
  });

  it("merges a row's name, effort and enabled flag over the defaults", () => {
    const rows = [
      {
        key: "writer",
        name: "Ink",
        title: "",
        description: "",
        model: null,
        reasoning_effort: "high",
        instructions: "Be punchy.",
        tools: [],
        enabled: false,
        color: null,
        sort: 3,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ];
    const view = mergeRosterOverrides(rows).find((a) => a.key === "writer")!;
    expect(view.name).toBe("Ink");
    expect(view.title).toBe(writer.title);
    expect(view.effort).toBe("high");
    expect(view.enabled).toBe(false);
    expect(view.instructions).toBe("Be punchy.");
    expect(view.model).toBe(writer.modelChain[0]);
    expect(view.overridden).toBe(false);
  });
});
