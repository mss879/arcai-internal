import type { AiToolParam } from "@/lib/database.types";

import type { AiToolSchema } from "./chat-core";

/**
 * Turning a tool the agency defined into something the model can call, and
 * back into something the client's endpoint can trust (0127).
 *
 * The agency writes a tool in the CRM as a name, a description and a list of
 * fields. Two things have to come out of that: a JSON Schema the model reads
 * before deciding to call it, and a validator that runs on the arguments the
 * model produced. The second is the important one — a language model's
 * arguments are a suggestion, not a contract, and this is the last gate
 * before the agency's server posts them to a client's live system.
 *
 * Pure, so both halves are pinned by tests.
 */

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;
export const TOOL_PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const TOOL_MAX_PARAMS = 12;
export const TOOL_ARG_MAX_CHARS = 500;
/** How much of a client's answer the model is allowed to read back. */
export const TOOL_RESULT_MAX_CHARS = 4_000;
export const TOOL_TIMEOUT_DEFAULT_MS = 8_000;
export const TOOL_TIMEOUT_MAX_MS = 12_000;
/** A write tool may only fire this many times in one conversation. */
export const WRITE_TOOL_MAX_PER_CONVERSATION = 3;

/** The subset of an `ai_tools` row the runtime needs. */
export type ToolDef = {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: "read" | "write";
  method: "GET" | "POST";
  path: string;
  parameters: AiToolParam[];
  timeout_ms: number;
};

/** Names the agent already owns. A custom tool may not take one of them. */
export const RESERVED_TOOL_NAMES = [
  "capture_lead",
  "offer_booking",
  "request_human",
  // 0127 — the two the calendar provider supplies when one is chosen.
  "check_availability",
  "book_appointment",
] as const;

/**
 * The model's view of a tool.
 *
 * A `write` tool says so in its own description, because the model reads
 * these one at a time and the system prompt's general instruction is easy to
 * lose behind eight of them.
 */
