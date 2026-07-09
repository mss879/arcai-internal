import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  CarouselPostStatus,
  CarouselSlide,
  Database,
} from "@/lib/database.types";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import {
  fetchAsInlineImage,
  generateImage,
  isGeminiConfigured,
  type InlineImage,
} from "@/lib/ai/gemini";
import { sendPushToUser } from "@/lib/push";

type DB = SupabaseClient<Database>;

/**
 * Carousel Planner pipeline — turns a calendar topic into TWO complete
 * carousel design options, advanced step-by-step by the automation tick
 * exactly like lead research:
 *
 *   planned ──(scheduled_for within lead time)──▶ copywriting
 *   copywriting : one OpenAI call writes 2 concepts (5–8 slides of
 *                 headline/body each) + the shared caption/hashtags,
 *                 and inserts the 2 carousel_options rows
 *   rendering   : ONE slide per step — Gemini renders it on-brand
 *                 (guided by the reference library + the option's own
 *                 slide 1 so the carousel stays cohesive), uploads the
 *                 PNG and fills the option's `slides` jsonb
 *   ready       : all slides rendered → push notification
 *   approved    : the user picked a design in the review screen
 *
 * Every step is claimed with a short lease (`locked_at`) and committed
 * fenced on it, so the tick and an inline "Generate now" drain can never
 * process the same step twice, and a step abandoned by a killed
 * serverless run is retried on the next minute-tick.
 */

/** How many days before `scheduled_for` generation kicks off automatically. */
export const GENERATE_DAYS_AHEAD = 3;

/** Instagram carousel format: portrait 4:5 at high quality. */
const SLIDE_ASPECT = "4:5" as const;
const SLIDE_QUALITY = "2K" as const;

/** Exactly this many design options per post. */
const OPTION_COUNT = 2;
const MIN_SLIDES = 5;
const MAX_SLIDES = 8;

/** Brand reference images inlined per Gemini call (payload budget). */
const MAX_BRAND_REFS = 3;

/**
 * A claimed step's lease. A single step is one OpenAI JSON call or one
 * Gemini slide render — both bounded well under this — yet short enough
 * that an abandoned step is retried on the next minute-tick.
 */
const LOCK_TTL_MS = 60 * 1000;

/** Transient-failure grace: a step may fail this many times before the
 *  post is marked `error` (Gemini/OpenAI hiccups shouldn't kill a run). */
const MAX_STEP_FAILS = 3;

/** Non-terminal states the pipeline can be claimed in. */
const CLAIMABLE: CarouselPostStatus[] = ["copywriting", "rendering"];

export type CarouselTickResult = {
  triggered: number;
  processed: number;
  failed: number;
};

/** True when both halves of the pipeline have keys. */
export function isCarouselConfigured(): boolean {
  return isOpenAIConfigured() && isGeminiConfigured();
}

/** Outcome of advancing one step. */
export type CarouselStepOutcome = "advanced" | "done" | "error" | "skipped";

/** yyyy-mm-dd for "today + n days" (date-column comparisons). */
function datePlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Kick a post's generation off right now (the "Generate now" button and
 * the retry path). Resets the pipeline and runs the first steps inline so
 * the user sees progress immediately; the tick finishes the rest. If the
 * post already has its copy, rendering just resumes over missing slides.
 * Never throws.
 */
export async function startCarouselGeneration(
  supabase: DB,
  postId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isCarouselConfigured()) {
    return {
      ok: false,
      error:
        "AI isn't fully configured — add OPENAI_API_KEY and GEMINI_API_KEY.",
    };
  }

  // Restart from wherever there is work left: with options already
  // written, resume rendering; otherwise start at copywriting.
  const { count } = await supabase
    .from("carousel_options")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);

  const { error } = await supabase
    .from("carousel_posts")
    .update({
      status: count && count > 0 ? "rendering" : "copywriting",
      error: null,
      analysis: { runStartedAt: Date.now() },
      locked_at: null,
    })
    .eq("id", postId)
    .in("status", ["planned", "ready", "error", "copywriting", "rendering"]);
  if (error) return { ok: false, error: error.message };

  // One step inline (the copywriting call fits a serverless action's
  // budget; a slide render on top of it may not) — the page poll and the
  // minute-tick carry the rendering from there.
  await drainCarouselPost(supabase, postId, 1);
  return { ok: true };
}

/**
 * Advance a post through several steps in one pass (inline runs). Each
 * step commits + releases its lease independently, so outliving the
 * serverless budget just hands the rest to the tick.
 */
