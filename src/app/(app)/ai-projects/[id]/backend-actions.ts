"use server";

import { revalidatePath } from "next/cache";

import { backendLinkFor, backendReadiness, testBackendLink } from "@/lib/ai-projects/backend";
import { requeueDelivery } from "@/lib/ai-projects/delivery";
import { testCalendar } from "@/lib/ai-projects/calendar";
import { checkPath, parseClientUrl } from "@/lib/ai-projects/outbound-core";
import { checkTableName, testSupabaseLink } from "@/lib/ai-projects/supabase-destination";
import { invalidateProjectMemo, PROJECT_WITH_CLIENT, type AiProjectWithClient } from "@/lib/ai-projects/projects";
import { generateReadKey, generateSecret, hashKey } from "@/lib/ai-projects/signature";
import { runCustomTool, toolDefOf } from "@/lib/ai-projects/custom-tools";
import { TOOL_TIMEOUT_MAX_MS, validateToolForm, type ToolFormInput } from "@/lib/ai-projects/tool-core";
import { requireAdmin } from "@/lib/auth";
import type { AiToolParam } from "@/lib/database.types";
import { decryptToken, encryptToken, isSocialCryptoConfigured } from "@/lib/social/crypto";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * The Backend tab's actions (0127) — the link to the client's own site.
 *
 * Every one of these is admin-only, and every one that changes what the
 * agent can reach invalidates the project memo so the change is live on this
 * instance at once and everywhere else within a minute.
 */

async function loadProject(id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("ai_projects").select(PROJECT_WITH_CLIENT).eq("id", id).maybeSingle();
  return { supabase, project: (data as unknown as AiProjectWithClient | null) ?? null };
}

function refresh(id: string) {
  revalidatePath(`/ai-projects/${id}`);
}

// ---- Connection ------------------------------------------------------------

