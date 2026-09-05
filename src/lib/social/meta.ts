import "server-only";

/**
 * Instagram and Facebook publishing, through the Meta Graph API (0118).
 *
 * Two different shapes for what looks like one action:
 *
 *   • Instagram is two-phase. Every image becomes a "container", the
 *     containers become a carousel container, and only then is it published.
 *     Meta fetches the images from public URLs itself — which is why the
 *     carousel-slides bucket is public and why a signed URL would NOT work.
 *   • Facebook uploads each photo unpublished and then makes one feed post
 *     that attaches them.
 *
 * Everything here returns a result rather than throwing: publishing runs on a
 * shared tick, and one client's expired token must not take the pass down.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta's own limits, worth failing on before we call rather than after. */
export const MAX_CAROUSEL_ITEMS = 10;

export type PublishResult =
  | { ok: true; externalId: string; permalink: string | null }
  | { ok: false; error: string };

type GraphResponse = {
  id?: string;
  permalink?: string;
  error?: { message?: string; type?: string; code?: number };
};

/**
 * One Graph call. Errors come back as `error.message`, which is what Meta
 * actually explains the problem in — surfacing it verbatim is far more useful
 * to whoever has to fix it than "publish failed".
 */
async function graph(
  path: string,
  params: Record<string, string>,
  method: "GET" | "POST" = "POST",
): Promise<{ ok: true; data: GraphResponse } | { ok: false; error: string }> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams(params);

  try {
    const res = await fetch(
      method === "GET" ? `${url}?${body}` : url.toString(),
      {
        method,
        ...(method === "POST" ? { body } : {}),
        // The tick has a deadline; a hung Graph call must not eat it.
        signal: AbortSignal.timeout(20_000),
      },
    );
    const data = (await res.json().catch(() => ({}))) as GraphResponse;
    if (!res.ok || data.error) {
      return {
        ok: false,
        error: data.error?.message ?? `Meta returned ${res.status}.`,
      };
    }
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "TimeoutError"
          ? "Meta didn't answer in time."
          : e instanceof Error
            ? e.message
            : "Could not reach Meta.",
    };
  }
}

/**
 * Publish to Instagram.
 *
 * A single image skips the carousel wrapper — Meta rejects a carousel of one.
 */
export async function publishToInstagram(input: {
  igUserId: string;
  accessToken: string;
  caption: string;
  imageUrls: string[];
}): Promise<PublishResult> {
  const images = input.imageUrls.slice(0, MAX_CAROUSEL_ITEMS);
  if (!images.length) return { ok: false, error: "No images to post." };

  let creationId: string;

  if (images.length === 1) {
    const single = await graph(`${input.igUserId}/media`, {
      image_url: images[0],
      caption: input.caption,
      access_token: input.accessToken,
    });
    if (!single.ok) return single;
    if (!single.data.id) return { ok: false, error: "Meta returned no container." };
    creationId = single.data.id;
  } else {
    // Phase 1: one container per image, flagged as carousel items.
    const children: string[] = [];
    for (const url of images) {
      const item = await graph(`${input.igUserId}/media`, {
        image_url: url,
        is_carousel_item: "true",
        access_token: input.accessToken,
      });
      if (!item.ok) return item;
      if (!item.data.id) return { ok: false, error: "Meta returned no container." };
      children.push(item.data.id);
    }

    // Phase 2: the carousel itself.
    const carousel = await graph(`${input.igUserId}/media`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: input.caption,
      access_token: input.accessToken,
    });
    if (!carousel.ok) return carousel;
    if (!carousel.data.id) return { ok: false, error: "Meta returned no container." };
    creationId = carousel.data.id;
  }

  // Phase 3: publish. Anything before this leaves an unpublished container,
  // which expires on its own — nothing to clean up.
  const published = await graph(`${input.igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: input.accessToken,
  });
  if (!published.ok) return published;
  if (!published.data.id) return { ok: false, error: "Meta published nothing." };

  const permalink = await graph(
    published.data.id,
    { fields: "permalink", access_token: input.accessToken },
    "GET",
  );

  return {
    ok: true,
    externalId: published.data.id,
    permalink: permalink.ok ? (permalink.data.permalink ?? null) : null,
  };
}

/**
 * Publish to a Facebook Page.
 *
 * Photos go up unpublished first, then one feed post attaches them — posting
 * them directly would produce N separate photo posts instead of one.
 */
export async function publishToFacebook(input: {
  pageId: string;
  accessToken: string;
  caption: string;
  imageUrls: string[];
}): Promise<PublishResult> {
  const images = input.imageUrls.slice(0, MAX_CAROUSEL_ITEMS);
  if (!images.length) return { ok: false, error: "No images to post." };

  const attached: string[] = [];
  for (const url of images) {
    const photo = await graph(`${input.pageId}/photos`, {
      url,
      published: "false",
      access_token: input.accessToken,
    });
    if (!photo.ok) return photo;
    if (photo.data.id) attached.push(photo.data.id);
  }

  const params: Record<string, string> = {
    message: input.caption,
    access_token: input.accessToken,
  };
  attached.forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });

  const post = await graph(`${input.pageId}/feed`, params);
  if (!post.ok) return post;
  if (!post.data.id) return { ok: false, error: "Meta published nothing." };

  return {
    ok: true,
    externalId: post.data.id,
    // A Page post id is `<pageId>_<postId>`; the permalink is derivable.
    permalink: `https://www.facebook.com/${post.data.id.replace("_", "/posts/")}`,
  };
}
