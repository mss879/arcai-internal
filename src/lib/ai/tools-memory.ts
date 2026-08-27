import "server-only";

/**
 * What Arcus remembers about how this person runs the business (0101).
 *
 * Three tools, one idea: the assistant should not have to be told the same
 * standing instruction every week. "Always give Silva ten percent off",
 * "invoices go to accounts, never to the owner", "I call the Kandy job the
 * bakery" — the sort of thing a colleague picks up in a month and an
 * assistant used to forget the moment the panel closed.
 *
 * Two rules keep that from becoming a security hole:
 *
 *   1. Only the USER can create an active memory. `remember` writes
 *      `source: 'user'` because the person just said it out loud. The
 *      overnight miner writes `status: 'pending'` and nothing reads a
 *      pending row until a human approves it in Studio settings — so a
 *      client's message quoted into a conversation cannot install itself
 *      as an instruction.
 *   2. Nothing here is ever hard-deleted. `forget` archives, which keeps
 *      the audit trail and makes an accidental "forget everything" a
 *      recoverable mistake rather than a permanent one.
 *
 * Like every other module, these run on the caller's RLS client, and the
 * `assistant_memories` policy is own-rows-only: one member's memories are
 * invisible to the rest of the team.
 */

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type { ArtifactColumn } from "@/lib/assistant-artifacts";
import { rowsToTable, tableArtifact } from "@/lib/assistant-artifacts";
import type {
  AssistantMemoryKind,
  AssistantMemoryStatus,
} from "@/lib/database.types";

/** Keeps one runaway turn from filling the prompt with near-duplicates. */
const MAX_ACTIVE_MEMORIES = 200;

/** A single memory is a sentence, not a document. */
const MAX_CONTENT_CHARS = 400;

