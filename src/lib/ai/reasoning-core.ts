/**
 * Which `reasoning_effort` a model will actually accept (0126 fix).
 *
 * Pure, and separate from `openai.ts`, because `openai.ts` is server-only and
 * this is the kind of decision that must be pinned by tests: sending the
 * wrong value is a 400 that kills the whole request, and the two halves of
 * the GPT-5 family want opposite values.
 *
 * Measured against the live Chat Completions API on 2026-09-07:
 *
 *   model                      no tools                    WITH function tools
 *   gpt-5 / -mini / -nano      minimal low medium high     minimal low medium high
 *   gpt-5.4 · 5.5 · 5.6        none low medium high xhigh  none ONLY
 *   gpt-4.1 / gpt-4o           (omit — any value is a 400)
 *
 * The line that costs money to forget is the last column: from gpt-5.4 the
 * models refuse to reason and call a function in the same Chat Completions
 * request. `/v1/responses` is the endpoint that allows both; this codebase
 * speaks chat completions, so an agent that carries tools answers with
 * reasoning off. That is not a preference — the alternative is every turn
 * failing with "Function tools with reasoning_effort are not supported",
 * which is precisely what the AI Projects widget did before this existed.
 */

/**
 * Reasoning models (o-series + GPT-5 family) behave differently on the Chat
 * Completions API: they REJECT `temperature`/`top_p` (400 error) and take an
 * optional `reasoning_effort` instead. Detect them by name so the caller
 * can't accidentally send a param that fails the whole request.
 */
export function isReasoningModel(model: string): boolean {
  // gpt-[5-9]: the 0130 Content Office puts gpt-6-astra behind this; a
  // `gpt-5`-only match sent it `temperature` and every call was a 400.
  return /^(o\d|gpt-[5-9])/i.test(model.trim());
}

/** The GPT generation (`gpt-6-astra` → 6, `gpt-4o` → 4), or null. */
export function gptMajor(model: string): number | null {
  const m = model.trim().match(/^gpt-(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * The GPT-5 point release, or null for anything else (o-series included).
 * `gpt-5` and `gpt-5-mini` are minor 0; `gpt-5.6-luna` is minor 6.
 */
export function gpt5Minor(model: string): number | null {
  const m = model.trim().match(/^gpt-5(?:\.(\d+))?(?:$|[-\s])/i);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

/** From this point release on, effort and function tools are exclusive. */
export const TOOLS_EXCLUDE_REASONING_FROM = 4;

const CLASSIC_EFFORTS = ["minimal", "low", "medium", "high"];
const MODERN_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

/**
 * The `reasoning_effort` to actually send — or null to omit the parameter.
 *
 * Never throws and never returns a value the named model rejects: an effort
 * the model will not take is coerced to the nearest one it will, because a
 * slightly different reply is always better than a failed turn.
 */
export function reasoningEffortFor(
  model: string,
  requested: string | null | undefined,
  hasTools: boolean,
): string | null {
  if (!isReasoningModel(model)) return null;
  const want = requested?.trim().toLowerCase() || null;
  const minor = gpt5Minor(model);

  if (minor !== null && minor >= TOOLS_EXCLUDE_REASONING_FROM) {
    // Tools present: `none` is the only value this half of the family takes.
    if (hasTools) return "none";
    if (!want) return null;
    // `minimal` was retired here in favour of `none`.
    return MODERN_EFFORTS.includes(want) ? want : "low";
  }

  // gpt-5 / o-series: `none` and `xhigh` are both refused, tools or not.
  if (!want) return null;
  if (CLASSIC_EFFORTS.includes(want)) return want;
  return want === "xhigh" ? "high" : "low";
}

/** The body fragment for an effort, or nothing when it is to be omitted. */
export function effortParam(effort: string | null): { reasoning_effort?: string } {
  return effort ? { reasoning_effort: effort } : {};
}

// ---- The Responses API (0130) ---------------------------------------------
//
// Everything above was measured on /v1/chat/completions. /v1/responses is
// the endpoint that DOES let gpt-5.4+ reason and call function tools in one
// request, and it is the only endpoint gpt-6 will call tools on at all — so
// the Content Office agents live there, with their own effort rules:
//
//   gpt-6.*             low medium high xhigh max   (no none/minimal; no temperature)
//   gpt-5.4 · 5.5 · 5.6 none low medium high xhigh
//   gpt-5 / o-series    minimal low medium high
//   gpt-4.1 / gpt-4o    (omit)

export const RESPONSES_EFFORTS_GPT6 = ["low", "medium", "high", "xhigh", "max"];
export const RESPONSES_EFFORTS_MODERN = MODERN_EFFORTS;

/**
 * The `reasoning.effort` for a Responses call — or null to omit it. Never
 * returns a value the model refuses; an impossible request is coerced to the
 * nearest one the family takes, and gpt-6 always reasons (its floor is low).
 */
export function responsesEffortFor(
  model: string,
  requested: string | null | undefined,
): string | null {
  if (!isReasoningModel(model)) return null;
  const want = requested?.trim().toLowerCase() || null;
  const major = gptMajor(model);

  if (major !== null && major >= 6) {
    if (!want) return "medium";
    if (want === "none" || want === "minimal") return "low";
    return RESPONSES_EFFORTS_GPT6.includes(want) ? want : "medium";
  }

  const minor = gpt5Minor(model);
  if (minor !== null && minor >= TOOLS_EXCLUDE_REASONING_FROM) {
    if (!want) return null;
    if (want === "minimal") return "none";
    if (want === "max") return "xhigh";
    return MODERN_EFFORTS.includes(want) ? want : "low";
  }

  if (!want) return null;
  if (want === "none") return "minimal";
  if (want === "xhigh" || want === "max") return "high";
  return CLASSIC_EFFORTS.includes(want) ? want : "low";
}

/** Reasoning models reject `temperature` on both endpoints. */
export function supportsTemperature(model: string): boolean {
  return !isReasoningModel(model);
}