export async function drainCarouselPost(
  supabase: DB,
  postId: string,
  maxSteps = 2,
): Promise<CarouselStepOutcome> {
  let outcome: CarouselStepOutcome = "skipped";
  for (let i = 0; i < maxSteps; i++) {
    outcome = await advanceCarouselPost(supabase, postId);
    if (outcome !== "advanced") break;
  }
  return outcome;
}

/**
 * The tick's entry point: promote due `planned` posts into the pipeline,
 * then advance the stalest claimable post by ONE step (a step shares the
 * tick's budget with research/prospecting/SMS work).
 */
export async function processPendingCarousels(
  supabase: DB,
  limit = 1,
): Promise<CarouselTickResult> {
  const result: CarouselTickResult = { triggered: 0, processed: 0, failed: 0 };
  if (!isCarouselConfigured()) return result;

  // planned → copywriting once the post date is within the lead time.
  const { data: due } = await supabase
    .from("carousel_posts")
    .update({ status: "copywriting", error: null })
    .eq("status", "planned")
    .lte("scheduled_for", datePlusDays(GENERATE_DAYS_AHEAD))
    .select("id");
  result.triggered = due?.length ?? 0;

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: rows } = await supabase
    .from("carousel_posts")
    .select("id")
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, limit));
  if (!rows?.length) return result;

  for (const row of rows) {
    const outcome = await advanceCarouselPost(supabase, row.id);
    if (outcome === "advanced" || outcome === "done") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }
  return result;
}

/**
 * Advance ONE step of a carousel post's pipeline. Claims the row with a
 * lease, runs exactly one step, commits fenced on the lease and releases
 * it. `skipped` when another worker holds the lease. Never throws.
 */