export function compileToolSchema(tool: ToolDef): AiToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of tool.parameters ?? []) {
    if (!TOOL_PARAM_NAME_RE.test(param.name)) continue;
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description || param.name,
    };
    if (param.type === "string" && param.options?.length) schema.enum = param.options;
    properties[param.name] = schema;
    if (param.required) required.push(param.name);
  }
  const note =
    tool.kind === "write"
      ? " This makes a real change — confirm the details with the visitor and wait for a clear yes before calling it."
      : "";
  return {
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${note}`.slice(0, 1_000),
      parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    },
  };
}

export type ToolArgs = Record<string, string | number | boolean>;

/**
 * Check and coerce what the model produced.
 *
 * Coerce rather than reject where the intent is unambiguous — a model that
 * answers "2" for a number field means two, and failing the whole call over
 * a quoted digit would be pedantry the visitor pays for. Anything genuinely
 * ambiguous is refused, and unknown keys are dropped rather than forwarded:
 * the client's endpoint should only ever see fields the agency described.
 */
export function validateToolArgs(
  tool: ToolDef,
  args: unknown,
): { ok: true; value: ToolArgs } | { ok: false; error: string } {
  const input = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const out: ToolArgs = {};

  for (const param of tool.parameters ?? []) {
    if (!TOOL_PARAM_NAME_RE.test(param.name)) continue;
    const raw = input[param.name];
    const missing = raw === undefined || raw === null || raw === "";
    if (missing) {
      if (param.required) return { ok: false, error: `Ask the visitor for ${param.description || param.name} first.` };
      continue;
    }

    if (param.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, error: `${param.name} must be a number.` };
      out[param.name] = n;
      continue;
    }
    if (param.type === "boolean") {
      if (typeof raw === "boolean") out[param.name] = raw;
      else {
        const s = String(raw).trim().toLowerCase();
        if (["true", "yes", "1"].includes(s)) out[param.name] = true;
        else if (["false", "no", "0"].includes(s)) out[param.name] = false;
        else return { ok: false, error: `${param.name} must be yes or no.` };
      }
      continue;
    }

    const s = String(raw).trim().slice(0, TOOL_ARG_MAX_CHARS);
    if (param.options?.length && !param.options.includes(s)) {
      return { ok: false, error: `${param.name} must be one of: ${param.options.join(", ")}.` };
    }
    out[param.name] = s;
  }
  return { ok: true, value: out };
}

/**
 * What the model is told after the call.
 *
 * The client's endpoint answers `{ ok, result?, message?, error? }`. Anything
 * else — HTML, an empty body, a stack trace — is reported as a failure in
 * plain words rather than pasted into the conversation, because whatever the
 * agent is handed here it may well repeat to the visitor.
 */
export function readToolResponse(
  json: Record<string, unknown> | null,
  fallbackError: string | null,
): { ok: boolean; content: Record<string, unknown> } {
  if (!json) {
    return { ok: false, content: { ok: false, error: fallbackError ?? "The system did not answer in a readable way." } };
  }
  const ok = json.ok !== false;
  if (!ok) {
    const error = typeof json.error === "string" ? json.error.slice(0, TOOL_RESULT_MAX_CHARS) : "That could not be done.";
    return { ok: false, content: { ok: false, error } };
  }
  const content: Record<string, unknown> = { ok: true };
  if (json.result !== undefined) content.result = capDepth(json.result);
  if (typeof json.message === "string") content.message = json.message.slice(0, TOOL_RESULT_MAX_CHARS);
  if (json.result === undefined && json.message === undefined) content.result = "Done.";
  return { ok: true, content };
}

/** Keep a client's answer to a size and shape a prompt can carry. */
function capDepth(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, TOOL_RESULT_MAX_CHARS);
  if (depth >= 4) return "…";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => capDepth(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = capDepth(v, depth + 1);
    }
    return out;
  }
  return null;
}

export type ToolFormInput = {
  name: string;
  label: string;
  description: string;
  kind: string;
  method: string;
  path: string;
  parameters: AiToolParam[];
  timeoutMs: number;
  enabled: boolean;
};

/** Validate what the agency typed into the tool editor. */
export function validateToolForm(
  input: ToolFormInput,
  existingNames: readonly string[],
): { ok: true; value: ToolFormInput } | { ok: false; error: string } {
  const name = input.name.trim().toLowerCase();
  if (!TOOL_NAME_RE.test(name)) {
    return { ok: false, error: "The name must be lower_snake_case, 3–40 characters, starting with a letter." };
  }
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
    return { ok: false, error: `"${name}" is one of the agent's built-in abilities — pick another name.` };
  }
  if (existingNames.includes(name)) return { ok: false, error: "This project already has a tool with that name." };

  const description = input.description.trim();
  if (description.length < 15) {
    return { ok: false, error: "Describe what this does in a sentence — it is all the model has to decide when to use it." };
  }
  if (description.length > 500) return { ok: false, error: "Keep the description under 500 characters." };
  if (input.kind !== "read" && input.kind !== "write") return { ok: false, error: "A tool either reads or writes." };
  if (input.method !== "GET" && input.method !== "POST") return { ok: false, error: "Use GET or POST." };

  const seen = new Set<string>();
  const parameters: AiToolParam[] = [];
  for (const p of input.parameters ?? []) {
    const pname = p.name.trim().toLowerCase();
    if (!pname) continue;
    if (!TOOL_PARAM_NAME_RE.test(pname)) return { ok: false, error: `"${p.name}" is not a valid field name.` };
    if (seen.has(pname)) return { ok: false, error: `The field "${pname}" is listed twice.` };
    if (!["string", "number", "boolean"].includes(p.type)) return { ok: false, error: `"${pname}" has an unknown type.` };
    if (!p.description?.trim()) return { ok: false, error: `Describe what "${pname}" is, so the model can fill it in.` };
    seen.add(pname);
    parameters.push({
      name: pname,
      type: p.type,
      description: p.description.trim().slice(0, 200),
      required: Boolean(p.required),
      ...(p.options?.length ? { options: p.options.map((o) => o.trim()).filter(Boolean).slice(0, 20) } : {}),
    });
  }
  if (parameters.length > TOOL_MAX_PARAMS) {
    return { ok: false, error: `A tool may take at most ${TOOL_MAX_PARAMS} fields.` };
  }

  const timeoutMs = Math.round(Number(input.timeoutMs));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > TOOL_TIMEOUT_MAX_MS) {
    return { ok: false, error: `The timeout must be between 1000 and ${TOOL_TIMEOUT_MAX_MS} milliseconds — the visitor is waiting.` };
  }

  return {
    ok: true,
    value: {
      ...input,
      name,
      label: input.label.trim().slice(0, 60) || `${name.replace(/_/g, " ")}…`,
      description,
      path: input.path.trim(),
      parameters,
      timeoutMs,
    },
  };
}
