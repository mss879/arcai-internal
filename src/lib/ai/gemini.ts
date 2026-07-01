import "server-only";

import type { AspectRatio, ImageQuality } from "@/lib/content";

/**
 * Thin wrapper around the Gemini image-generation REST API used by
 * Content Studio. Talks to Google over plain `fetch` (no SDK), mirroring
 * how `openai.ts` works — the feature lights up the moment a
 * `GEMINI_API_KEY` is present, with nothing to install.
 *
 * Model: "Nano Banana 2" = Gemini 3.1 Flash Image. The live API id is
 * `gemini-3.1-flash-image-preview`; override with `GEMINI_IMAGE_MODEL`
 * (e.g. switch to `gemini-3.1-flash-image` once it reaches GA, or to
 * `gemini-3-pro-image-preview` for the premium tier).
 *
 * Everything here is server-only; the key never reaches the browser.
 */

const BASE_URL =
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";

/** True when a Gemini key is configured. */
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  return key;
}

/** A reference image, already fetched and base64-encoded. */
export type InlineImage = { mimeType: string; data: string };

/** A single generated image returned by the model. */
export type GeneratedImage = { mimeType: string; data: string };

export type GenerateImageInput = {
  prompt: string;
  references: InlineImage[];
  aspectRatio: AspectRatio;
  imageSize: ImageQuality;
};

type Part =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

/**
 * Generate a single image. The model has no `candidateCount` for images,
 * so callers wanting N variations run this N times in parallel.
 */
export async function generateImage(
  input: GenerateImageInput,
): Promise<GeneratedImage> {
  const parts: Part[] = [{ text: input.prompt }];
  for (const ref of input.references) {
    parts.push({
      inline_data: { mime_type: ref.mimeType, data: ref.data },
    });
  }

  const res = await fetch(
    `${BASE_URL}/models/${GEMINI_IMAGE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey(),
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini image generation failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  const candidateParts: unknown[] =
    json?.candidates?.[0]?.content?.parts ?? [];

  for (const part of candidateParts) {
    // The REST response uses camelCase `inlineData`; accept snake_case too.
    const inline =
      (part as { inlineData?: { data?: string; mimeType?: string } })
        .inlineData ??
      (part as { inline_data?: { data?: string; mime_type?: string } })
        .inline_data;
    if (inline?.data) {
      return {
        data: inline.data,
        mimeType:
          (inline as { mimeType?: string; mime_type?: string }).mimeType ||
          (inline as { mime_type?: string }).mime_type ||
          "image/png",
      };
    }
  }

  // No image part — surface any text the model returned (often a refusal).
  const text = candidateParts
    .map((p) => (p as { text?: string }).text)
    .filter(Boolean)
    .join(" ")
    .trim();
  throw new Error(
    text
      ? `Gemini returned no image. Model said: ${text}`
      : "Gemini returned no image data.",
  );
}

/**
 * Download a (public) image URL and return it base64-encoded so it can be
 * sent to Gemini as an inline reference part.
 */
export async function fetchAsInlineImage(url: string): Promise<InlineImage> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image (${res.status}).`);
  }
  const mimeType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString("base64") };
}
