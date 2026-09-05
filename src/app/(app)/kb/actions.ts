"use server";

import { revalidatePath } from "next/cache";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { invalidateAgentKnowledge } from "@/lib/wa-knowledge";

/**
 * The knowledge base (0119).
 *
 * There was no written-down way of doing anything: what to say to a client
 * who wants a discount, what the hosting actually includes, how a handover
 * works. New people learned by asking, and the WhatsApp agent could only know
 * what fitted in one config field.
 */

export type KbInput = {
  id?: string | null;
  slug?: string;
  title: string;
  bodyMd: string;
  category?: string;
  tags?: string[];
  visibility?: "team" | "agent" | "both";
};

/** A URL-safe slug from a title. Collisions get a short suffix, not an error. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  );
}

export async function saveKbPage(input: KbInput): Promise<ActionResult<{ id: string }>> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give the page a title." };

  const supabase = await createClient();
  const row = {
    title,
    body_md: input.bodyMd,
    category: input.category?.trim() || "general",
    tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
    visibility: input.visibility ?? "team",
    updated_by: profile.id,
  };

  if (input.id) {
    const { error } = await supabase.from("kb_pages").update(row).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
    // The agent caches its knowledge for a few minutes; drop it so an edit
    // reaches the next reply rather than the one after.
    invalidateAgentKnowledge();
    revalidatePath("/kb");
    return { ok: true, id: input.id };
  }

  let slug = input.slug?.trim() || slugify(title);
  const { data: taken } = await supabase
    .from("kb_pages")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (taken) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const { data, error } = await supabase
    .from("kb_pages")
    .insert({ ...row, slug, created_by: profile.id })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save the page." };
  }

  invalidateAgentKnowledge();
  revalidatePath("/kb");
  return { ok: true, id: data.id };
}

export async function deleteKbPage(id: string): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { error } = await supabase.from("kb_pages").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  invalidateAgentKnowledge();
  revalidatePath("/kb");
  return { ok: true };
}

/**
 * Full-text search (0119).
 *
 * Through the SQL function rather than an ilike: the index ranks a title
 * match above a body mention and returns a highlighted snippet, which is the
 * difference between search and scrolling.
 */
export async function searchKb(query: string): Promise<
  { id: string; slug: string; title: string; category: string; snippet: string }[]
> {
  const profile = await getProfile();
  if (!profile) return [];
  const q = query.trim();
  if (!q) return [];

  const supabase = await createClient();
  try {
    const { data } = await supabase.rpc("kb_search", { q, lim: 12 });
    return (data ?? []).map((hit) => ({
      id: hit.id,
      slug: hit.slug,
      title: hit.title,
      category: hit.category,
      // ts_headline marks matches with <b>; strip it — the UI is not
      // rendering stored HTML, and this text came from a textarea.
      snippet: String(hit.snippet ?? "").replace(/<\/?b>/g, ""),
    }));
  } catch {
    return [];
  }
}
