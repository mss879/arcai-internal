import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import type { AiTool } from "@/lib/types";

import { backendLinkFor, postToBackend } from "./backend";
import type { AiProjectWithClient } from "./projects";
import { idempotencyKey } from "./signature";
import {
  WRITE_TOOL_MAX_PER_CONVERSATION,
  readToolResponse,
  validateToolArgs,
  type ToolDef,
} from "./tool-core";

type DB = SupabaseClient<Database>;

/**
 * The agent acting in the client's own backend (0127).
 *
 * A custom tool is a small contract the agency writes once: a name and
 * description the model reads, a field list, and a path on the client's
 * site. This runs one — validating the model's arguments, signing the
 * request, calling under the SSRF guard, and turning whatever comes back
 * into something safe to hand a language model that may repeat it to a
 * visitor.
 *
 * Three things guard a write:
 *   • the model is told to confirm with the visitor first (tool-core);
 *   • the same arguments in the same conversation carry the same
 *     idempotency key, so a retry cannot book twice;
 *   • a hard cap per conversation, because a confused model in a loop
 *     should cost one apology rather than forty bookings.
 */

/** An `ai_tools` row, as the runtime needs it. */
export function toolDefOf(row: AiTool): ToolDef {
  return {
    id: row.id,
    name: row.name,
    label: row.label || `${row.name.replace(/_/g, " ")}…`,
    description: row.description,
    kind: row.kind,
    method: row.method,
    path: row.path,
    parameters: Array.isArray(row.parameters) ? row.parameters : [],
    timeout_ms: row.timeout_ms,
  };
}

export type CustomToolResult = {
  content: Record<string, unknown>;
  ok: boolean;
};

export async function runCustomTool(
  db: DB,
  opts: {
    project: AiProjectWithClient;
    tool: ToolDef;
    args: unknown;
    conversationId: string;
    preview: boolean;
    /** Wall-clock left in the visitor's turn. */
    remainingMs?: number;
  },
): Promise<CustomToolResult> {
  const { project, tool, conversationId } = opts;
  const started = Date.now();

  // A calendar tool is synthetic — it has no `ai_tools` row, so it has no id
  // to reference and no counters to bump.
  const realTool = /^[0-9a-f-]{36}$/i.test(tool.id);

  const log = async (
    outcome: { ok: boolean; status?: number | null; error?: string | null; excerpt?: string | null },
    args: unknown,
  ) => {
    try {
      await db.from("ai_tool_calls").insert({
        project_id: project.id,
        conversation_id: conversationId,
        tool_id: realTool ? tool.id : null,
        tool_name: tool.name,
        arguments: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
        ok: outcome.ok,
        status: outcome.status ?? null,
        latency_ms: Date.now() - started,
        error: outcome.error?.slice(0, 500) ?? null,
        response_excerpt: outcome.excerpt?.slice(0, 500) ?? null,
      });
      // Rolling health, so a failing endpoint is a number on the tab rather
      // than something to find by reading conversations. Read once: a lost
      // increment under concurrency costs a counter, and the ai_tool_calls
      // rows above are the real record either way.
      if (realTool) {
        const counts = await currentCounts(db, tool.id);
        await db
          .from("ai_tools")
          .update({
            calls_30d: counts.calls + 1,
            failures_30d: counts.failures + (outcome.ok ? 0 : 1),
            last_called_at: new Date().toISOString(),
            last_error: outcome.ok ? null : (outcome.error?.slice(0, 300) ?? null),
          })
          .eq("id", tool.id);
      }
    } catch (e) {
      await captureError(e, { source: "route", path: "ai/tool-call-log", meta: { tool: tool.name } });
    }
  };

  const refuse = async (error: string, args: unknown = {}): Promise<CustomToolResult> => {
    await log({ ok: false, error }, args);
    return { ok: false, content: { ok: false, error } };
  };

  // 1. Is there anywhere to call?
  const link = backendLinkFor(project);
  if (!link) return refuse("That is not available right now.", opts.args);

  // 2. Is there time? A tool that starts with two seconds left produces a
  //    dead stream rather than an answer.
  const needed = Math.min(tool.timeout_ms, 12_000);
  if (opts.remainingMs !== undefined && opts.remainingMs < needed + 1_500) {
    return refuse("That took too long to look up — ask the visitor to try again.", opts.args);
  }

  // 3. Are the model's arguments what the agency described?
  const checked = validateToolArgs(tool, opts.args);
  if (!checked.ok) {
    // Not logged as a failure of the client's endpoint: nothing was called.
    return { ok: false, content: { ok: false, error: checked.error } };
  }
  const args = checked.value;

  // 4. A write may not run away with itself.
  if (tool.kind === "write") {
    const limit = await enforceRateLimit(db, `ai-tool:${conversationId}:${tool.name}`, {
      limit: WRITE_TOOL_MAX_PER_CONVERSATION,
      windowSec: 3_600,
    });
    if (!limit.ok) {
      return refuse("That has already been done a few times in this conversation — the team will take it from here.", args);
    }
  }

  // 5. Preview traffic must never change a client's live system.
  if (opts.preview && tool.kind === "write") {
    return {
      ok: true,
      content: { ok: true, result: "Preview mode — this would have been sent to the client's system, but nothing was changed." },
    };
  }

  const call = await postToBackend(link, tool.path, {
    tool: tool.name,
    arguments: args,
    conversation_id: conversationId,
    project: project.public_key,
    page_url: null,
    preview: opts.preview,
    sent_at: new Date().toISOString(),
  }, {
    method: tool.method,
    timeoutMs: tool.timeout_ms,
    idempotencyKey: tool.kind === "write" ? idempotencyKey(conversationId, tool.name, args) : undefined,
  });

  const read = readToolResponse(call.json, call.error);
  await log(
    { ok: read.ok && call.ok, status: call.status || null, error: read.ok ? null : String(read.content.error ?? call.error ?? ""), excerpt: call.body },
    args,
  );
  return { ok: read.ok && call.ok, content: read.content };
}

/** The tool's current counters, so an update does not race a read. */
async function currentCounts(db: DB, toolId: string): Promise<{ calls: number; failures: number }> {
  const { data } = await db.from("ai_tools").select("calls_30d, failures_30d").eq("id", toolId).maybeSingle();
  return { calls: data?.calls_30d ?? 0, failures: data?.failures_30d ?? 0 };
}

/** Every enabled tool for a project, ready for the model. */
export async function loadProjectTools(db: DB, projectId: string): Promise<ToolDef[]> {
  const { data } = await db
    .from("ai_tools")
    .select("*")
    .eq("project_id", projectId)
    .eq("enabled", true)
    .order("created_at", { ascending: true })
    .limit(20);
  return (data ?? []).map(toolDefOf);
}
