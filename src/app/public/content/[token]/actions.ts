"use server";

import { notifyUsers } from "@/lib/notify";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * A client approving, or asking for changes to, a post (0118).
 *
 * Public — the approval token is the credential. Both actions re-resolve the
 * token and re-check the state, because a server action is a public POST
 * endpoint and the page it was rendered from is not a guarantee of anything.
 */

async function contentLimit(token: string): Promise<string | null> {
  const res = await enforceRateLimit(createAdminClient(), `content:${token}`, {
    limit: 20,
    windowSec: 600,
  });
  return res.ok ? null : "Too many attempts. Give it a minute.";
}

async function resolve(token: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("carousel_posts")
    .select("id, topic, client_status, created_by")
    .eq("approval_token", token)
    .maybeSingle();
  return { supabase, post: data };
}

export async function approveContent(token: string): Promise<ActionResult> {
  const busy = await contentLimit(token);
  if (busy) return { ok: false, error: busy };

  const { supabase, post } = await resolve(token);
  if (!post) return { ok: false, error: "This link is no longer valid." };
  if (post.client_status === "not_sent") {
    return { ok: false, error: "This post isn't ready for review yet." };
  }
  if (post.client_status === "approved") return { ok: true };

  const { error } = await supabase
    .from("carousel_posts")
    .update({
      client_status: "approved",
      client_decided_at: new Date().toISOString(),
      client_feedback: null,
    })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  // The person who made it is who wants to know, not the whole team.
  await notifyUsers(supabase, {
    userIds: post.created_by ? [post.created_by] : "all",
    type: "approval",
    title: "A post was approved ✅",
    body: `The client approved "${post.topic}".`,
    link: "/content",
  });

  return { ok: true };
}

export async function requestContentChanges(
  token: string,
  feedback: string,
): Promise<ActionResult> {
  const busy = await contentLimit(token);
  if (busy) return { ok: false, error: busy };

  const notes = feedback.trim();
  if (!notes) return { ok: false, error: "Tell us what to change." };
  if (notes.length > 2000) {
    return { ok: false, error: "That's a long one — could you shorten it?" };
  }

  const { supabase, post } = await resolve(token);
  if (!post) return { ok: false, error: "This link is no longer valid." };
  if (post.client_status === "not_sent") {
    return { ok: false, error: "This post isn't ready for review yet." };
  }

  const { error } = await supabase
    .from("carousel_posts")
    .update({
      client_status: "changes_requested",
      client_feedback: notes,
      client_decided_at: new Date().toISOString(),
    })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  await notifyUsers(supabase, {
    userIds: post.created_by ? [post.created_by] : "all",
    type: "approval",
    title: "Changes asked for on a post",
    body: `"${post.topic}" — ${notes.slice(0, 140)}`,
    link: "/content",
  });

  return { ok: true };
}
