import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import { benchmarkByService, finishedProjects } from "@/lib/project-history";

type DB = SupabaseClient<Database>;

/**
 * The project brief, written from the sale (AI-1).
 *
 * Everything needed to start a job properly was already agreed — in the quote
 * that was signed, the proposal that was sent and the WhatsApp thread where
 * the real requirements were actually discussed. It then gets retyped from
 * memory into an empty project form, badly, which is where scope arguments
 * are born.
 *
 * Drafts, never saves — the receipt.ts contract (MON-8). The team sees the
 * scope, tasks, assets and timeline in the form and edits them before
 * anything is written.
 */

export type BriefTask = { title: string; days_from_start: number | null };

export type ProjectBrief = {
  name: string;
  summary: string;
  /** What is explicitly IN scope. */
  deliverables: string[];
  /** What is explicitly OUT — the half that prevents the argument. */
  exclusions: string[];
  tasks: BriefTask[];
  assets: { title: string; category: string | null; required: boolean }[];
  /** Working days, grounded in what past jobs of this type actually took. */
  estimated_days: number | null;
  service_type: string | null;
  /** Anything the sale left genuinely unclear — asked, not guessed. */
  open_questions: string[];
};

const ASSET_CATEGORIES = ["brand", "content", "photos", "access"];

function prompt(benchmarkLine: string): string {
  return `You are a delivery lead at ARC AI, a digital agency in Sri Lanka, turning a closed sale into a project plan.

Return STRICT JSON with exactly these keys:
{
  "name": string,                 // the project's name, e.g. "Cafe Aroma — Business website"
  "summary": string,              // 2-3 sentences: what we agreed to build and for whom
  "deliverables": string[],       // 3-8 concrete things the client receives
  "exclusions": string[],         // 2-5 things explicitly NOT included
  "tasks": [{ "title": string, "days_from_start": number|null }],   // 5-12 internal tasks, in order
  "assets": [{ "title": string, "category": "brand"|"content"|"photos"|"access"|null, "required": boolean }],
  "estimated_days": number|null,  // calendar days start to delivery
  "service_type": string|null,    // one of: ${Object.keys(SERVICE_TYPE_LABELS).join(", ")}
  "open_questions": string[]      // 0-5 things the sale genuinely did not settle
}

Rules:
- Use ONLY what the source material says. Do not invent deliverables the client never agreed to buy — an invented deliverable becomes an argument later.
- Exclusions matter as much as deliverables. If the material implies a boundary ("blog later", "we'll handle our own copy"), say so.
- Assets are things WE NEED FROM THE CLIENT before we can build: logo files, photos, copy, domain/hosting access.
- Anything ambiguous belongs in open_questions, never in deliverables as a guess.
${benchmarkLine}
- Output JSON only.`;
}

/**
 * Draft a brief for a lead / quote / client.
 *
 * Any of the three sources may be missing — a project created straight from a
 * WhatsApp conversation has no quote, and that is fine. It works from
 * whatever exists and says so in open_questions when the material is thin.
 */