export async function saveBackendConnection(
  id: string,
  input: { baseUrl: string },
): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const raw = input.baseUrl.trim();
  if (!raw) {
    const { error } = await supabase
      .from("ai_projects")
      .update({ backend_base_url: null, lead_delivery_enabled: false, backend_verified_at: null, backend_last_error: null })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
    invalidateProjectMemo(project.public_key);
    refresh(id);
    return { ok: true };
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const checked = parseClientUrl(withScheme, { allowLocal: process.env.NODE_ENV !== "production" });
  if (!checked.ok) return { ok: false, error: checked.error };
  // Store the origin only: tool paths and the webhook path hang off it, and
  // a stray path here would end up doubled in every URL.
  const origin = `${checked.url.protocol}//${checked.url.host}`;

  const { error } = await supabase
    .from("ai_projects")
    .update({ backend_base_url: origin, backend_verified_at: null, backend_last_error: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

/** Mint a new shared secret. Returned once, to be pasted into the client's env. */
export async function rotateBackendSecret(id: string): Promise<ActionResult<{ secret: string }>> {
  await requireAdmin();
  if (!isSocialCryptoConfigured()) {
    return { ok: false, error: "SOCIAL_TOKEN_KEY is not set on the server, so a secret cannot be stored safely." };
  }
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const secret = generateSecret();
  const { error } = await supabase
    .from("ai_projects")
    .update({ backend_secret_enc: encryptToken(secret), backend_verified_at: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true, secret };
}

/** Show the stored secret again — the admin has to paste it into a .env. */
export async function revealBackendSecret(id: string): Promise<ActionResult<{ secret: string }>> {
  await requireAdmin();
  const { project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const secret = decryptToken(project.backend_secret_enc);
  if (!secret) {
    return { ok: false, error: "That secret cannot be read — SOCIAL_TOKEN_KEY may have changed since it was stored. Rotate it." };
  }
  return { ok: true, secret };
}

export async function rotateReadKey(id: string): Promise<ActionResult<{ key: string }>> {
  await requireAdmin();
  if (!isSocialCryptoConfigured()) {
    return { ok: false, error: "SOCIAL_TOKEN_KEY is not set on the server, so a key cannot be stored safely." };
  }
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const key = generateReadKey();
  const { error } = await supabase
    .from("ai_projects")
    .update({ read_key_enc: encryptToken(key), read_key_hash: hashKey(key) })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  refresh(id);
  return { ok: true, key };
}

export async function revealReadKey(id: string): Promise<ActionResult<{ key: string }>> {
  await requireAdmin();
  const { project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const key = decryptToken(project.read_key_enc);
  if (!key) return { ok: false, error: "That key cannot be read. Rotate it to issue a new one." };
  return { ok: true, key };
}

/** Post a signed ping at the client's lead endpoint and report what came back. */
export async function sendBackendTest(id: string): Promise<ActionResult<{ detail: string }>> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const res = await testBackendLink(supabase, project);
  refresh(id);
  return res.ok ? { ok: true, detail: res.detail } : { ok: false, error: res.detail };
}

// ---- Lead delivery ---------------------------------------------------------

export async function saveDeliverySettings(
  id: string,
  input: { enabled: boolean; path: string },
): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const path = checkPath(input.path);
  if (!path.ok) return path;
  if (input.enabled) {
    const readiness = backendReadiness(project);
    if (!readiness.ready) return { ok: false, error: readiness.reason ?? "Connect the client's backend first." };
  }

  const { error } = await supabase
    .from("ai_projects")
    .update({ lead_delivery_enabled: input.enabled, lead_webhook_path: path.path })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

export async function retryDelivery(id: string, deliveryId: string): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const { data: row } = await supabase
    .from("ai_deliveries")
    .select("id, project_id")
    .eq("id", deliveryId)
    .maybeSingle();
  if (!row || row.project_id !== id) return { ok: false, error: "That delivery no longer exists." };

  await requeueDelivery(supabase, deliveryId);
  const { attemptDelivery } = await import("@/lib/ai-projects/delivery");
  const sent = await attemptDelivery(supabase, deliveryId);
  refresh(id);
  return sent ? { ok: true } : { ok: false, error: "It still did not get through — the queue will keep trying." };
}

// ---- Tools -----------------------------------------------------------------

export type ToolInput = {
  toolId?: string | null;
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

export async function saveTool(id: string, input: ToolInput): Promise<ActionResult<{ toolId: string }>> {
  const admin = await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const path = checkPath(input.path);
  if (!path.ok) return path;

  const { data: siblings } = await supabase
    .from("ai_tools")
    .select("id, name")
    .eq("project_id", id);
  const taken = (siblings ?? []).filter((t) => t.id !== input.toolId).map((t) => t.name);

  const form: ToolFormInput = { ...input, path: path.path, kind: input.kind, method: input.method };
  const checked = validateToolForm(form, taken);
  if (!checked.ok) return checked;
  const v = checked.value;

  const row = {
    project_id: id,
    name: v.name,
    label: v.label,
    description: v.description,
    kind: v.kind as "read" | "write",
    method: v.method as "GET" | "POST",
    path: v.path,
    parameters: v.parameters,
    timeout_ms: Math.min(v.timeoutMs, TOOL_TIMEOUT_MAX_MS),
    enabled: v.enabled,
  };

  const query = input.toolId
    ? supabase.from("ai_tools").update(row).eq("id", input.toolId).eq("project_id", id)
    : supabase.from("ai_tools").insert({ ...row, created_by: admin.id });
  const { data, error } = await query.select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save that tool." };

  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true, toolId: data.id };
}

export async function setToolEnabled(id: string, toolId: string, enabled: boolean): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const { error } = await supabase.from("ai_tools").update({ enabled }).eq("id", toolId).eq("project_id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

export async function deleteTool(id: string, toolId: string): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const { error } = await supabase.from("ai_tools").delete().eq("id", toolId).eq("project_id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

/**
 * Call a tool by hand, with arguments the agency types.
 *
 * Runs the real path — the same validation, the same signature, the same
 * guard — so a green result here means the agent will get one too. It is
 * marked as a preview, so a write tool describes what it would do rather
 * than doing it.
 */
export async function testTool(
  id: string,
  toolId: string,
  args: Record<string, unknown>,
): Promise<ActionResult<{ succeeded: boolean; content: Record<string, unknown> }>> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  if (!backendLinkFor(project)) return { ok: false, error: "Connect the client's backend first." };

  const { data: row } = await supabase.from("ai_tools").select("*").eq("id", toolId).eq("project_id", id).maybeSingle();
  if (!row) return { ok: false, error: "That tool no longer exists." };

  const res = await runCustomTool(supabase, {
    project,
    tool: toolDefOf(row),
    args,
    conversationId: "00000000-0000-0000-0000-000000000000",
    preview: true,
  });
  refresh(id);
  return { ok: true, succeeded: res.ok, content: res.content };
}

// ---- The client's own Supabase --------------------------------------------

export type SupabaseInput = {
  url: string;
  /** Only sent when the admin typed a new one; blank leaves the stored key. */
  anonKey: string;
  table: string;
  fieldMap: Record<string, string>;
  enabled: boolean;
};

export async function saveSupabaseConnection(id: string, input: SupabaseInput): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const raw = input.url.trim();
  if (!raw) {
    const { error } = await supabase
      .from("ai_projects")
      .update({
        supabase_url: null,
        supabase_anon_key_enc: null,
        supabase_delivery_enabled: false,
        supabase_verified_at: null,
        supabase_last_error: null,
      })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
    refresh(id);
    return { ok: true };
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const checked = parseClientUrl(withScheme, { allowLocal: process.env.NODE_ENV !== "production" });
  if (!checked.ok) return { ok: false, error: checked.error };
  const table = checkTableName(input.table);
  if (!table.ok) return table;

  const key = input.anonKey.trim();
  if (key) {
    if (!isSocialCryptoConfigured()) {
      return { ok: false, error: "SOCIAL_TOKEN_KEY is not set on the server, so a key cannot be stored safely." };
    }
    // A service-role key is deliberately not accepted: this link exists to
    // insert one lead, and a key that can do more than that has no business
    // being held here. Supabase JWTs carry their role in the payload.
    if (looksLikeServiceKey(key)) {
      return {
        ok: false,
        error:
          "That looks like a service-role key. Use the anon key with an insert policy — the SQL to run is on this card. A service key would give this system full access to the client's database.",
      };
    }
  } else if (!project.supabase_anon_key_enc) {
    return { ok: false, error: "Paste the client's Supabase anon key." };
  }

  if (input.enabled && !key && !project.supabase_anon_key_enc) {
    return { ok: false, error: "Add the anon key before switching delivery on." };
  }

  const cleanMap: Record<string, string> = {};
  for (const [field, column] of Object.entries(input.fieldMap ?? {})) {
    const c = column.trim();
    if (!c) continue;
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(c)) return { ok: false, error: `"${c}" is not a valid column name.` };
    cleanMap[field] = c;
  }
  if (input.enabled && !Object.keys(cleanMap).length) {
    return { ok: false, error: "Map at least one field to a column, or there is nothing to insert." };
  }

  const { error } = await supabase
    .from("ai_projects")
    .update({
      supabase_url: `${checked.url.protocol}//${checked.url.host}`,
      ...(key ? { supabase_anon_key_enc: encryptToken(key) } : {}),
      supabase_leads_table: table.table,
      supabase_field_map: cleanMap,
      supabase_delivery_enabled: input.enabled,
      supabase_verified_at: null,
      supabase_last_error: null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  refresh(id);
  return { ok: true };
}

/** A Supabase JWT carries its role in the payload; refuse a service key. */
function looksLikeServiceKey(key: string): boolean {
  const parts = key.split(".");
  if (parts.length !== 3) return /service[_-]?role/i.test(key);
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { role?: unknown };
    return String(payload.role ?? "").toLowerCase() === "service_role";
  } catch {
    return /service[_-]?role/i.test(key);
  }
}

export async function testSupabaseConnection(id: string): Promise<ActionResult<{ detail: string }>> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const res = await testSupabaseLink(supabase, project);
  refresh(id);
  return res.ok ? { ok: true, detail: res.detail } : { ok: false, error: res.detail };
}

// ---- The calendar ----------------------------------------------------------

export type CalendarInput = {
  provider: string;
  /** Blank leaves the stored key alone. */
  apiKey: string;
  eventTypeId: string;
  timezone: string;
  availabilityPath: string;
  bookPath: string;
  apiBase: string;
};

export async function saveCalendarSettings(id: string, input: CalendarInput): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const provider = input.provider;
  if (!["none", "endpoint", "cal_com"].includes(provider)) {
    return { ok: false, error: "Pick a calendar provider." };
  }

  const availability = checkPath(input.availabilityPath);
  if (!availability.ok) return availability;
  const book = checkPath(input.bookPath);
  if (!book.ok) return book;

  const timezone = input.timezone.trim() || "Asia/Colombo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    return { ok: false, error: `"${timezone}" is not a time zone. Use a name like Asia/Colombo or Europe/London.` };
  }

  const key = input.apiKey.trim();
  if (provider === "cal_com") {
    if (!key && !project.calendar_api_key_enc) return { ok: false, error: "Paste the Cal.com API key." };
    if (key && !isSocialCryptoConfigured()) {
      return { ok: false, error: "SOCIAL_TOKEN_KEY is not set on the server, so a key cannot be stored safely." };
    }
    if (!input.eventTypeId.trim()) return { ok: false, error: "Add the Cal.com event type id." };
    if (!/^\d{1,12}$/.test(input.eventTypeId.trim())) return { ok: false, error: "The event type id is a number." };
  }
  if (provider === "endpoint" && !project.backend_base_url) {
    return { ok: false, error: "Connect the client's backend first — the endpoint calendar runs on their site." };
  }

  let apiBase: string | null = null;
  const base = input.apiBase.trim();
  if (base) {
    const checked = parseClientUrl(base, { allowLocal: process.env.NODE_ENV !== "production" });
    if (!checked.ok) return { ok: false, error: checked.error };
    apiBase = base.replace(/\/+$/, "");
  }

  const { error } = await supabase
    .from("ai_projects")
    .update({
      calendar_provider: provider as "none",
      ...(key ? { calendar_api_key_enc: encryptToken(key) } : {}),
      calendar_event_type_id: input.eventTypeId.trim() || null,
      calendar_timezone: timezone,
      calendar_availability_path: availability.path,
      calendar_book_path: book.path,
      calendar_api_base: apiBase,
      calendar_verified_at: null,
      calendar_last_error: null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // The two calendar tools appear and vanish with the provider, so the memo
  // has to forget the project or the agent keeps the old list for a minute.
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

export async function testCalendarConnection(id: string): Promise<ActionResult<{ detail: string }>> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const res = await testCalendar(supabase, project);
  refresh(id);
  return res.ok ? { ok: true, detail: res.detail } : { ok: false, error: res.detail };
}
