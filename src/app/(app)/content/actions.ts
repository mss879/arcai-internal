"use server";

import { revalidatePath } from "next/cache";

import { getProfile } from "@/lib/auth";
import { sendAndLogEmail } from "@/lib/email-outbox";
import { createClient } from "@/lib/supabase/server";
import { STORAGE_BUCKETS } from "@/lib/constants";
import {
  MAX_GENERATIONS,
  MAX_REFERENCES_PER_REQUEST,
  isAspectRatio,
  isImageQuality,
  type AspectRatio,
  type ImageQuality,
} from "@/lib/content";
import {
  GEMINI_IMAGE_MODEL,
  fetchAsInlineImage,
  generateImage,
  isGeminiConfigured,
  type InlineImage,
} from "@/lib/ai/gemini";
import {
  processPendingCarousels,
  startCarouselGeneration,
} from "@/lib/carousels";
import type {
  ActionResult,
  CarouselSlide,
  ContentGeneration,
} from "@/lib/types";

function extFor(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

export type GenerateContentInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  imageSize: ImageQuality;
  count: number;
};

export type GenerateContentResult =
  | { ok: true; generations: ContentGeneration[]; failed: number; note?: string }
  | { ok: false; error: string };

export async function generateContent(
  input: GenerateContentInput,
): Promise<GenerateContentResult> {
  if (!isGeminiConfigured()) {
    return {
      ok: false,
      error:
        "Gemini isn't configured. Add GEMINI_API_KEY to .env.local to enable generation.",
    };
  }

  const prompt = input.prompt?.trim();
  if (!prompt) return { ok: false, error: "Describe what you want to create." };
  if (!isAspectRatio(input.aspectRatio)) {
    return { ok: false, error: "Pick a valid image size." };
  }
  if (!isImageQuality(input.imageSize)) {
    return { ok: false, error: "Pick a valid quality." };
  }

  const count = Math.max(1, Math.min(MAX_GENERATIONS, Math.floor(input.count || 1)));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Pull the brand references (most recent first) and inline them so every
  // generation is guided by the user's saved designs automatically.
  const { data: refRows } = await supabase
    .from("content_references")
    .select("id, image_url")
    .order("created_at", { ascending: false })
    .limit(MAX_REFERENCES_PER_REQUEST);

  const referenceIds = (refRows ?? []).map((r) => r.id);
  let references: InlineImage[] = [];
  try {
    references = await Promise.all(
      (refRows ?? []).map((r) => fetchAsInlineImage(r.image_url)),
    );
  } catch {
    // A broken reference URL shouldn't block generation — just skip them.
    references = [];
  }

  // Run the N variations in parallel inside this one action (the model has
  // no candidateCount for images).
  const results = await Promise.allSettled(
    Array.from({ length: count }, () =>
      generateImage({
        prompt,
        references,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
      }),
    ),
  );

  const created: ContentGeneration[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : "Generation failed.",
      );
      continue;
    }
    const image = result.value;
    const path = `${user.id}/${crypto.randomUUID()}.${extFor(image.mimeType)}`;
    const bytes = Buffer.from(image.data, "base64");

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.contentGenerations)
      .upload(path, bytes, { contentType: image.mimeType, upsert: false });
    if (uploadError) {
      errors.push(uploadError.message);
      continue;
    }

    const { data: pub } = supabase.storage
      .from(STORAGE_BUCKETS.contentGenerations)
      .getPublicUrl(path);

    const { data: row, error: insertError } = await supabase
      .from("content_generations")
      .insert({
        prompt,
        image_url: pub.publicUrl,
        image_path: path,
        mime_type: image.mimeType,
        aspect_ratio: input.aspectRatio,
        image_size: input.imageSize,
        model: GEMINI_IMAGE_MODEL,
        reference_ids: referenceIds,
      })
      .select("*")
      .single();

    if (insertError) {
      errors.push(insertError.message);
      continue;
    }
    created.push(row as ContentGeneration);
  }

  if (created.length === 0) {
    return {
      ok: false,
      error: errors[0] ?? "Generation failed. Please try again.",
    };
  }

  revalidatePath("/content");
  return {
    ok: true,
    generations: created,
    failed: errors.length,
    note:
      errors.length > 0
        ? `${created.length} of ${count} succeeded.`
        : undefined,
  };
}

export type AddReferenceInput = {
  name: string;
  description: string;
  image_url: string;
  image_path: string;
  mime_type: string;
};

