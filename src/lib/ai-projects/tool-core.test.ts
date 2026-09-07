import { describe, expect, it } from "vitest";

import {
  TOOL_ARG_MAX_CHARS,
  TOOL_TIMEOUT_MAX_MS,
  compileToolSchema,
  readToolResponse,
  validateToolArgs,
  validateToolForm,
  type ToolDef,
} from "./tool-core";

const tool: ToolDef = {
  id: "t1",
  name: "check_stock",
  label: "Checking availability…",
  description: "Check whether a given day and time is free for an appointment.",
  kind: "read",
  method: "POST",
  path: "/api/arc/tools/check-availability",
  timeout_ms: 8000,
  parameters: [
    { name: "day", type: "string", description: "The date, as YYYY-MM-DD", required: true },
    { name: "people", type: "number", description: "How many people", required: false },
    { name: "evening", type: "boolean", description: "Evening rather than morning", required: false },
    { name: "branch", type: "string", description: "Which branch", required: false, options: ["colombo", "kandy"] },
  ],
};

describe("compileToolSchema", () => {
  it("produces the function-calling shape with only the required fields listed", () => {
    const schema = compileToolSchema(tool);
    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("check_stock");
    const params = schema.function.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(["day", "people", "evening", "branch"]);
    expect(params.required).toEqual(["day"]);
    expect((params.properties.branch as { enum?: string[] }).enum).toEqual(["colombo", "kandy"]);
  });

  it("warns the model in the description when a tool writes", () => {
    const read = compileToolSchema(tool).function.description;
    const write = compileToolSchema({ ...tool, kind: "write" }).function.description;
    expect(read).not.toContain("confirm");
    expect(write).toContain("confirm the details with the visitor");
  });

  it("drops a malformed field name rather than emitting it", () => {
    const schema = compileToolSchema({
      ...tool,
      parameters: [{ name: "Bad Name", type: "string", description: "x", required: true }],
    });
    expect((schema.function.parameters as { properties: object }).properties).toEqual({});
  });
});

describe("validateToolArgs", () => {
  it("accepts a good call and drops unknown keys", () => {
    const res = validateToolArgs(tool, { day: "2026-09-10", people: 4, sneaky: "drop me" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ day: "2026-09-10", people: 4 });
  });

  it("coerces what the model reasonably meant", () => {
    const res = validateToolArgs(tool, { day: " 2026-09-10 ", people: "4", evening: "yes" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ day: "2026-09-10", people: 4, evening: true });
  });

  it("refuses a missing required field, in words the agent can act on", () => {
    const res = validateToolArgs(tool, { people: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Ask the visitor for");
  });

  it("refuses a number that is not one, and an option off the list", () => {
    expect(validateToolArgs(tool, { day: "x", people: "many" }).ok).toBe(false);
    expect(validateToolArgs(tool, { day: "x", evening: "maybe" }).ok).toBe(false);
    expect(validateToolArgs(tool, { day: "x", branch: "galle" }).ok).toBe(false);
    expect(validateToolArgs(tool, { day: "x", branch: "kandy" }).ok).toBe(true);
  });

  it("caps an oversized string instead of forwarding it", () => {
    const res = validateToolArgs(tool, { day: "x".repeat(5_000) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(String(res.value.day)).toHaveLength(TOOL_ARG_MAX_CHARS);
  });

  it("treats an empty optional as absent, not as an empty value", () => {
    const res = validateToolArgs(tool, { day: "2026-09-10", branch: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect("branch" in res.value).toBe(false);
  });
});

describe("readToolResponse", () => {
  it("passes a good answer through", () => {
    const res = readToolResponse({ ok: true, result: { free: true, slots: ["15:00"] } }, null);
    expect(res.ok).toBe(true);
    expect(res.content).toEqual({ ok: true, result: { free: true, slots: ["15:00"] } });
  });

  it("reports the client's own error", () => {
    const res = readToolResponse({ ok: false, error: "Fully booked that day." }, null);
    expect(res.ok).toBe(false);
    expect(res.content).toEqual({ ok: false, error: "Fully booked that day." });
  });

  it("does not paste an unreadable answer into the conversation", () => {
    const res = readToolResponse(null, "The client's server answered HTTP 500.");
    expect(res.ok).toBe(false);
    expect(res.content).toEqual({ ok: false, error: "The client's server answered HTTP 500." });
  });

  it("caps a huge result and says something for an empty success", () => {
    const big = readToolResponse({ ok: true, result: "x".repeat(10_000) }, null);
    expect(String((big.content as { result: string }).result).length).toBeLessThanOrEqual(4_000);
    expect(readToolResponse({ ok: true }, null).content).toEqual({ ok: true, result: "Done." });
  });
});

describe("validateToolForm", () => {
  const form = {
    name: "check_stock",
    label: "",
    description: "Check whether a given day and time is free.",
    kind: "read",
    method: "POST",
    path: "/api/arc/tools/check",
    parameters: [{ name: "day", type: "string" as const, description: "The date", required: true }],
    timeoutMs: 8000,
    enabled: true,
  };

  it("cleans a good tool and defaults its label", () => {
    const res = validateToolForm(form, []);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.label).toBe("check stock…");
  });

  it("refuses a reserved name, a duplicate, and a thin description", () => {
    expect(validateToolForm({ ...form, name: "capture_lead" }, []).ok).toBe(false);
    // The calendar supplies these two whenever a provider is chosen.
    expect(validateToolForm({ ...form, name: "check_availability" }, []).ok).toBe(false);
    expect(validateToolForm({ ...form, name: "book_appointment" }, []).ok).toBe(false);
    expect(validateToolForm(form, ["check_stock"]).ok).toBe(false);
    expect(validateToolForm({ ...form, description: "checks" }, []).ok).toBe(false);
  });

  it("refuses a bad name, a duplicate field, an undescribed field and a silly timeout", () => {
    expect(validateToolForm({ ...form, name: "Check-Stock" }, []).ok).toBe(false);
    expect(validateToolForm({ ...form, parameters: [form.parameters[0]!, form.parameters[0]!] }, []).ok).toBe(false);
    expect(validateToolForm({ ...form, parameters: [{ name: "day", type: "string", description: " ", required: true }] }, []).ok).toBe(false);
    expect(validateToolForm({ ...form, timeoutMs: TOOL_TIMEOUT_MAX_MS + 1 }, []).ok).toBe(false);
    expect(validateToolForm({ ...form, timeoutMs: 100 }, []).ok).toBe(false);
  });
});
