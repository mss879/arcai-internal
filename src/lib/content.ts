/**
 * Client-safe option metadata for Content Studio.
 *
 * These describe the choices a user makes in the Generate tab — quality,
 * size (aspect ratio) and how many variations to produce — and map directly
 * onto the Gemini 3.1 Flash Image (`imageConfig`) request fields.
 *
 * Keep this file free of `server-only` imports: it is shared by client
 * components and the server-side Gemini wrapper alike.
 */

/** Gemini `imageConfig.imageSize` values, surfaced as "quality". */
export const IMAGE_QUALITIES = [
  { value: "1K", label: "Standard", hint: "Fast · ~1K resolution" },
  { value: "2K", label: "High", hint: "Sharper · ~2K resolution" },
  { value: "4K", label: "Ultra", hint: "Max detail · ~4K (slower)" },
] as const;

export type ImageQuality = (typeof IMAGE_QUALITIES)[number]["value"];

/** Gemini `imageConfig.aspectRatio` values, surfaced as "size". */
export const ASPECT_RATIOS = [
  { value: "1:1", label: "Square", hint: "1:1 · feed post" },
  { value: "16:9", label: "Landscape", hint: "16:9 · banner / web" },
  { value: "9:16", label: "Portrait", hint: "9:16 · story / reel" },
  { value: "4:5", label: "Portrait (4:5)", hint: "4:5 · Instagram" },
  { value: "4:3", label: "Standard", hint: "4:3 · classic" },
  { value: "3:4", label: "Tall", hint: "3:4 · vertical" },
  { value: "21:9", label: "Ultrawide", hint: "21:9 · cinematic" },
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number]["value"];

/** How many variations the user may request in a single run. */
export const MAX_GENERATIONS = 4;

/** Cap on reference images attached to a single generation request. */
export const MAX_REFERENCES_PER_REQUEST = 6;

export const DEFAULT_QUALITY: ImageQuality = "2K";
export const DEFAULT_ASPECT_RATIO: AspectRatio = "1:1";

export function isImageQuality(v: string): v is ImageQuality {
  return IMAGE_QUALITIES.some((q) => q.value === v);
}

export function isAspectRatio(v: string): v is AspectRatio {
  return ASPECT_RATIOS.some((a) => a.value === v);
}
