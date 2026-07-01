"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult, WebsiteStatus } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Normalise a user-entered URL so it always has a scheme. */
function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function clampProgress(value: number | undefined): number {
  const n = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(100, n));
}

export type WebsiteProjectInput = {
  id?: string;
  name: string;
  url: string;
  client_id?: string | null;
  progress?: number;
  status?: WebsiteStatus;
  notes?: string;
};

export async function saveWebsiteProject(
  input: WebsiteProjectInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "A site name is required." };
  if (!input.url?.trim()) return { ok: false, error: "A website URL is required." };

  const status: WebsiteStatus = input.status ?? "in_progress";
  const payload = {
    name: input.name.trim(),
    url: normalizeUrl(input.url),
    client_id: input.client_id || null,
    progress: status === "launched" ? 100 : clampProgress(input.progress),
    status,
    notes: input.notes?.trim() || "",
    // Stamp the launch time when moving to launched; clear it otherwise.
    launched_at: status === "launched" ? new Date().toISOString() : null,
  };

  const { error } = input.id
    ? await supabase.from("website_projects").update(payload).eq("id", input.id)
    : await supabase.from("website_projects").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/website-progress");
  return { ok: true };
}

/** Mark a site live: 100% progress, launched status, timestamped. */
export async function launchWebsiteProject(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("website_projects")
    .update({
      status: "launched",
      progress: 100,
      launched_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/website-progress");
  return { ok: true };
}

export async function deleteWebsiteProject(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("website_projects")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/website-progress");
  return { ok: true };
}