export const MEMORY_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Store something about how this person works, so you still know it in a week's time. Call it when they say 'remember…', 'always…', 'from now on…', 'I prefer…', or state a standing rule about their business. Store the RULE, not the passing detail: 'invoices go to accounts@theirdomain' is worth remembering, 'send this one to accounts' is not. NEVER store passwords, API keys, card numbers or anything that looks like a secret — say you won't and move on.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The fact or rule in one plain sentence, written so it still makes sense months later with no conversation around it.",
          },
          kind: {
            type: "string",
            enum: ["instruction", "preference", "fact"],
            description:
              "instruction = a standing rule to follow ('always CC accounts'). preference = how they like things done ('keep replies short'). fact = something true about the business ('we don't do Facebook ads'). Default instruction.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description:
        "Drop something you were remembering, when the user says to forget it or tells you a rule no longer applies. Matches on the words in the memory; if several match it lists them and changes nothing, so ask which one they mean.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Words from the memory to drop, e.g. 'Silva discount'.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description:
        "Show everything you are currently remembering about this person, and anything waiting for their approval. Use it for 'what do you remember?', 'what do you know about me?' or when they ask why you did something a particular way.",
      parameters: {
        type: "object",
        properties: {
          include_pending: {
            type: "boolean",
            description:
              "Also list memories mined from past conversations that are waiting for approval. Default true.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/** Cheap guard against storing something that is obviously a credential. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bapi[_ -]?key\b\s*[:=]/i,
  /\bpassword\b\s*[:=]/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-shaped
];

function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

async function remember(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const content = String(args.content ?? "").trim().slice(0, MAX_CONTENT_CHARS);
  if (content.length < 4)
    return { content: { ok: false, error: "There's nothing there to remember." } };
  if (looksLikeSecret(content))
    return {
      content: {
        ok: false,
        error: "That looks like a credential, so it wasn't stored.",
        say: "Tell the user you don't keep passwords, keys or card numbers — they belong in the proper settings, not in your memory.",
      },
    };

  const kindRaw = String(args.kind ?? "instruction");
  const kind: AssistantMemoryKind =
    kindRaw === "preference" || kindRaw === "fact" ? kindRaw : "instruction";

  const { data: existing } = await ctx.supabase
    .from("assistant_memories")
    .select("id, content")
    .eq("user_id", ctx.userId)
    .eq("status", "active")
    .limit(MAX_ACTIVE_MEMORIES);

  // Storing the same rule twice is how the prompt fills with noise. Exact
  // (case-insensitive) repeats are treated as already known.
  const already = (existing ?? []).find(
    (row) => row.content.trim().toLowerCase() === content.toLowerCase(),
  );
  if (already)
    return {
      content: {
        ok: true,
        already_known: true,
        memory: content,
        note: "Already remembered — say so briefly rather than confirming it as new.",
      },
    };

  const { error } = await ctx.supabase.from("assistant_memories").insert({
    user_id: ctx.userId,
    kind,
    content,
    source: "user",
    status: "active",
  });
  if (error) return { content: { ok: false, error: error.message } };

  return {
    content: {
      ok: true,
      remembered: content,
      kind,
      note: "Stored. Confirm in a short sentence — don't read the whole memory list back.",
    },
    event: { kind: "created", label: "Remembered that" },
  };
}

async function forget(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query)
    return { content: { ok: false, error: "Say which memory to drop." } };

  const { data, error } = await ctx.supabase
    .from("assistant_memories")
    .select("id, content, kind")
    .eq("user_id", ctx.userId)
    .in("status", ["active", "pending"])
    .ilike("content", `%${query}%`)
    .limit(5);
  if (error) return { content: { ok: false, error: error.message } };

  const rows = data ?? [];
  if (!rows.length)
    return {
      content: {
        ok: false,
        error: `Nothing remembered matches "${query}".`,
      },
    };
  if (rows.length > 1)
    return {
      content: {
        ok: false,
        error: `More than one memory matches "${query}". Ask which one to drop.`,
        candidates: rows.map((r) => r.content),
      },
    };

  const target = rows[0];
  // Archived, not deleted: a mistaken "forget" should be recoverable, and the
  // row is still evidence of what the assistant was told and when.
  const { error: updateError } = await ctx.supabase
    .from("assistant_memories")
    .update({
      status: "archived",
      decided_by: ctx.userId,
      decided_at: new Date().toISOString(),
    })
    .eq("id", target.id);
  if (updateError)
    return { content: { ok: false, error: updateError.message } };

  return {
    content: {
      ok: true,
      forgotten: target.content,
      note: "Dropped from what you remember. Confirm briefly.",
    },
    event: { kind: "updated", label: "Forgot that" },
  };
}

async function listMemories(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const includePending = args.include_pending !== false;
  const statuses: AssistantMemoryStatus[] = includePending
    ? ["active", "pending"]
    : ["active"];

  const { data, error } = await ctx.supabase
    .from("assistant_memories")
    .select("id, kind, content, source, status, created_at")
    .eq("user_id", ctx.userId)
    .in("status", statuses)
    .order("status", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(MAX_ACTIVE_MEMORIES);
  if (error) return { content: { ok: false, error: error.message } };

  const rows = data ?? [];
  const columns: ArtifactColumn[] = [
    { key: "what", label: "What you remember" },
    { key: "kind", label: "Kind", format: "status" },
    { key: "where", label: "Learned", secondary: true },
    { key: "state", label: "State", format: "status" },
  ];

  const artifact = tableArtifact({
    title: "What Arcus remembers",
    subtitle: `${rows.filter((r) => r.status === "active").length} in use`,
    summary:
      "Standing instructions and preferences. Anything marked waiting was picked up from a past conversation and needs approving in Studio settings before it is used.",
    href: "/dashboard",
    area: "dashboard",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      tone: r.status === "pending" ? ("warning" as const) : ("neutral" as const),
      cells: {
        what: r.content,
        kind: r.kind,
        where: r.source === "mined" ? "from a conversation" : "you told me",
        state: r.status === "pending" ? "waiting for you" : "in use",
      },
    })),
  });

  return {
    content: {
      ok: true,
      active: rows.filter((r) => r.status === "active").length,
      pending: rows.filter((r) => r.status === "pending").length,
      memories: rows.map((r) => ({
        what: r.content,
        kind: r.kind,
        state: r.status,
      })),
      note: rows.length
        ? "The list is on screen — summarise it in a sentence rather than reading every line."
        : "Nothing remembered yet. Mention they can just say 'remember…' at any time.",
    },
    event: { kind: "read", label: "Read what I remember" },
    artifacts: [artifact],
  };
}

/**
 * Run one memory tool.
 *
 * Returns `null` when the name belongs to another module, so the registry can
 * try the next executor.
 */
export async function executeMemoryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "remember":
      return remember(args, ctx);
    case "forget":
      return forget(args, ctx);
    case "list_memories":
      return listMemories(args, ctx);
    default:
      return null;
  }
}
