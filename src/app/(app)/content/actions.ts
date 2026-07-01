"use server";

import { revalidatePath } from "next/cache";

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
import type { ActionResult, ContentGeneration } from "@/lib/types";

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
