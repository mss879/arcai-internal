/**
 * The shape of a company research briefing stored in
 * `lead_research.report` (jsonb), plus coercion helpers shared by
 * the server-side generator and the client-side report views.
 *
 * Deliberately NOT server-only: client components parse the jsonb
 * column with `parseResearchReport` before rendering.
 */

export type ResearchCompetitor = { name: string; note: string };
export type ResearchNewsItem = { title: string; summary: string; url: string };
export type ResearchSource = { url: string; title: string; query: string };

export type ResearchReport = {
  overview: string;
  industry: string;
  headquarters: string;
  company_size: string;
  founded: string;
  website: string;
  linkedin_url: string;
  products_services: string[];
  competitors: ResearchCompetitor[];
  recent_news: ResearchNewsItem[];
  pain_points: string[];
  talking_points: string[];
  discovery_questions: string[];
  /** "ai" for OpenAI-written briefings, "basic" for the no-key fallback. */
  generated_by: "ai" | "basic";
};

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function strArr(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => str(v)).filter(Boolean) : [];
}

function competitors(x: unknown): ResearchCompetitor[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((c) => ({
      name: str((c as Record<string, unknown>)?.name),
      note: str((c as Record<string, unknown>)?.note),
    }))
    .filter((c) => c.name);
}

function news(x: unknown): ResearchNewsItem[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((n) => ({
      title: str((n as Record<string, unknown>)?.title),
      summary: str((n as Record<string, unknown>)?.summary),
      url: str((n as Record<string, unknown>)?.url),
    }))
    .filter((n) => n.title);
}

/** Coerce the jsonb column into a well-formed report (missing keys → empty). */
export function parseResearchReport(x: unknown): ResearchReport {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return {
    overview: str(r.overview),
    industry: str(r.industry),
    headquarters: str(r.headquarters),
    company_size: str(r.company_size),
    founded: str(r.founded),
    website: str(r.website),
    linkedin_url: str(r.linkedin_url),
    products_services: strArr(r.products_services),
    competitors: competitors(r.competitors),
    recent_news: news(r.recent_news),
    pain_points: strArr(r.pain_points),
    talking_points: strArr(r.talking_points),
    discovery_questions: strArr(r.discovery_questions),
    generated_by: r.generated_by === "basic" ? "basic" : "ai",
  };
}

/** Coerce the jsonb sources column into a clean list. */
export function parseResearchSources(x: unknown): ResearchSource[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((s) => ({
      url: str((s as Record<string, unknown>)?.url),
      title: str((s as Record<string, unknown>)?.title),
      query: str((s as Record<string, unknown>)?.query),
    }))
    .filter((s) => s.url);
}
