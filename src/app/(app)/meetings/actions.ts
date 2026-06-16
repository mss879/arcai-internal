"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";

import { createClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/utils";
import type { ActionResult } from "@/lib/types";

export type MeetingLinkInput = {
  title: string;
  description?: string;
  duration_minutes?: number;
  start_hour?: number;
  end_hour?: number;
  advance_days?: number;
  location?: string;
};

export async function createMeetingLink(
  input: MeetingLinkInput,
): Promise<ActionResult<{ slug: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };

  const slug = `${slugify(input.title).slice(0, 24) || "meet"}-${nanoid(6)}`;

  const { error } = await supabase.from("meeting_links").insert({
    slug,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    duration_minutes: input.duration_minutes ?? 60,
    start_hour: input.start_hour ?? 9,
    end_hour: input.end_hour ?? 21,
    advance_days: Math.min(input.advance_days ?? 14, 14),
    location: input.location?.trim() || null,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/meetings");
  return { ok: true, slug };
}

export async function toggleMeetingLink(
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("meeting_links")
    .update({ active })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/meetings");
  return { ok: true };
}

export async function deleteMeetingLink(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("meeting_links").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/meetings");
  return { ok: true };
}
