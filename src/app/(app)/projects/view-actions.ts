"use server";

/**
 * Saved board views (VIEW-2, 0097).
 *
 * LOOP-7 gave the board search, six filters and six sorts, which answered
 * "can I find one job" and left "can I get back to the same question
 * tomorrow" unanswered. A saved view is a name for a set of filters.
 *
 * A view is either private to whoever made it or shared with the workspace —
 * and the useful ones ("Everything at risk") always want sharing, because the
 * point is that the whole team is looking at the same list.
 */

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** The board's own filter state. Stored verbatim so a new filter needs no migration. */
export type SavedViewFilters = {
  query?: string;
  status?: string;
  stage?: string;
  client_id?: string;
  service?: string;
  owing?: boolean;
  sort?: string;
  mode?: string;
};

const MAX_VIEWS = 24;

export async function saveProjectView(input: {
  id?: string;
  name: string;
  filters: SavedViewFilters;
  shared: boolean;
}): Promise<ActionResult & { id?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the view a name." };
  if (name.length > 60)
    return { ok: false, error: "Keep the name under 60 characters." };

  if (!input.id) {
    const { count } = await supabase
      .from("project_views")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) >= MAX_VIEWS)
      return {
        ok: false,
        error: `That's the ${MAX_VIEWS}-view limit — delete one you no longer use first.`,
      };
  }

  // Only ever store the keys the board actually has, so a crafted body can't
  // put arbitrary json in the row.
  const filters: SavedViewFilters = {
    query: input.filters.query?.slice(0, 200) || undefined,
    status: input.filters.status || undefined,
    stage: input.filters.stage || undefined,
    client_id: input.filters.client_id || undefined,
    service: input.filters.service || undefined,
    owing: input.filters.owing || undefined,
    sort: input.filters.sort || undefined,
    mode: input.filters.mode || undefined,
  };

  const payload = { name, filters, shared: input.shared };

  const saved = input.id
    ? await supabase
        .from("project_views")
        .update(payload)
        .eq("id", input.id)
        // A private view belongs to its owner; a shared one belongs to
        // everyone, and anyone may tidy it up.
        .select("id")
        .single()
    : await supabase
        .from("project_views")
        .insert({ ...payload, owner_id: user.id })
        .select("id")
        .single();

  if (saved.error) return { ok: false, error: saved.error.message };
  revalidatePath("/projects");
  return { ok: true, id: saved.data.id };
}

export async function deleteProjectView(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: view } = await supabase
    .from("project_views")
    .select("owner_id, shared")
    .eq("id", id)
    .maybeSingle();
  if (!view) return { ok: false, error: "That view is already gone." };

  // Someone else's private view isn't yours to delete — and it shouldn't have
  // been listed for you in the first place.
  if (!view.shared && view.owner_id && view.owner_id !== user.id)
    return { ok: false, error: "That view belongs to someone else." };

  const { error } = await supabase.from("project_views").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  return { ok: true };
}