export async function advanceCarouselPost(
  supabase: DB,
  postId: string,
): Promise<CarouselStepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  // Compare-and-swap claim, exactly like research.
  const { data: claimed } = await supabase
    .from("carousel_posts")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", postId)
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "skipped";
  const post = claimed[0];
  const token = post.locked_at;
  if (!token) return "skipped";

  const analysis = (post.analysis ?? {}) as Record<string, unknown>;
  // Carried across every commit (each step replaces `analysis` wholesale).
  const runStartedAt =
    typeof analysis.runStartedAt === "number" ? analysis.runStartedAt : Date.now();
  const failCount = typeof analysis.failCount === "number" ? analysis.failCount : 0;

  // Persist only while we still own the lease (fenced no-op otherwise).
  const commit = async (patch: Record<string, unknown>) => {
    const merged = {
      ...patch,
      analysis: {
        runStartedAt,
        ...((patch.analysis as Record<string, unknown>) ?? {}),
      },
    };
    const { error } = await supabase
      .from("carousel_posts")
      .update({ ...merged, locked_at: null })
      .eq("id", postId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  try {
    if (post.status === "copywriting") {
      await writeCarouselCopy(supabase, post.id, post.topic, post.notes);
      await commit({ status: "rendering", error: null, analysis: {} });
      return "advanced";
    }

    if (post.status === "rendering") {
      const rendered = await renderNextSlide(supabase, post.id);
      if (rendered === "none-left") {
        await commit({ status: "ready", error: null, analysis: {} });
        if (post.created_by) {
          await sendPushToUser({
            userId: post.created_by,
            title: "Carousel designs ready 🎨",
            body: `2 design options for “${post.topic}” are waiting for review.`,
            link: "/content",
          });
        }
        return "done";
      }
      if (rendered === "no-options") {
        // Options vanished (deleted mid-run) — restart at copywriting.
        await commit({ status: "copywriting", analysis: {} });
        return "advanced";
      }
      await commit({ status: "rendering", error: null, analysis: {} });
      return "advanced";
    }

    // Unknown/terminal — release the lease (fenced).
    await supabase
      .from("carousel_posts")
      .update({ locked_at: null })
      .eq("id", postId)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[carousels] step failed:", e);
    const message = e instanceof Error ? e.message : "Carousel step failed.";
    // Transient grace: keep the status and retry on later ticks until the
    // same step has failed MAX_STEP_FAILS times, then park it in `error`.
    const fenced =
      failCount + 1 >= MAX_STEP_FAILS
        ? { status: "error" as const, error: message, locked_at: null }
        : {
            analysis: { runStartedAt, failCount: failCount + 1 },
            locked_at: null,
          };
    await supabase
      .from("carousel_posts")
      .update(fenced)
      .eq("id", postId)
      .eq("locked_at", token);
    return failCount + 1 >= MAX_STEP_FAILS ? "error" : "advanced";
  }
}

// ---------------------------------------------------------------------------
// Copywriting
// ---------------------------------------------------------------------------

type CopyOption = { concept: string; slides: { headline: string; body: string }[] };
type CopyResult = { caption: string; hashtags: string[]; options: CopyOption[] };

/**
 * One OpenAI JSON call → 2 distinct carousel concepts + the shared post
 * caption, persisted as the post's caption/hashtags and 2 option rows
 * (upserted on (post_id, variant) so a retried step never duplicates).
 */
async function writeCarouselCopy(
  supabase: DB,
  postId: string,
  topic: string,
  notes: string,
): Promise<void> {
  // Textual brand hints from the reference library sharpen tone + visual
  // direction (the images themselves guide the render step).
  const { data: refs } = await supabase
    .from("content_references")
    .select("name, description")
    .order("created_at", { ascending: false })
    .limit(6);
  const brandHints = (refs ?? [])
    .map((r) => [r.name, r.description].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("\n");

  const system = `You are a senior social media strategist and copywriter for a digital agency. You write scroll-stopping Instagram carousel copy that is concise, concrete and useful — never generic filler. Reply with STRICT JSON only.`;

  const user = `Write TWO clearly different Instagram carousel concepts about this topic.

Topic: ${topic}
${notes ? `Extra direction from the owner: ${notes}` : ""}
${brandHints ? `Brand references (for tone + visual direction):\n${brandHints}` : ""}

Rules:
- Exactly ${OPTION_COUNT} options, each with ${MIN_SLIDES}-${MAX_SLIDES} slides.
- The two options must differ in angle AND visual direction (e.g. one bold typographic, one illustrative).
- Slide 1 is a HOOK: a short curiosity-driven headline that stops the scroll.
- The last slide is a CTA (follow / save / DM / visit).
- headline: max 8 words. body: max 25 words (may be "" on the hook slide).
- "concept": one sentence of visual direction for a designer (style, palette, layout system).
- Also write ONE shared Instagram caption (2-4 short paragraphs, no hashtags inside) and 8-12 hashtags (with #).

Return JSON exactly in this shape:
{
  "caption": "...",
  "hashtags": ["#...", "..."],
  "options": [
    { "concept": "...", "slides": [ { "headline": "...", "body": "..." } ] },
    { "concept": "...", "slides": [ { "headline": "...", "body": "..." } ] }
  ]
}`;

  const raw = await openaiChatJSON(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.8, timeoutMs: 45_000 },
  );

  const parsed = parseCopy(raw);

  const { error: postError } = await supabase
    .from("carousel_posts")
    .update({ caption: parsed.caption, hashtags: parsed.hashtags })
    .eq("id", postId);
  if (postError) throw new Error(postError.message);

  for (let i = 0; i < OPTION_COUNT; i++) {
    const option = parsed.options[i];
    const slides: CarouselSlide[] = option.slides.map((s, idx) => ({
      index: idx,
      headline: s.headline,
      body: s.body,
      image_url: null,
      image_path: null,
    }));
    const { error } = await supabase
      .from("carousel_options")
      .upsert(
        { post_id: postId, variant: i + 1, concept: option.concept, slides },
        { onConflict: "post_id,variant" },
      );
    if (error) throw new Error(error.message);
  }
}

/** Parse + clamp the model's JSON. Throws a readable error on junk. */
function parseCopy(raw: string): CopyResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("The AI copy response was not valid JSON. Retrying…");
  }
  const obj = json as Partial<CopyResult>;
  const options = Array.isArray(obj.options)
    ? obj.options
        .filter(
          (o): o is CopyOption =>
            !!o && typeof o === "object" && Array.isArray((o as CopyOption).slides),
        )
        .slice(0, OPTION_COUNT)
    : [];
  if (options.length < OPTION_COUNT) {
    throw new Error("The AI returned fewer than 2 carousel concepts.");
  }

  const cleaned = options.map((o) => {
    const slides = o.slides
      .map((s) => ({
        headline: String(s?.headline ?? "").trim(),
        body: String(s?.body ?? "").trim(),
      }))
      .filter((s) => s.headline || s.body)
      .slice(0, MAX_SLIDES);
    if (slides.length < MIN_SLIDES) {
      throw new Error("The AI returned a concept with too few slides.");
    }
    return { concept: String(o.concept ?? "").trim(), slides };
  });

  return {
    caption: String(obj.caption ?? "").trim(),
    hashtags: Array.isArray(obj.hashtags)
      ? obj.hashtags
          .map((h) => String(h).trim())
          .filter(Boolean)
          .map((h) => (h.startsWith("#") ? h : `#${h}`))
          .slice(0, 15)
      : [],
    options: cleaned,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function extFor(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

/**
 * Render the next missing slide (options in variant order, slides in
 * index order). Returns "rendered" when it produced one, "none-left"
 * when every slide of both options has an image.
 */
async function renderNextSlide(
  supabase: DB,
  postId: string,
): Promise<"rendered" | "none-left" | "no-options"> {
  const { data: options } = await supabase
    .from("carousel_options")
    .select("*")
    .eq("post_id", postId)
    .order("variant", { ascending: true });
  if (!options?.length) return "no-options";

  for (const option of options) {
    const slides = (option.slides ?? []) as CarouselSlide[];
    const idx = slides.findIndex((s) => !s.image_url);
    if (idx === -1) continue;

    const slide = slides[idx];
    const references = await slideReferences(supabase, slides, idx);
    const image = await generateImage({
      prompt: slidePrompt(option.concept, slides, idx),
      references,
      aspectRatio: SLIDE_ASPECT,
      imageSize: SLIDE_QUALITY,
    });

    const path = `${postId}/${option.variant}/${String(idx + 1).padStart(2, "0")}.${extFor(image.mimeType)}`;
    const bytes = Buffer.from(image.data, "base64");
    // upsert: a lease-expired duplicate render just overwrites the same file.
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.carouselSlides)
      .upload(path, bytes, { contentType: image.mimeType, upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    const { data: pub } = supabase.storage
      .from(STORAGE_BUCKETS.carouselSlides)
      .getPublicUrl(path);

    const next = slides.slice();
    next[idx] = { ...slide, image_url: pub.publicUrl, image_path: path };
    const { error } = await supabase
      .from("carousel_options")
      .update({ slides: next })
      .eq("id", option.id);
    if (error) throw new Error(error.message);
    return "rendered";
  }

  return "none-left";
}

/**
 * Reference images for one slide's render: the brand library, plus —
 * for every slide after the first — the option's own rendered slide 1,
 * so the whole carousel shares one visual system.
 */
async function slideReferences(
  supabase: DB,
  slides: CarouselSlide[],
  idx: number,
): Promise<InlineImage[]> {
  const { data: refRows } = await supabase
    .from("content_references")
    .select("image_url")
    .order("created_at", { ascending: false })
    .limit(MAX_BRAND_REFS);

  const urls: string[] = [];
  // Slide 1 first — the prompt tells the model the FIRST image is the
  // carousel's style anchor.
  if (idx > 0 && slides[0]?.image_url) urls.push(slides[0].image_url);
  for (const r of refRows ?? []) urls.push(r.image_url);

  const settled = await Promise.allSettled(urls.map(fetchAsInlineImage));
  // A broken reference shouldn't block the render — just skip it.
  return settled
    .filter(
      (s): s is PromiseFulfilledResult<InlineImage> => s.status === "fulfilled",
    )
    .map((s) => s.value);
}

/** The strict per-slide design brief Gemini renders from. */
function slidePrompt(
  concept: string,
  slides: CarouselSlide[],
  idx: number,
): string {
  const slide = slides[idx];
  const total = slides.length;
  const role =
    idx === 0
      ? "This is the HOOK slide — make the headline huge and impossible to scroll past."
      : idx === total - 1
        ? "This is the CTA slide — clear call to action, calm layout."
        : "This is a content slide — headline on top, supporting text beneath, generous whitespace.";

  return [
    `Design slide ${idx + 1} of ${total} of an Instagram carousel (portrait 4:5, 1080x1350).`,
    concept ? `Design direction: ${concept}` : "",
    `The slide must display EXACTLY this text, perfectly spelled and clearly legible:`,
    `Headline: "${slide.headline}"`,
    slide.body ? `Supporting text: "${slide.body}"` : "",
    role,
    idx > 0
      ? "The FIRST attached image is slide 1 of this same carousel — copy its exact layout system, background treatment, palette and typography so every slide looks like one set."
      : "Match the brand style of the attached reference images: their colors, typography and overall art direction.",
    `Include a small "${idx + 1}/${total}" page marker in a corner.`,
    "Flat, modern graphic design. No watermarks, no borders, no phone mockups, no extra text beyond what is specified.",
  ]
    .filter(Boolean)
    .join("\n");
}
