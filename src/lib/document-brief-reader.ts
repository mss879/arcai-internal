import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { STORAGE_BUCKETS } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import {
  assembleBrief,
  documentBriefApplies,
  findDepositPercent,
  parseInvoiceText,
  parseProposalText,
  type BriefPricing,
  type BriefProposal,
  type DocumentBrief,
} from "@/lib/document-brief";
import {
  includedFeatures,
  selectionSummary,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";

type DB = SupabaseClient<Database>;

/**
 * Read a project's proposal and invoice into the project (0124).
 *
 * Four places a figure can come from, tried in this order for pricing:
 *   1. an invoice raised in the CRM against the project — the row itself;
 *   2. the uploaded invoice PDF — text out, regex over the template;
 *   3. a proposal generated in the CRM — its stored content;
 *   4. the uploaded proposal PDF — text out, regex, then the model for the
 *      prose a regex can't write (a summary, what's excluded).
 *
 * Whatever is found is written back: the brief itself, and — because these
 * are the two numbers every other screen counts with — `total_value` and
 * `deposit_required_percent`. The portal then asks for the deposit this
 * project's own invoice states, not the house default.
 *
 * Reads only. It never bills, never touches `deposit_paid`, and never
 * invents: a figure the documents don't state stays null with a warning.
 */

export type ReadDocumentsResult =
  | {
      ok: true;
      brief: DocumentBrief;
      /** Which project fields the read changed. */
      wrote: { totalValue: number | null; depositPercent: number | null };
    }
  | { ok: false; error: string };

const MAX_MODEL_CHARS = 30_000;

export async function readProjectDocuments(
  supabase: DB,
  projectId: string,
): Promise<ReadDocumentsResult> {
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, created_at, currency, total_value, deposit_required_percent, proposal_id, proposal_path, proposal_name, invoice_path, invoice_name",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (error || !project) return { ok: false, error: error?.message ?? "Project not found." };

  if (!documentBriefApplies(project.created_at)) {
    return {
      ok: false,
      error: "Documents are read for projects created from September 2026 — this one was set up by hand.",
    };
  }

  const extraWarnings: string[] = [];

  // ---- Pricing: the invoice ------------------------------------------------
  let invoice: BriefPricing | null = null;

  const { data: crmInvoice } = await supabase
    .from("invoices")
    .select("invoice_number, invoice_date, grand_total, due_today, currency")
    .eq("project_id", projectId)
    .neq("status", "void")
    .order("grand_total", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (crmInvoice && Number(crmInvoice.grand_total) > 0) {
    const total = Math.round(Number(crmInvoice.grand_total));
    const dueToday = Math.round(Number(crmInvoice.due_today) || 0);
    const pct = dueToday > 0 && dueToday < total ? Math.round((dueToday / total) * 100) : dueToday >= total ? 100 : null;
    invoice = {
      total,
      currency: crmInvoice.currency ?? "LKR",
      depositPercent: pct,
      depositAmount: dueToday || null,
      balanceAmount: dueToday ? Math.max(0, total - dueToday) : null,
      invoiceNumber: crmInvoice.invoice_number,
      invoiceDate: crmInvoice.invoice_date,
      termsLine: null,
      from: "invoice",
      confidence: "high",
    };
  } else if (project.invoice_path) {
    const text = await pdfText(supabase, project.invoice_path);
    if (text === null) {
      extraWarnings.push(
        `The attached invoice (${project.invoice_name ?? "file"}) isn't a PDF that can be read — figures were not taken from it.`,
      );
    } else {
      invoice = parseInvoiceText(text);
      if (!invoice.total && isOpenAIConfigured()) {
        const fromModel = await modelInvoice(text);
        if (fromModel) invoice = { ...invoice, ...fromModel, from: "invoice_pdf" };
      }
    }
  }

  // ---- Scope: the proposal -------------------------------------------------
  let proposal: BriefProposal | null = null;

  if (project.proposal_id) {
    const { data: crmProposal } = await supabase
      .from("proposals")
      .select("project_name, selection, content, grand_total, currency")
      .eq("id", project.proposal_id)
      .maybeSingle();
    if (crmProposal) proposal = fromCrmProposal(crmProposal);
  }

  if (!proposal && project.proposal_path) {
    const text = await pdfText(supabase, project.proposal_path);
    if (text === null) {
      extraWarnings.push(
        `The attached proposal (${project.proposal_name ?? "file"}) isn't a PDF that can be read — the scope was not taken from it.`,
      );
    } else {
      proposal = parseProposalText(text);
      if (isOpenAIConfigured()) {
        const enriched = await modelProposal(text, proposal);
        if (enriched) proposal = enriched;
      }
    }
  }

  const brief = assembleBrief({ invoice, proposal });
  brief.warnings.push(...extraWarnings);
  if (!invoice && !proposal) {
    brief.warnings.push("No proposal or invoice is attached to this project yet.");
  }

  // ---- Write back ----------------------------------------------------------
  const wrote = { totalValue: null as number | null, depositPercent: null as number | null };
  const patch: Database["public"]["Tables"]["projects"]["Update"] = {
    document_brief: brief as unknown as Record<string, unknown>,
    document_brief_read_at: brief.readAt,
  };
  if (brief.pricing.total && brief.pricing.total > 0) {
    patch.total_value = brief.pricing.total;
    wrote.totalValue = brief.pricing.total;
  }
  if (brief.pricing.depositPercent != null) {
    patch.deposit_required_percent = brief.pricing.depositPercent;
    wrote.depositPercent = brief.pricing.depositPercent;
  }
  const { error: writeError } = await supabase.from("projects").update(patch).eq("id", projectId);
  if (writeError) return { ok: false, error: writeError.message };

  return { ok: true, brief, wrote };
}

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

/** The text of a PDF in project-docs, or null when it isn't one we can read. */
async function pdfText(supabase: DB, path: string): Promise<string | null> {
  if (!/\.pdf$/i.test(path)) return null;
  const { data } = await supabase.storage.from(STORAGE_BUCKETS.projectDocs).download(path);
  if (!data) return null;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await data.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    const out = typeof text === "string" ? text : String(text ?? "");
    return out.trim() ? out : null;
  } catch (e) {
    console.error("[document-brief] pdf text failed:", e);
    return null;
  }
}

/**
 * A proposal written in the CRM needs no reading at all — its content is
 * already the structure the brief wants.
 */
function fromCrmProposal(row: {
  project_name: string;
  selection: Record<string, unknown>;
  content: Record<string, unknown>;
  grand_total: number;
}): BriefProposal {
  const content = row.content as Partial<ProposalContent>;
  const selection = row.selection as ProposalSelection;
  const paymentTerms = Array.isArray(content.paymentTerms)
    ? content.paymentTerms.filter((s): s is string => typeof s === "string")
    : [];
  let deliverables: string[] = [];
  try {
    deliverables = includedFeatures(selection);
  } catch {
    // A legacy selection the catalogue no longer knows — fall through.
  }
  if (!deliverables.length && Array.isArray(content.keyFeatures)) {
    deliverables = content.keyFeatures.flatMap((f) => f?.bullets ?? []);
  }
  let packageLabel: string | null = null;
  try {
    packageLabel = selectionSummary(selection);
  } catch {
    packageLabel = null;
  }
  return {
    title: row.project_name || null,
    summary: (content.overview ?? "").split(/\n\s*\n/)[0]?.trim() || null,
    packageLabel,
    deliverables: deliverables.slice(0, 12),
    exclusions: content.quality?.assumptions?.slice(0, 8) ?? [],
    timeline: (content.timeline ?? []).map((s) => ({ title: s.title, duration: s.duration || null })),
    paymentTerms,
    total: Math.round(Number(row.grand_total)) || null,
    depositPercent: findDepositPercent(paymentTerms.join("\n"))?.percent ?? null,
    from: "proposal",
    confidence: "high",
  };
}

/* ------------------------------------------------------------------ */
/* The model, for what a regex can't do                                 */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}
function strs(v: unknown, cap: number): string[] {
  return Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)).slice(0, cap) : [];
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The proposal's prose: a real summary, what's excluded, the package sold.
 * Figures the regex already found are kept — the model only fills gaps, so a
 * hallucinated total can never overwrite a read one.
 */