export async function draftProjectBrief(
  supabase: DB,
  input: { leadId?: string | null; quoteId?: string | null; clientId?: string | null },
): Promise<{ ok: true; brief: ProjectBrief } | { ok: false; error: string }> {
  if (!isOpenAIConfigured())
    return { ok: false, error: "OPENAI_API_KEY is not configured." };

  const sources: string[] = [];

  // 1. The quote — what was actually agreed and for how much.
  if (input.quoteId) {
    const { data: quote } = await supabase
      .from("quotes")
      .select("title, customer_name, items, grand_total, currency, notes, terms, status")
      .eq("id", input.quoteId)
      .maybeSingle();
    if (quote) {
      sources.push(
        [
          `QUOTE (${quote.status}): ${quote.title}`,
          `Client: ${quote.customer_name}`,
          `Total: ${quote.currency} ${quote.grand_total}`,
          `Line items:\n${(quote.items ?? [])
            .map(
              (i) =>
                `- ${i.item}${i.description ? `: ${i.description}` : ""} (qty ${i.qty})`,
            )
            .join("\n")}`,
          quote.notes ? `Notes: ${quote.notes}` : "",
          quote.terms ? `Terms: ${quote.terms}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  // 2. The lead — the sales context, and any proposal attached to it.
  if (input.leadId) {
    const { data: lead } = await supabase
      .from("leads")
      .select("title, company, contact_name, value, notes, source, ai_summary")
      .eq("id", input.leadId)
      .maybeSingle();
    if (lead) {
      sources.push(
        [
          `LEAD: ${lead.title}`,
          lead.company ? `Company: ${lead.company}` : "",
          lead.contact_name ? `Contact: ${lead.contact_name}` : "",
          lead.value ? `Deal value: ${lead.value}` : "",
          lead.notes ? `Notes: ${lead.notes}` : "",
          lead.ai_summary ? `Research summary: ${lead.ai_summary}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

  }

  // 2b. The proposal. `proposals` has no lead/client foreign key (BIG-2 is the
  // fix for that), so it is matched on the client's name — the only link that
  // exists today. A near-miss is better than ignoring the document that spells
  // out the scope, and everything here is a draft a human checks anyway.
  const clientName = await lookupClientName(supabase, input);
  if (clientName) {
    const { data: proposals } = await supabase
      .from("proposals")
      .select("project_name, client_name, selection, content, grand_total")
      .ilike("client_name", clientName)
      .order("created_at", { ascending: false })
      .limit(1);
    const proposal = proposals?.[0];
    if (proposal) {
      sources.push(
        [
          `PROPOSAL: ${proposal.project_name} for ${proposal.client_name}`,
          `Total: ${proposal.grand_total}`,
          `What was selected: ${JSON.stringify(proposal.selection).slice(0, 2000)}`,
          `Document content: ${JSON.stringify(proposal.content).slice(0, 4000)}`,
        ].join("\n"),
      );
    }
  }

  // 3. The WhatsApp thread — where the real requirements usually live.
  // wa_contacts already carries lead_id / client_id, so no phone matching.
  {
    let contact: { id: string } | null = null;
    if (input.clientId) {
      const { data } = await supabase
        .from("wa_contacts")
        .select("id")
        .eq("client_id", input.clientId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      contact = data;
    }
    if (!contact && input.leadId) {
      const { data } = await supabase
        .from("wa_contacts")
        .select("id")
        .eq("lead_id", input.leadId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      contact = data;
    }
    if (contact) {
      const { data: messages } = await supabase
        .from("wa_messages")
        .select("direction, body, created_at")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false })
        .limit(60);
      const thread = (messages ?? [])
        .reverse()
        .filter((m) => m.body?.trim())
        .map((m) => `${m.direction === "in" ? "CLIENT" : "US"}: ${m.body}`)
        .join("\n");
      if (thread) sources.push(`WHATSAPP THREAD (oldest first):\n${thread.slice(0, 6000)}`);
    }
  }

  if (sources.length === 0)
    return {
      ok: false,
      error:
        "Nothing to read — attach a quote, a lead or a client with a WhatsApp thread first.",
    };

  // AI-2's benchmarks feed AI-1's timeline: an estimate grounded in what this
  // agency actually delivers beats one grounded in the model's priors.
  const history = await finishedProjects(supabase, { limit: 40 });
  const benchmarks = benchmarkByService(history);
  const benchmarkLine = benchmarks.length
    ? `- Ground estimated_days in OUR OWN history, not general industry timelines: ${benchmarks
        .map(
          (b) =>
            `${SERVICE_TYPE_LABELS[b.serviceType as keyof typeof SERVICE_TYPE_LABELS] ?? b.serviceType} typically took ${b.medianDays ?? "?"} days (${b.count} projects)`,
        )
        .join("; ")}.`
    : "- We have no delivered-project history yet, so estimate conservatively and say so in open_questions.";

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: prompt(benchmarkLine) },
        { role: "user", content: sources.join("\n\n---\n\n").slice(0, 12000) },
      ],
      { temperature: 0.3, timeoutMs: 60_000 },
    );
    return { ok: true, brief: normalize(JSON.parse(raw)) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The brief could not be drafted.",
    };
  }
}

/** The client's name, used to find the proposal that has no foreign key. */
async function lookupClientName(
  supabase: DB,
  input: { leadId?: string | null; clientId?: string | null; quoteId?: string | null },
): Promise<string | null> {
  if (input.clientId) {
    const { data } = await supabase
      .from("clients")
      .select("name")
      .eq("id", input.clientId)
      .maybeSingle();
    if (data?.name) return data.name;
  }
  if (input.quoteId) {
    const { data } = await supabase
      .from("quotes")
      .select("customer_name")
      .eq("id", input.quoteId)
      .maybeSingle();
    if (data?.customer_name) return data.customer_name;
  }
  if (input.leadId) {
    const { data } = await supabase
      .from("leads")
      .select("company, contact_name")
      .eq("id", input.leadId)
      .maybeSingle();
    if (data?.company || data?.contact_name)
      return data.company || data.contact_name;
  }
  return null;
}

/** Trust nothing the model returned about shape — only about content. */
function normalize(raw: unknown): ProjectBrief {
  const r = (raw ?? {}) as Record<string, unknown>;
  const strings = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && !!x.trim())
          .map((x) => x.trim())
          .slice(0, cap)
      : [];

  const service = typeof r.service_type === "string" ? r.service_type : null;

  return {
    name: typeof r.name === "string" ? r.name.trim() : "",
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    deliverables: strings(r.deliverables, 10),
    exclusions: strings(r.exclusions, 8),
    tasks: Array.isArray(r.tasks)
      ? r.tasks
          .filter(
            (t): t is { title: string; days_from_start?: unknown } =>
              !!t && typeof (t as { title?: unknown }).title === "string",
          )
          .map((t) => ({
            title: t.title.trim(),
            days_from_start:
              typeof t.days_from_start === "number" && Number.isFinite(t.days_from_start)
                ? Math.max(0, Math.round(t.days_from_start))
                : null,
          }))
          .slice(0, 15)
      : [],
    assets: Array.isArray(r.assets)
      ? r.assets
          .filter(
            (a): a is { title: string; category?: unknown; required?: unknown } =>
              !!a && typeof (a as { title?: unknown }).title === "string",
          )
          .map((a) => ({
            title: a.title.trim(),
            category:
              typeof a.category === "string" && ASSET_CATEGORIES.includes(a.category)
                ? a.category
                : null,
            required: a.required !== false,
          }))
          .slice(0, 15)
      : [],
    estimated_days:
      typeof r.estimated_days === "number" && Number.isFinite(r.estimated_days)
        ? Math.max(1, Math.round(r.estimated_days))
        : null,
    service_type:
      service && service in SERVICE_TYPE_LABELS ? service : null,
    open_questions: strings(r.open_questions, 6),
  };
}
