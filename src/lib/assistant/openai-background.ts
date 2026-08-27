import "server-only";

/**
 * OpenAI background jobs, generalised (0102).
 *
 * A serverless invocation gets a minute or two; a reasoning model writing a
 * good morning briefing can want longer. The Responses API solves this with
 * `background: true` — the POST returns a job id almost immediately, and the
 * result is collected on a later request.
 *
 * The lead-research pipeline proved the pattern (`kickoffBackgroundSynthesis`
 * / `pollBackgroundSynthesis` in `@/lib/ai/lead-research`); this is the same
 * two calls with the research-specific parts taken out, so the briefing —
 * and anything after it — can kick off on one tick and collect on another.
 *
 * The failure policy matters: a transient HTTP hiccup reads as `pending`, not
 * as an error, because the caller polls again in a minute anyway. Only a
 * genuinely terminal state (failed / cancelled / expired) is reported as an
 * error, and the caller's own deadline bounds the total wait.
 */

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

export type BackgroundKickoff =
  | { jobId: string }
  | { error: string };

export type BackgroundPoll =
  | { status: "pending" }
  | { status: "done"; text: string }
  | { status: "error"; error: string };

/**
 * Start a background job that must answer with a JSON object.
 *
 * @param model The model to run — reasoning models take `effort` instead of
 *   a temperature, exactly as the chat helpers do.
 * @returns The job id, or a human-readable reason it could not start.
 */
export async function startBackgroundJob(opts: {
  model: string;
  system: string;
  user: string;
  reasoning?: boolean;
  effort?: string;
  temperature?: number;
}): Promise<BackgroundKickoff> {
  if (!process.env.OPENAI_API_KEY) return { error: "no_key" };
  try {
    const res = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      // Only STARTS the job — returns almost immediately with an id.
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: opts.model,
        background: true,
        input: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        text: { format: { type: "json_object" } },
        ...(opts.reasoning
          ? { reasoning: { effort: opts.effort || "medium" } }
          : { temperature: opts.temperature ?? 0.3 }),
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      return { error: `OpenAI ${res.status}: ${detail}` };
    }
    const job = (await res.json()) as { id?: unknown };
    if (typeof job.id !== "string" || !job.id) {
      return { error: "OpenAI returned no job id." };
    }
    return { jobId: job.id };
  } catch (e) {
    return {
      error: (e instanceof Error ? e.message : "Could not start the job.").slice(0, 300),
    };
  }
}

/** Check on a background job. Never throws; hiccups read as `pending`. */
export async function pollBackgroundJob(jobId: string): Promise<BackgroundPoll> {
  if (!process.env.OPENAI_API_KEY) return { status: "error", error: "no_key" };
  try {
    const res = await fetch(`${BASE_URL}/responses/${jobId}`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) {
      return { status: "error", error: "The job expired before it could be read." };
    }
    if (!res.ok) return { status: "pending" }; // transient — retry next poll

    const job = (await res.json()) as {
      status?: string;
      output_text?: string;
      output?: { type?: string; content?: { text?: string }[] }[];
      error?: unknown;
      incomplete_details?: unknown;
    };

    if (job.status === "completed") {
      // `output_text` is the convenience field; walking `output` is the
      // fallback for shapes that do not populate it.
      let text = typeof job.output_text === "string" ? job.output_text : "";
      if (!text && Array.isArray(job.output)) {
        for (const item of job.output) {
          if (item?.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (typeof c?.text === "string") text += c.text;
            }
          }
        }
      }
      if (!text) return { status: "error", error: "The job returned nothing." };
      return { status: "done", text };
    }

    if (
      job.status === "failed" ||
      job.status === "cancelled" ||
      job.status === "incomplete"
    ) {
      const detail = JSON.stringify(job.error ?? job.incomplete_details ?? {}).slice(0, 200);
      return { status: "error", error: `The job ${job.status}: ${detail}` };
    }

    return { status: "pending" }; // queued | in_progress
  } catch {
    return { status: "pending" };
  }
}
