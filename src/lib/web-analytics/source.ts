import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The connection to the WEBSITE's Supabase project.
 *
 * The site (www.arcai.agency) and this CRM live in two different
 * Supabase projects and always will — they have separate schemas,
 * separate auth and separate blast radii. So the only way to get the
 * site's analytics and AI-agent transcripts in here is to read them
 * out of the other project with its own service-role key.
 *
 * The key is READ-ONLY BY CONVENTION, not by grant: a service-role key
 * bypasses RLS entirely and could write anything. Every query in this
 * module is therefore a `select`, and nothing in `@/lib/web-analytics`
 * ever calls insert, update or delete against this client. If that ever
 * needs to change, it should change loudly.
 *
 * Env:
 *   WEBSITE_SUPABASE_URL              https://<ref>.supabase.co
 *   WEBSITE_SUPABASE_SERVICE_ROLE_KEY the site project's service key
 *   WEBSITE_ANALYTICS_SITE            label stored on every mirrored row
 */

/** The site label written onto every mirrored row. */
export const SITE = process.env.WEBSITE_ANALYTICS_SITE?.trim() || "arcai.agency";

export function isWebsiteSourceConfigured(): boolean {
  return Boolean(
    process.env.WEBSITE_SUPABASE_URL?.trim() &&
      process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

/**
 * A client for the website project.
 *
 * Untyped on purpose: the website's schema is not this repo's
 * `Database` type, and pretending otherwise would make every column
 * read look checked when it is not. The sync narrows each row itself.
 */
export function createWebsiteClient(): SupabaseClient {
  const url = process.env.WEBSITE_SUPABASE_URL?.trim();
  const key = process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Website analytics source is not configured — set WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY in the environment.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-client-info": "arc-crm-web-analytics" } },
  });
}

/** A one-shot reachability check for the settings strip on the dashboard. */
export async function pingWebsiteSource(): Promise<
  { ok: true; sessions: number } | { ok: false; error: string }
> {
  if (!isWebsiteSourceConfigured()) {
    return { ok: false, error: "Not configured." };
  }
  try {
    const client = createWebsiteClient();
    const { count, error } = await client
      .from("analytics_sessions")
      .select("session_id", { count: "exact", head: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, sessions: count ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unreachable." };
  }
}