async function modelProposal(text: string, base: BriefProposal): Promise<BriefProposal | null> {
  const prompt = `You are reading a web/AI agency's proposal that a client has accepted, to brief the delivery team.

Return STRICT JSON with exactly these keys:
{
  "title": string|null,            // the project's name as the proposal states it
  "summary": string|null,          // 2-3 plain sentences: what is being built and for whom
  "package": string|null,          // the option/package the client is going ahead with, if the document says
  "deliverables": string[],        // 5-10 concrete things the client receives, each under 15 words
  "exclusions": string[],          // 0-6 things the proposal says are NOT included or are the client's job
  "total": number|null,            // the total price of the CHOSEN option only, digits only; null if options are offered and none is chosen
  "deposit_percent": number|null,  // the deposit/upfront share as a whole number, e.g. 70
  "currency": string|null,         // ISO code, e.g. "LKR"
  "confidence": "high"|"low"
}

Rules:
- Use ONLY what the document says. Never invent a deliverable, a price or a term.
- If the proposal lists several pricing options and does not say which was chosen, total is null.
- Output JSON only.`;

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: prompt },
        { role: "user", content: text.slice(0, MAX_MODEL_CHARS) },
      ],
      { temperature: 0.1, timeoutMs: 60_000 },
    );
    const p = JSON.parse(raw) as Record<string, unknown>;
    const deliverables = strs(p.deliverables, 12);
    const pct = num(p.deposit_percent);
    return {
      ...base,
      title: base.title ?? str(p.title),
      summary: str(p.summary) ?? base.summary,
      packageLabel: base.packageLabel ?? str(p.package),
      deliverables: base.deliverables.length >= 3 ? base.deliverables : deliverables.length ? deliverables : base.deliverables,
      exclusions: base.exclusions.length ? base.exclusions : strs(p.exclusions, 8),
      total: base.total ?? num(p.total),
      depositPercent: base.depositPercent ?? (pct && pct <= 100 ? pct : null),
      confidence: base.confidence === "high" || p.confidence === "high" ? "high" : "low",
    };
  } catch (e) {
    console.error("[document-brief] proposal model failed:", e);
    return null;
  }
}

