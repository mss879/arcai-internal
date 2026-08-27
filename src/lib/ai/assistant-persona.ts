import "server-only";

/**
 * The per-member half of the system prompt (0101): who the assistant is to
 * this person, and what it has been told to remember.
 *
 * Both routes need it and neither should own it, so it lives here — one query
 * pair, one shape, one failure policy. That policy is the important part:
 * **this never throws and never blocks a turn**. A workspace that has not run
 * migration 0101 yet, a member with no config row, an RLS surprise — all of
 * them return an empty persona, and the assistant answers exactly as it did
 * before memory existed. A copilot that refuses to talk because it could not
 * read its own preferences would be a worse product than one that forgets.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssistantPromptOptions } from "@/lib/ai/assistant-prompt";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/** The persona slice of the prompt options — never the name or the date. */
export type PersonaPromptParts = Pick<
  AssistantPromptOptions,
  "personaName" | "tone" | "verbosity" | "memories" | "honorific"
>;

/**
 * How many active memories are read. The prompt trims to its own character
 * budget after this; the limit here is about the query, not the prompt.
 */
const MEMORY_LIMIT = 40;

export async function loadPersona(
  supabase: DB,
  userId: string,
): Promise<PersonaPromptParts> {
  try {
    const [config, memories] = await Promise.all([
      supabase
        .from("assistant_config")
        .select("persona_name, tone, verbosity, honorific")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("assistant_memories")
        .select("content, kind, updated_at")
        .eq("user_id", userId)
        // ACTIVE ONLY. A 'pending' row is something the miner extracted from a
        // conversation and no human has approved — reading it here would be
        // the exact injection path the approve-first queue exists to close.
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(MEMORY_LIMIT),
    ]);

    const parts: PersonaPromptParts = {};
    if (config.data) {
      if (config.data.persona_name) parts.personaName = config.data.persona_name;
      if (config.data.tone) parts.tone = config.data.tone;
      if (config.data.verbosity) parts.verbosity = config.data.verbosity;
      if (config.data.honorific) parts.honorific = config.data.honorific;
    }

    const rows = memories.data ?? [];
    if (rows.length) {
      // Instructions first: when the budget truncates, a standing rule is
      // worth more than a piece of background colour.
      const rank = { instruction: 0, preference: 1, fact: 2 } as const;
      parts.memories = [...rows]
        .sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3))
        .map((row) => row.content);
    }
    return parts;
  } catch {
    return {};
  }
}
