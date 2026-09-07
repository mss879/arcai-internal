import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import type { AiProject } from "@/lib/types";

import { calendarToolDefs } from "./calendar";
import { toolDefOf } from "./custom-tools";
import type { ToolDef } from "./tool-core";

type DB = SupabaseClient<Database>;

/**
 * Loading a project for the public routes (0126).
 *
 * Every widget request — a config read, a chat turn — starts by turning the
 * public key in `?p=` into a project row. That read is memoised for a minute
 * per key so a busy site does not become a database bill: a settings edit
 * reaches the live widget within sixty seconds on other instances, and at
 * once on the instance that saved it (`invalidateProjectMemo`).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RE = /^pk_[A-Za-z0-9]{24}$/;

/** `pk_` + 24 base62 characters — 143 bits, unguessable. */
export function generatePublicKey(): string {
  const bytes = randomBytes(24);
  let out = "pk_";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

export type AiProjectClient = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
};

export type AiProjectWithClient = AiProject & { client: AiProjectClient | null };

/** 0127 — a project plus the tools the agency wired to its client backend.
 *  Loaded and cached together so a visitor's turn costs one round-trip, not
 *  two. */
export type LoadedProject = { project: AiProjectWithClient; tools: ToolDef[] };

const MEMO_TTL_MS = 60_000;
const MEMO_MAX = 500;
const memo = new Map<string, { at: number; loaded: LoadedProject | null }>();

export const PROJECT_WITH_CLIENT = "*, client:clients(id, name, company, email, phone)";

/**
 * The project behind a public key, with its custom tools. Memoised per key
 * for a minute, so a busy client site does not become a database bill and a
 * settings change still reaches every instance within a minute.
 */
export async function loadByKey(db: DB, key: string): Promise<LoadedProject | null> {
  if (!isPublicKey(key)) return null;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.loaded;

  const { data } = await db
    .from("ai_projects")
    .select(PROJECT_WITH_CLIENT)
    .eq("public_key", key)
    .maybeSingle();
  const project = (data as unknown as AiProjectWithClient | null) ?? null;

  let tools: ToolDef[] = [];
  if (project) {
    // Only worth a read when there is a backend for a tool to call.
    if (project.backend_base_url) {
      const { data: rows } = await db
        .from("ai_tools")
        .select("*")
        .eq("project_id", project.id)
        .eq("enabled", true)
        .order("created_at", { ascending: true })
        .limit(20);
      tools = (rows ?? []).map(toolDefOf);
    }
    // The two calendar tools are synthetic: they appear when a provider is
    // chosen and vanish when it is not, so there is nothing to enable.
    tools = [...tools, ...calendarToolDefs(project)];
  }

  const loaded = project ? { project, tools } : null;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, { at: Date.now(), loaded });
  return loaded;
}

/** The project alone, for callers that do not run a turn. */
export async function loadProjectByKey(db: DB, key: string): Promise<AiProjectWithClient | null> {
  return (await loadByKey(db, key))?.project ?? null;
}

/** Forget a key (after a settings save) or everything. */
export function invalidateProjectMemo(key?: string | null): void {
  if (key) memo.delete(key);
  else memo.clear();
}

/** The name the agent speaks for: the client's company, else the client, else the project. */
export function businessNameFor(project: {
  name: string;
  client: { name: string; company: string | null } | null;
}): string {
  return project.client?.company?.trim() || project.client?.name?.trim() || project.name;
}

/** What the widget is allowed to know about a project. Never the prompt,
 * never the model, never the key list — the config response is public. */
export function publicConfigFor(project: AiProjectWithClient, enabled: boolean) {
  return {
    enabled,
    agent_name: project.agent_name,
    business_name: businessNameFor(project),
    welcome_message: project.welcome_message,
    suggested_questions: project.suggested_questions ?? [],
    avatar_url: project.avatar_url,
    primary_color: project.primary_color,
    user_bubble_color: project.user_bubble_color,
    agent_bubble_color: project.agent_bubble_color,
    position: project.widget_position,
    show_branding: project.show_branding,
    lead_capture: project.lead_capture_enabled,
    booking: project.booking_enabled && Boolean(project.booking_url),
  };
}
