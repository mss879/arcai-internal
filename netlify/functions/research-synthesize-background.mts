// Netlify Background Function — the slow half of prospect research.
//
// Runs the OpenAI synthesis for ONE lead_research row with the full 15-minute
// background budget, so a reasoning model (gpt-5.4-mini) can think as long as it
// needs — the ~26s regular-function limit that truncates `after()`/cron does NOT
// apply here.
//
// Flow (see src/lib/research.ts): the app builds the prompt, stores it on the
// row's `analysis` jsonb, sets status 'synthesizing', and POSTs { id } to this
// function. We call OpenAI and write the raw model JSON back to `analysis.aiRaw`
// (or the failure reason to `analysis.aiError`). The per-minute tick then
// assembles the final `report`.
//
// Deliberately self-contained — only `@supabase/supabase-js` + `fetch`, no app
// imports — so it bundles as a standalone function with no path-alias or
// server-only complications. The filename ends in `-background`, which is what
// makes Netlify run it asynchronously (returns 202 immediately, up to 15 min).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// Type-only import: erased at bundle time (esbuild drops `import type`), so no
// path alias or app code is pulled into this standalone function — it just
// gives the Supabase client proper row types for type-checking.
import type { Database } from "../../src/lib/database.types";

type AnalysisJson = Record<string, unknown>;

/** Merge a patch into the row's `analysis` jsonb without clobbering the rest. */
async function mergeAnalysis(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: AnalysisJson,
): Promise<void> {
  const { data } = await supabase
    .from("lead_research")
    .select("analysis")
    .eq("id", id)
    .maybeSingle();
  const current = (data?.analysis ?? {}) as AnalysisJson;
  await supabase
    .from("lead_research")
    .update({ analysis: { ...current, ...patch } as never })
    .eq("id", id);
}

const handler = async (req: Request): Promise<Response> => {
  // Same shared-secret gate as the automation tick.
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (secret) {
    const url = new URL(req.url);
    const provided =
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("secret") ??
      "";
    if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  }

  let id = "";
  try {
    const body = (await req.json()) as { id?: unknown };
    id = typeof body.id === "string" ? body.id : "";
  } catch {
    // no/invalid body — handled below
  }
  if (!id) return new Response("Missing id", { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Without Supabase creds we can't even record an error on the row — bail.
  // (These being present in the FUNCTION runtime is itself the thing to verify
  // in Netlify: env vars must be scoped to Functions/Runtime, not just Builds.)
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "[research-synth] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the function runtime",
    );
    return new Response("Not configured (supabase)", { status: 500 });
  }

  const supabase = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Missing OpenAI key is the #1 hosted-only failure. RECORD it on the row so
  // the UI shows a real reason and the tick finalizes to a basic report —
  // instead of the report hanging silently until the 22-minute give-up.
  if (!openaiKey) {
    console.error("[research-synth] missing OPENAI_API_KEY in the function runtime");
    await mergeAnalysis(supabase, id, {
      aiError:
        "Synthesis worker is missing OPENAI_API_KEY in the Netlify Functions runtime. In Site configuration → Environment variables, add OPENAI_API_KEY and ensure its scope includes Functions (not Builds-only), then redeploy.",
    });
    return new Response("Not configured (openai)", { status: 200 });
  }

  const { data: row } = await supabase
    .from("lead_research")
    .select("id, analysis")
    .eq("id", id)
    .maybeSingle();
  if (!row) return new Response("Not found", { status: 404 });

  const analysis = (row.analysis ?? {}) as AnalysisJson;
  const system =
    typeof analysis.synthSystem === "string" ? analysis.synthSystem : "";
  const user =
    typeof analysis.synthPrompt === "string" ? analysis.synthPrompt : "";
  if (!user) {
    await mergeAnalysis(supabase, id, {
      aiError: "No synthesis prompt was stored.",
    });
    return new Response("No prompt", { status: 200 });
  }

  const model = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
  const effort = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  // Reasoning models (o-series + GPT-5 family) reject `temperature`; they take
  // `reasoning_effort` instead. Match the app's detection exactly.
  const isReasoning = /^(o\d|gpt-5)/i.test(model);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`,
      },
      // Well under the 15-min function budget; on timeout we record the reason
      // so the tick can emit a basic report instead of waiting indefinitely.
      signal: AbortSignal.timeout(12 * 60 * 1000),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        ...(isReasoning
          ? { reasoning_effort: effort }
          : { temperature: 0.3 }),
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      await mergeAnalysis(supabase, id, {
        aiError: `OpenAI ${res.status}: ${detail}`,
      });
      return new Response("OpenAI error", { status: 200 });
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      await mergeAnalysis(supabase, id, {
        aiError: "OpenAI returned no content.",
      });
      return new Response("No content", { status: 200 });
    }

    await mergeAnalysis(supabase, id, { aiRaw: content });
    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = (
      e instanceof Error ? e.message : "OpenAI request failed."
    ).slice(0, 300);
    await mergeAnalysis(supabase, id, { aiError: msg });
    return new Response("error", { status: 200 });
  }
};

export default handler;