export async function addReference(
  input: AddReferenceInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.image_url || !input.image_path) {
    return { ok: false, error: "Upload an image first." };
  }

  const { error } = await supabase.from("content_references").insert({
    name: input.name.trim(),
    description: input.description.trim(),
    image_url: input.image_url,
    image_path: input.image_path,
    mime_type: input.mime_type || "image/png",
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/content");
  return { ok: true };
}

export async function deleteReference(
  id: string,
  path: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("content_references")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (path) {
    await supabase.storage
      .from(STORAGE_BUCKETS.contentReferences)
      .remove([path]);
  }

  revalidatePath("/content");
  return { ok: true };
}

export async function deleteGeneration(
  id: string,
  path: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("content_generations")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (path) {
    await supabase.storage
      .from(STORAGE_BUCKETS.contentGenerations)
      .remove([path]);
  }

  revalidatePath("/content");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Carousel planner
// ---------------------------------------------------------------------------

export type CreateCarouselPostInput = {
  topic: string;
  scheduled_for: string;
  notes: string;
};

export async function createCarouselPost(
  input: CreateCarouselPostInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const topic = input.topic?.trim();
  if (!topic) return { ok: false, error: "What should the carousel be about?" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduled_for ?? "")) {
    return { ok: false, error: "Pick a post date." };
  }

  const { error } = await supabase.from("carousel_posts").insert({
    topic,
    notes: input.notes?.trim() ?? "",
    scheduled_for: input.scheduled_for,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/content");
  return { ok: true };
}

export async function updateCarouselPost(
  id: string,
  input: CreateCarouselPostInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const topic = input.topic?.trim();
  if (!topic) return { ok: false, error: "What should the carousel be about?" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduled_for ?? "")) {
    return { ok: false, error: "Pick a post date." };
  }

  // Only a not-yet-generated post can be edited — after that the copy and
  // designs would no longer match the text.
  const { error } = await supabase
    .from("carousel_posts")
    .update({
      topic,
      notes: input.notes?.trim() ?? "",
      scheduled_for: input.scheduled_for,
    })
    .eq("id", id)
    .eq("status", "planned");
  if (error) return { ok: false, error: error.message };

  revalidatePath("/content");
  return { ok: true };
}

export async function deleteCarouselPost(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Collect the rendered slide files before the cascade wipes the rows.
  const { data: options } = await supabase
    .from("carousel_options")
    .select("slides")
    .eq("post_id", id);
  const paths = (options ?? [])
    .flatMap((o) => (o.slides ?? []) as CarouselSlide[])
    .map((s) => s.image_path)
    .filter((p): p is string => Boolean(p));

  const { error } = await supabase
    .from("carousel_posts")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (paths.length) {
    await supabase.storage
      .from(STORAGE_BUCKETS.carouselSlides)
      .remove(paths);
  }

  revalidatePath("/content");
  return { ok: true };
}

/** "Generate now" + the retry button: (re)start the pipeline immediately. */
export async function generateCarouselNow(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const res = await startCarouselGeneration(supabase, id);
  if (!res.ok) return { ok: false, error: res.error ?? "Couldn't start." };

  revalidatePath("/content");
  return { ok: true };
}

/** The review screen's "Use this design". */
export async function approveCarouselOption(
  postId: string,
  optionId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("carousel_posts")
    .update({ status: "approved", chosen_option_id: optionId })
    .eq("id", postId)
    .in("status", ["ready", "approved"]);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/content");
  return { ok: true };
}

/**
 * Re-render ONE design option (keeps its copy): clears the slide images so
 * the pipeline picks the option back up as "missing slides".
 */
export async function regenerateCarouselOption(
  optionId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: option } = await supabase
    .from("carousel_options")
    .select("id, post_id, slides")
    .eq("id", optionId)
    .maybeSingle();
  if (!option) return { ok: false, error: "Design not found." };

  const cleared = ((option.slides ?? []) as CarouselSlide[]).map((s) => ({
    ...s,
    image_url: null,
    image_path: null,
  }));
  const { error } = await supabase
    .from("carousel_options")
    .update({ slides: cleared })
    .eq("id", optionId);
  if (error) return { ok: false, error: error.message };

  // Back into the pipeline. A previously approved choice of THIS design is
  // stale now — ask for a fresh approval.
  const { data: post } = await supabase
    .from("carousel_posts")
    .select("chosen_option_id")
    .eq("id", option.post_id)
    .maybeSingle();
  const { error: postError } = await supabase
    .from("carousel_posts")
    .update({
      status: "rendering",
      error: null,
      analysis: { runStartedAt: Date.now() },
      locked_at: null,
      ...(post?.chosen_option_id === optionId
        ? { chosen_option_id: null }
        : {}),
    })
    .eq("id", option.post_id);
  if (postError) return { ok: false, error: postError.message };

  revalidatePath("/content");
  return { ok: true };
}

/**
 * Advance any in-progress carousel while the page is open (the local-dev
 * cron substitute + orphan resumer — same pattern as `advanceProspecting`).
 * Never throws; the next poll retries.
 */
export async function advanceCarousels(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  try {
    await processPendingCarousels(supabase, 2);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---- 0118: client approval, and getting it posted -------------------------

/**
 * Send a post to the client for approval.
 *
 * Approval used to happen in WhatsApp and in screenshots, and was lost. Now
 * it is a link with a state behind it, which is what makes "the client hasn't
 * approved this yet" something the publisher can enforce rather than
 * something somebody has to remember.
 */
export async function sendForClientApproval(
  postId: string,
  clientId: string,
): Promise<ActionResult<{ url: string }>> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("carousel_posts")
    .select("id, topic, chosen_option_id, approval_token")
    .eq("id", postId)
    .maybeSingle();
  if (!post) return { ok: false, error: "That post no longer exists." };
  if (!post.chosen_option_id) {
    return { ok: false, error: "Pick a design first — there's nothing to show them." };
  }

  const { error } = await supabase
    .from("carousel_posts")
    .update({
      client_id: clientId,
      client_status: "sent",
      client_feedback: null,
      client_decided_at: null,
    })
    .eq("id", postId);
  if (error) return { ok: false, error: error.message };

  const url = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/public/content/${post.approval_token}`;

  // Email it when they have an address; the link is returned either way, so
  // it can be pasted into WhatsApp — which is how most of these actually go.
  const { data: client } = await supabase
    .from("clients")
    .select("name, email")
    .eq("id", clientId)
    .maybeSingle();
  if (client?.email) {
    await sendAndLogEmail(supabase, {
      to: client.email,
      kind: "compose",
      sentBy: profile.id,
      clientId,
      message: {
        transport: "generic",
        subject: `A post for your approval — ${post.topic}`,
        body: `Hi${client.name ? ` ${client.name.split(/\s+/)[0]}` : ""},\nHere's the next post ready to go. Have a look and either approve it or tell us what to change — it takes a second.`,
        cta: { href: url, label: "See the post" },
      },
    });
  }

  revalidatePath("/content");
  return { ok: true, url };
}

