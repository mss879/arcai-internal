import "server-only";

/**
 * Thin Google Places API (New) client for the "Find Leads" prospecting agent.
 * `places:searchText` enumerates real registered businesses in an area with
 * the one field web search can never give us reliably: `websiteUri` — present
 * or absent, which IS the prospecting filter.
 *
 * Reads GOOGLE_PLACES_API_KEY (enable "Places API (New)" on the same Google
 * Cloud project as the PageSpeed key). SERVER ONLY. Never throws — returns []
 * on any failure, mirroring the Firecrawl client.
 */

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

export function isPlacesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
}

export type PlaceBusiness = {
  placeId: string;
  name: string;
  address: string;
  phone: string;
  /** "" when the business has no website registered — the money signal. */
  website: string;
  rating: number | null;
  ratingCount: number;
  /** Google place types, e.g. ["restaurant", "food"] — drives the deny-list. */
  types: string[];
  businessStatus: string;
};

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  types?: string[];
  businessStatus?: string;
};

function toBusiness(p: RawPlace): PlaceBusiness | null {
  const name = p.displayName?.text?.trim() ?? "";
  if (!p.id || !name) return null;
  return {
    placeId: p.id,
    name,
    address: p.formattedAddress?.trim() ?? "",
    phone: (p.nationalPhoneNumber || p.internationalPhoneNumber || "").trim(),
    website: p.websiteUri?.trim() ?? "",
    rating: typeof p.rating === "number" ? p.rating : null,
    ratingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : 0,
    types: Array.isArray(p.types) ? p.types : [],
    businessStatus: p.businessStatus ?? "",
  };
}

/** Exported for the fixture tests. */
export function parsePlacesResponse(json: unknown): {
  businesses: PlaceBusiness[];
  nextPageToken: string;
} {
  const obj = (json ?? {}) as { places?: RawPlace[]; nextPageToken?: string };
  const businesses = (Array.isArray(obj.places) ? obj.places : [])
    .map(toBusiness)
    .filter((b): b is PlaceBusiness => b !== null);
  return {
    businesses,
    nextPageToken:
      typeof obj.nextPageToken === "string" ? obj.nextPageToken : "",
  };
}

/**
 * One text-search page (up to 20 places). Pass the returned nextPageToken to
 * fetch the following page (Google serves at most 3 pages / 60 per query).
 * `error` carries the failure reason (still never throws) so callers can
 * distinguish "the area has no businesses" from "the API call failed".
 */
export async function placesSearchText(
  query: string,
  opts?: { pageToken?: string },
): Promise<{ businesses: PlaceBusiness[]; nextPageToken: string; error?: string }> {
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    return {
      businesses: [],
      nextPageToken: "",
      error: "GOOGLE_PLACES_API_KEY is not set.",
    };
  }

  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        // Only the fields we read — the field mask is what Google bills on.
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.nationalPhoneNumber",
          "places.internationalPhoneNumber",
          "places.websiteUri",
          "places.rating",
          "places.userRatingCount",
          "places.types",
          "places.businessStatus",
          "nextPageToken",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: query,
        pageSize: 20,
        ...(opts?.pageToken ? { pageToken: opts.pageToken } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[places] searchText HTTP ${res.status}: ${detail.slice(0, 300)}`,
      );
      return {
        businesses: [],
        nextPageToken: "",
        error: `HTTP ${res.status}${placesErrorHint(detail)}`,
      };
    }
    return parsePlacesResponse(await res.json().catch(() => null));
  } catch (e) {
    console.error(
      "[places] searchText failed:",
      e instanceof Error ? e.message : e,
    );
    return {
      businesses: [],
      nextPageToken: "",
      error: e instanceof Error ? e.message : "request failed",
    };
  }
}

/** Pull the human-readable message out of a Places error body, if any. */
function placesErrorHint(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    const msg = parsed.error?.message?.trim();
    return msg ? ` — ${msg.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

/**
 * All pages for one query, capped at `limit` businesses. "operational only" —
 * closed businesses are dropped here so the pipeline never sees them.
 * `error` is set when the underlying API call failed (never throws).
 */
export async function placesSearchAll(
  query: string,
  limit: number,
): Promise<{ businesses: PlaceBusiness[]; error?: string }> {
  const out: PlaceBusiness[] = [];
  let pageToken = "";
  let error: string | undefined;
  for (let page = 0; page < 3 && out.length < limit; page++) {
    const { businesses, nextPageToken, error: pageError } =
      await placesSearchText(query, { pageToken: pageToken || undefined });
    if (pageError && !error) error = pageError;
    for (const b of businesses) {
      if (b.businessStatus && b.businessStatus !== "OPERATIONAL") continue;
      out.push(b);
      if (out.length >= limit) break;
    }
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return { businesses: out, error };
}