/** Only reached when the regex found no total — a layout that isn't ours. */
async function modelInvoice(text: string): Promise<Partial<BriefPricing> | null> {
  const prompt = `You are reading an invoice from a digital agency.

Return STRICT JSON with exactly these keys:
{
  "invoice_number": string|null,
  "invoice_date": string|null,     // YYYY-MM-DD if legible
  "total": number|null,            // the invoice's full total, digits only
  "due_today": number|null,        // the amount payable now / the deposit, digits only
  "deposit_percent": number|null,  // whole number, e.g. 70, if stated or derivable
  "currency": string|null,         // ISO code
  "confidence": "high"|"low"
}
Never invent a value; use null. Output JSON only.`;
  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: prompt },
        { role: "user", content: text.slice(0, MAX_MODEL_CHARS) },
      ],
      { temperature: 0, timeoutMs: 45_000 },
    );
    const p = JSON.parse(raw) as Record<string, unknown>;
    const total = num(p.total);
    const due = num(p.due_today);
    const pct = num(p.deposit_percent) ?? (total && due && due < total ? Math.round((due / total) * 100) : null);
    if (!total) return null;
    const date = str(p.invoice_date);
    return {
      total,
      depositAmount: due,
      balanceAmount: due ? Math.max(0, total - due) : null,
      depositPercent: pct && pct <= 100 ? pct : null,
      invoiceNumber: str(p.invoice_number),
      invoiceDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      currency: str(p.currency)?.toUpperCase() ?? null,
      confidence: p.confidence === "high" ? "high" : "low",
    };
  } catch (e) {
    console.error("[document-brief] invoice model failed:", e);
    return null;
  }
}