/**
 * Queue a post for Instagram and/or Facebook.
 *
 * Only ever queues: the publisher owns the actual send, re-checks the
 * client's approval immediately before it, and holds a lease so two ticks
 * can't post the same thing twice.
 */
export async function scheduleSocialPost(input: {
  postId: string;
  accountIds: string[];
  scheduledFor: string;
}): Promise<ActionResult<{ queued: number }>> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };
  if (!input.accountIds.length) {
    return { ok: false, error: "Pick at least one account." };
  }

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("carousel_posts")
    .select("id, topic, caption, hashtags, chosen_option_id, client_id, client_status")
    .eq("id", input.postId)
    .maybeSingle();
  if (!post) return { ok: false, error: "That post no longer exists." };
  if (!post.chosen_option_id) {
    return { ok: false, error: "Pick a design first." };
  }
  if (post.client_id && post.client_status !== "approved") {
    return {
      ok: false,
      error: "The client hasn't approved this one yet.",
    };
  }

  const { data: option } = await supabase
    .from("carousel_options")
    .select("slides")
    .eq("id", post.chosen_option_id)
    .maybeSingle();
  const media = (option?.slides ?? [])
    .filter((s) => s.image_url)
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ url: s.image_url! }));
  if (!media.length) {
    return { ok: false, error: "That design has no rendered slides yet." };
  }

  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, platform")
    .in("id", input.accountIds)
    .eq("active", true);
  if (!accounts?.length) {
    return { ok: false, error: "Those accounts aren't connected." };
  }

  const caption = [
    post.caption,
    post.hashtags.length
      ? post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { error } = await supabase.from("social_posts").insert(
    accounts.map((a) => ({
      platform: a.platform,
      account_id: a.id,
      carousel_post_id: post.id,
      client_id: post.client_id,
      caption,
      media,
      scheduled_for: input.scheduledFor,
      status: "scheduled" as const,
      created_by: profile.id,
    })),
  );
  if (error) return { ok: false, error: error.message };

  await supabase
    .from("carousel_posts")
    .update({ status: "scheduled" })
    .eq("id", post.id);

  revalidatePath("/content");
  return { ok: true, queued: accounts.length };
}

/** The accounts a post can go to. Never returns the token, encrypted or not. */
export async function listSocialAccounts(): Promise<
  { id: string; platform: string; name: string; clientId: string | null }[]
> {
  const profile = await getProfile();
  if (!profile) return [];
  const supabase = await createClient();
  try {
    const { data } = await supabase
      .from("social_accounts")
      .select("id, platform, name, client_id")
      .eq("active", true)
      .order("name");
    return (data ?? []).map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      clientId: a.client_id,
    }));
  } catch {
    // 0118 not applied yet.
    return [];
  }
}
