import { describe, expect, it } from "vitest";

import {
  effortParam,
  gpt5Minor,
  isReasoningModel,
  reasoningEffortFor,
} from "./reasoning-core";

/**
 * The table in `reasoning-core.ts` was measured against the live API. These
 * pin it, because the failure mode is silent until a visitor types something:
 * the wrong value is a 400 on every single turn.
 */

describe("isReasoningModel", () => {
  it("knows the GPT-5 family and the o-series", () => {
    for (const m of ["gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-5.6-luna", "o1", "o3-mini"]) {
      expect(isReasoningModel(m)).toBe(true);
    }
  });

  it("leaves the 4-series alone", () => {
    for (const m of ["gpt-4.1", "gpt-4o", "gpt-4o-mini"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });
});

describe("gpt5Minor", () => {
  it("reads the point release", () => {
    expect(gpt5Minor("gpt-5")).toBe(0);
    expect(gpt5Minor("gpt-5-mini")).toBe(0);
    expect(gpt5Minor("gpt-5.4")).toBe(4);
    expect(gpt5Minor("gpt-5.6-luna")).toBe(6);
    expect(gpt5Minor("gpt-5.10-x")).toBe(10);
  });

  it("is null for anything not GPT-5", () => {
    expect(gpt5Minor("o3")).toBeNull();
    expect(gpt5Minor("gpt-4.1")).toBeNull();
    // Not a point release — a different family that merely starts the same.
    expect(gpt5Minor("gpt-50")).toBeNull();
  });
});

describe("reasoningEffortFor", () => {
  it("omits the parameter entirely for non-reasoning models", () => {
    expect(reasoningEffortFor("gpt-4.1", "low", true)).toBeNull();
    expect(reasoningEffortFor("gpt-4o-mini", "high", false)).toBeNull();
  });

  // The bug this file exists for: gpt-5.4+ refuses to reason while it holds
  // function tools, so every AI Projects turn 400'd on the default model.
  it("turns reasoning off on 5.4+ whenever tools are advertised", () => {
    for (const m of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      for (const want of ["minimal", "low", "medium", "high", "xhigh", null]) {
        expect(reasoningEffortFor(m, want, true)).toBe("none");
      }
    }
  });

  it("keeps the chosen effort on 5.4+ when there are no tools", () => {
    expect(reasoningEffortFor("gpt-5.6-luna", "high", false)).toBe("high");
    expect(reasoningEffortFor("gpt-5.6-luna", "xhigh", false)).toBe("xhigh");
    expect(reasoningEffortFor("gpt-5.6-luna", "none", false)).toBe("none");
    // `minimal` was retired in this half of the family; `low` is the nearest.
    expect(reasoningEffortFor("gpt-5.6-luna", "minimal", false)).toBe("low");
    expect(reasoningEffortFor("gpt-5.6-luna", null, false)).toBeNull();
  });

  it("keeps the chosen effort on classic gpt-5, tools or not", () => {
    for (const hasTools of [true, false]) {
      expect(reasoningEffortFor("gpt-5", "minimal", hasTools)).toBe("minimal");
      expect(reasoningEffortFor("gpt-5-mini", "low", hasTools)).toBe("low");
      expect(reasoningEffortFor("gpt-5-nano", "high", hasTools)).toBe("high");
    }
  });

  it("coerces the two values classic gpt-5 refuses", () => {
    expect(reasoningEffortFor("gpt-5", "xhigh", true)).toBe("high");
    expect(reasoningEffortFor("gpt-5", "none", true)).toBe("low");
  });

  it("tolerates case and padding in a stored value", () => {
    expect(reasoningEffortFor("gpt-5", " HIGH ", false)).toBe("high");
    expect(reasoningEffortFor("gpt-5.6-luna", " Minimal ", false)).toBe("low");
  });
});

describe("effortParam", () => {
  it("sends nothing at all rather than a null", () => {
    expect(effortParam(null)).toEqual({});
    expect(effortParam("none")).toEqual({ reasoning_effort: "none" });
  });
});
