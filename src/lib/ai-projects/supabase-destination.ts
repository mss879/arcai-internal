import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { decryptToken } from "@/lib/social/crypto";
import type { AiProject } from "@/lib/types";

import { callClientEndpoint, readJsonBody } from "./outbound";
import { parseClientUrl } from "./outbound-core";

type DB = SupabaseClient<Database>;

/**
 * Writing a lead straight into the client's own Supabase (0127).
 *
 * Not every client has an endpoint to POST to, but a great many have a
 * Supabase project — often one this agency built. For those, the lead is
 * inserted through PostgREST and appears in their own table, in their own
 * database, with no code on their side at all.
 *
 * SECURITY — the whole shape of this is least privilege:
 *
 *   • The key stored is the **anon** key, never the service-role key. A
 *     service key is full admin on everything that client owns; an anon key
 *     can do only what row-level security permits.
 *   • What it permits is one thing: inserting into the leads table. The
 *     policy is printed on the Backend tab for the agency to run.
 *   • So this module only ever INSERTs, into one named table. It never
 *     selects, never updates, never deletes, and there is no code path here
 *     that could.
 *   • The key is encrypted at rest, revealed only to an admin who clicks,
 *     and never written to a log.
 *   • The URL goes through the same SSRF guard as everything else, so a
 *     mistyped or malicious "Supabase URL" cannot point at private space.
 */

/** The lead fields available to map. */
export const SUPABASE_LEAD_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "interest",
  "page_url",
  "source",
  "captured_at",
] as const;

export type SupabaseLeadField = (typeof SUPABASE_LEAD_FIELDS)[number];

/** Sensible defaults: most tables call these what we call them. */
export const DEFAULT_FIELD_MAP: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  company: "company",
  interest: "message",
  page_url: "",
  source: "source",
  captured_at: "",
};

export type SupabaseLink = { url: string; anonKey: string; table: string; map: Record<string, string> };

export function supabaseLinkFor(project: AiProject): SupabaseLink | null {
  const url = project.supabase_url?.trim();
  if (!url) return null;
  const anonKey = decryptToken(project.supabase_anon_key_enc);
  if (!anonKey) return null;
  const table = (project.supabase_leads_table || "leads").trim();
  if (!table) return null;
  const map = (project.supabase_field_map ?? {}) as Record<string, string>;
  return { url: url.replace(/\/+$/, ""), anonKey, table, map: Object.keys(map).length ? map : DEFAULT_FIELD_MAP };
}

/** A table name we are willing to put in a URL. */
export function checkTableName(name: string): { ok: true; table: string } | { ok: false; error: string } {
  const t = (name ?? "").trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(t)) {
    return { ok: false, error: "A table name is letters, numbers and underscores, starting with a letter." };
  }
  return { ok: true, table: t };
}

/** Our lead, in the client's column names. Unmapped fields are simply not sent. */
export function mapLeadRow(
  lead: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    interest: string | null;
    page_url: string | null;
    created_at?: string;
  },
  map: Record<string, string>,
  agentName: string,
): Record<string, unknown> {
  const source: Record<SupabaseLeadField, unknown> = {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    interest: lead.interest,
    page_url: lead.page_url,
    source: `${agentName} (website assistant)`,
    captured_at: lead.created_at ?? new Date().toISOString(),
  };
  const row: Record<string, unknown> = {};
  for (const field of SUPABASE_LEAD_FIELDS) {
    const column = (map[field] ?? "").trim();
    if (!column) continue;
    const value = source[field];
    if (value === null || value === undefined || value === "") continue;
    row[column] = value;
  }
  return row;
}

export type SupabaseInsertResult = { ok: boolean; status: number; error: string | null };

/**
 * Insert one row into the client's leads table.
 *
 * `Prefer: return=minimal` so the client's data never travels back here — we
 * are writing a lead, not reading their customers, and an insert policy that
 * does not grant select would refuse to return the row anyway.
 */
export async function insertLeadIntoSupabase(
  link: SupabaseLink,
  row: Record<string, unknown>,
): Promise<SupabaseInsertResult> {
  const checkedUrl = parseClientUrl(link.url, { allowLocal: process.env.NODE_ENV !== "production" });
  if (!checkedUrl.ok) return { ok: false, status: 0, error: checkedUrl.error };
  const table = checkTableName(link.table);
  if (!table.ok) return { ok: false, status: 0, error: table.error };
  if (!Object.keys(row).length) {
    return { ok: false, status: 0, error: "Nothing to insert — map at least one field to a column." };
  }

  const call = await callClientEndpoint({
    url: `${link.url}/rest/v1/${encodeURIComponent(table.table)}`,
    method: "POST",
    body: JSON.stringify(row),
    timeoutMs: 10_000,
    headers: {
      apikey: link.anonKey,
      Authorization: `Bearer ${link.anonKey}`,
      Prefer: "return=minimal",
    },
  });

  if (call.ok) return { ok: true, status: call.status, error: null };

  // PostgREST explains itself well; pass its message through rather than a
  // generic failure, because the fix is almost always the RLS policy.
  const json = readJsonBody(call.body);
  const detail =
    (typeof json?.message === "string" && json.message) ||
    (typeof json?.hint === "string" && json.hint) ||
    call.error ||
    "The insert failed.";
  const friendly =
    call.status === 401 || call.status === 403
      ? `${detail} — check the insert policy on "${link.table}" allows the anon role.`
      : detail;
  return { ok: false, status: call.status, error: friendly.slice(0, 400) };
}

/** The policy the agency runs once in the client's SQL editor. */
export function rlsPolicySql(table: string): string {
  const t = checkTableName(table);
  const name = t.ok ? t.table : "leads";
  return [
    `-- Run once in the client's Supabase SQL editor.`,
    `-- This is the whole of what the stored anon key can do: add a lead.`,
    `-- It cannot read, update or delete anything, here or anywhere else.`,
    `alter table public.${name} enable row level security;`,
    ``,
    `drop policy if exists "arc assistant can add leads" on public.${name};`,
    `create policy "arc assistant can add leads"`,
    `  on public.${name} for insert to anon`,
    `  with check (true);`,
  ].join("\n");
}

/** "Send test" for the Supabase link: insert a clearly-marked test lead. */
export async function testSupabaseLink(
  db: DB,
  project: AiProject,
): Promise<{ ok: boolean; detail: string }> {
  const link = supabaseLinkFor(project);
  if (!link) return { ok: false, detail: "Add the client's Supabase URL and anon key first." };

  const row = mapLeadRow(
    {
      name: "ARC connection test",
      email: "test@arcai.agency",
      phone: null,
      company: null,
      interest: "This row was created by the ARC AI connection test. It is safe to delete.",
      page_url: null,
      created_at: new Date().toISOString(),
    },
    link.map,
    project.agent_name,
  );
  const res = await insertLeadIntoSupabase(link, row);
  const detail = res.ok
    ? `Inserted a test row into "${link.table}". Delete it when you are happy.`
    : (res.error ?? "The insert failed.");

  await db
    .from("ai_projects")
    .update({
      supabase_verified_at: res.ok ? new Date().toISOString() : null,
      supabase_last_error: res.ok ? null : detail.slice(0, 500),
    })
    .eq("id", project.id);
  return { ok: res.ok, detail };
}
