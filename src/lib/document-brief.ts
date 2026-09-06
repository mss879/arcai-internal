import { FINAL_PERCENT, UPFRONT_PERCENT } from "@/lib/payment-terms";

/**
 * What a project's own documents say — read, not retyped.
 *
 * A project is created by uploading the signed proposal and the invoice and
 * then typing the figures out of them into the form: the value, the deposit
 * share, what was sold. The invoice already says "DUE TODAY: Rs. 140,000" and
 * the proposal already lists the deliverables; copying them by hand is where
 * a 50% deposit becomes a 70% one and the portal asks the client for the
 * wrong money.
 *
 * This module is the PURE half: text in, structured fields out, no I/O, so it
 * can be tested against the real documents. The reading of storage, the CRM
 * rows and the model lives in document-brief-reader.ts.
 *
 * Every parser here is a regex over extracted PDF text, tuned to the
 * agency's own templates (invoice-pdf.tsx, proposal-pdf.tsx and the older
 * generator that produced the same layout). Anything it can't find it leaves
 * null and says so in `warnings` — a null is a prompt to check; a wrong
 * number is an invoice for the wrong amount.
 */

/**
 * Documents are read for projects created from this date on. Everything older
 * was set up by hand and has no proposal attached; reading nothing and saying
 * nothing is better than a card that says "no documents" on sixty projects.
 */
export const DOCUMENT_BRIEF_SINCE = "2026-09-01";

export function documentBriefApplies(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  return createdAt.slice(0, 10) >= DOCUMENT_BRIEF_SINCE;
}

export type BriefSource =
  | "invoice"
  | "invoice_pdf"
  | "proposal"
  | "proposal_pdf";

export type BriefPricing = {
  total: number | null;
  currency: string | null;
  /** Share of the total payable to start, e.g. 70. */
  depositPercent: number | null;
  depositAmount: number | null;
  balanceAmount: number | null;
  invoiceNumber: string | null;
  /** ISO date. */
  invoiceDate: string | null;
  /** The line that stated the terms, verbatim, so a person can check it. */
  termsLine: string | null;
  from: BriefSource | null;
  confidence: "high" | "low";
};

export type BriefTimelineStep = { title: string; duration: string | null };

export type BriefProposal = {
  title: string | null;
  /** 2–3 sentences: what was agreed to be built, for whom. */
  summary: string | null;
  /** The package or option that was sold, e.g. "Option B — full scope". */
  packageLabel: string | null;
  deliverables: string[];
  exclusions: string[];
  timeline: BriefTimelineStep[];
  paymentTerms: string[];
  /** The proposal's own figures, kept separately so a mismatch can be shown. */
  total: number | null;
  depositPercent: number | null;
  from: BriefSource | null;
  confidence: "high" | "low";
};

export type DocumentBrief = {
  version: 1;
  /** ISO timestamp of the read. */
  readAt: string;
  pricing: BriefPricing;
  proposal: BriefProposal | null;
  /** Things a person should look at before trusting the figures. */
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

/** "Rs. 140,000" / "LKR 140000.00" / "140,000" → 140000 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const AMOUNT = String.raw`(?:Rs\.?|LKR|₨|USD|\$|GBP|£)?\s*([\d][\d,]*(?:\.\d+)?)`;

function firstAmount(text: string, label: RegExp): number | null {
  const m = new RegExp(label.source + String.raw`\s*:?\s*` + AMOUNT, "i").exec(text);
  return m ? parseAmount(m[1]) : null;
}

/** The ISO code the document prices in, or null when it never says. */
export function detectCurrency(text: string): string | null {
  if (/\b(?:LKR|Rs\.?|₨)\s*[\d]/.test(text) || /\bRupees\b/i.test(text)) return "LKR";
  if (/\bGBP\b|£\s*\d/.test(text)) return "GBP";
  if (/\bUSD\b|\$\s*\d/.test(text)) return "USD";
  return null;
}

/** "03/09/2026" (Sri Lanka: day first) / "03 Sept 2026" / "2026-09-03" → ISO. */
export function parseDocumentDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ].indexOf(m[2].slice(0, 3).toLowerCase());
    if (month >= 0) return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** "70% deposit", "50% upfront", "payable on signing (70%)" → 70 */
export function findDepositPercent(text: string): { percent: number; line: string } | null {
  const patterns = [
    /(\d{1,3})\s*%\s*(?:deposit|upfront|advance|down\s*payment|on\s+signing|to\s+(?:start|begin|commence))/i,
    /(?:deposit|upfront|advance|on\s+signing|payable\s+(?:now|today))[^.\n%]{0,40}?\((\d{1,3})\s*%\)/i,
    /(?:deposit|upfront|advance)\s+(?:of|is|payment(?:\s+of)?)\s+(\d{1,3})\s*%/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const percent = Number(m[1]);
    if (percent > 0 && percent <= 100) {
      // The sentence it came from, for the "check this" line in the UI —
      // from the previous full stop to the next one, across a PDF line wrap.
      const before = text.slice(Math.max(0, m.index - 220), m.index);
      const after = text.slice(m.index, m.index + 260);
      // A line break, or a full stop that isn't "Rs." / "No." — the sentence
      // starts after whichever came last.
      let start = before.lastIndexOf("\n") + 1;
      for (const stop of before.matchAll(/\.\s/g)) {
        if (!/(?:\b(?:Rs|No|Ltd|Pvt|St|Mr|Ms|Dr))$/.test(before.slice(0, stop.index))) {
          start = Math.max(start, stop.index + stop[0].length);
        }
      }
      const stop = after.search(/\.(?:\s|$)/);
      const line = (before.slice(start) + after.slice(0, stop === -1 ? undefined : stop + 1))
        .replace(/\s+/g, " ")
        .trim();
      return { percent, line };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The invoice                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read an ARC AI invoice out of its extracted text.
 *
 * The template prints, in this order: `TOTAL: Rs. 200,000`, `DUE TODAY:
 * Rs. 140,000`, `BALANCE REMAINING: Rs. 60,000`, then one sentence saying
 * "Due today is the 70% deposit…". The percentage is computed from the two
 * figures and only cross-checked against the sentence — the numbers are what
 * the client was billed; the prose is commentary on them.
 */
export function parseInvoiceText(text: string): BriefPricing {
  const t = text.replace(/\r/g, "");
  const warnings: string[] = [];

  // "QTY RATE TOTAL" is a column header, so the total needs its colon.
  const total =
    firstAmount(t, /(?:GRAND\s+)?TOTAL\s*:/) ??
    firstAmount(t, /TOTAL\s+AMOUNT/) ??
    firstAmount(t, /AMOUNT\s+DUE\s*(?:\(total\))?/) ??
    null;
  const dueToday =
    firstAmount(t, /DUE\s+TODAY/) ??
    firstAmount(t, /(?:DEPOSIT|ADVANCE)\s+(?:DUE|PAYABLE|AMOUNT)/) ??
    firstAmount(t, /PAYABLE\s+(?:NOW|ON\s+SIGNING)(?:\s*\(\d{1,3}\s*%\))?/) ??
    null;
  const balance =
    firstAmount(t, /BALANCE\s+(?:REMAINING|DUE)/) ??
    firstAmount(t, /REMAINING\s+BALANCE/) ??
    null;

  const stated = findDepositPercent(t);
  let depositPercent: number | null = null;
  if (total && dueToday && dueToday < total) {
    depositPercent = Math.round((dueToday / total) * 100);
    if (stated && Math.abs(stated.percent - depositPercent) > 1) {
      warnings.push(
        `The invoice bills ${depositPercent}% today but its wording says ${stated.percent}% — check which is right.`,
      );
    }
  } else if (stated) {
    depositPercent = stated.percent;
  } else if (total && dueToday && dueToday >= total) {
    // Billed in full up front.
    depositPercent = 100;
  }

  const numberMatch =
    /Invoice\s*(?:Number|No\.?|#)\s*:?\s*(#?\s*[A-Z0-9-]{3,})/i.exec(t) ??
    /\bINVOICE\s*(#\s*\d{3,})/i.exec(t);
  const invoiceNumber = numberMatch
    ? numberMatch[1].replace(/\s+/g, "")
    : null;

  const dateMatch =
    /Invoice\s*Date\s*:?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/i.exec(t) ??
    /\bDate\s*:?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/i.exec(t);

  const confidence: "high" | "low" =
    total && (dueToday || depositPercent) && warnings.length === 0 ? "high" : "low";

  return {
    total,
    currency: detectCurrency(t),
    depositPercent,
    depositAmount:
      dueToday ?? (total && depositPercent ? Math.round((total * depositPercent) / 100) : null),
    balanceAmount:
      balance ?? (total && dueToday ? Math.max(0, total - dueToday) : null),
    invoiceNumber,
    invoiceDate: parseDocumentDate(dateMatch?.[1]),
    termsLine: stated?.line ?? null,
    from: "invoice_pdf",
    confidence,
  };
}

/* ------------------------------------------------------------------ */
/* The proposal                                                         */
/* ------------------------------------------------------------------ */

/** The text of one numbered section ("10 TERMS OF PAYMENT" … next "11 …"). */
function section(text: string, heading: RegExp): string | null {
  const re = new RegExp(String.raw`^\s*\d{2}\s+` + heading.source + String.raw`[^\n]*$`, "im");
  const start = re.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = /^\s*\d{2}\s+[A-Z][A-Z &—–\-,/]{3,}$/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined).trim();
}

/** A line that is a price, a table row or a heading — never the tail of a bullet. */
function breaksBullet(line: string): boolean {
  return (
    /^(?:Rs\.?|LKR|USD|GBP|\$|£)\s*[\d,]/.test(line) || // "Rs 150,000"
    /^[A-Z0-9][A-Z0-9 &—–\-,/%()]+$/.test(line) || // "OPTION WHAT IT INCLUDES TOTAL"
    /^[A-Z][\w-]*(?:\s[\w-]+){0,5}\s+[—–]\s/.test(line) || // "Add-On — Proposal, …"
    /Page \d+ of \d+/.test(line)
  );
}

/**
 * Bullet lines ("• …") of a block, joined where the PDF wrapped them.
 *
 * A wrapped bullet continues on a line that starts lowercase, or on a short
 * plain line when the bullet has no full stop yet. Anything else — a price,
 * a table row, a heading, a fresh sentence — closes it. Gluing every
 * non-bullet line on used to turn the last deliverable into the whole
 * pricing table.
 */
function bullets(block: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) {
      open = false;
      continue;
    }
    if (/^[•·\-*]\s+/.test(line)) {
      out.push(line.replace(/^[•·\-*]\s+/, ""));
      open = true;
      continue;
    }
    if (!open || breaksBullet(line)) {
      open = false;
      continue;
    }
    const prev = out[out.length - 1];
    const unfinished = !/[.;:!?)]$/.test(prev);
    if (/^[a-z(]/.test(line) || (unfinished && line.length < 80)) {
      out[out.length - 1] = `${prev} ${line}`;
    } else {
      open = false;
    }
  }
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Drop the running page footer the extractor leaves mid-text. */
function stripFooters(text: string): string {
  return text.replace(/^.*·\s*www\.arcai\.agency\s*·.*Page \d+ of \d+\s*$/gim, "");
}

/**
 * Read an ARC AI proposal out of its extracted text, without a model.
 *
 * Enough to be useful on its own — the title, the payment terms, the
 * deliverables off the Investment table, the timeline steps — and the
 * grounding the model gets when one is configured. The summary here is the
 * first paragraph of the Overview; the model writes a better one.
 */
export function parseProposalText(text: string): BriefProposal {
  const t = stripFooters(text.replace(/\r/g, ""));

  // "Project: Gem Sourcing & E-Commerce\nPlatform\nDate: 03 Sept 2026"
  const titleMatch = /Project:\s*([\s\S]+?)\s*Date:/i.exec(t);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;

  const overview = section(t, /OVERVIEW/);
  const summary = overview
    ? overview.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim().slice(0, 600) || null
    : null;

  const terms = section(t, /TERMS\s+OF\s+PAYMENT/);
  const paymentTerms = terms ? bullets(terms) : [];
  const deposit = findDepositPercent(terms ?? t);

  // The Investment table's bullets are the concrete deliverables.
  const investment = section(t, /INVESTMENT/);
  const deliverables = investment ? bullets(investment).slice(0, 12) : [];

  // "OPTION B — FULL SCOPE: Rs 200,000" is the chosen option; a bare table of
  // options is a menu, and a menu has no single total.
  const chosen =
    /(OPTION\s+[A-Z][^\n:]*)\s*:\s*(?:Rs\.?|LKR)\s*([\d,]+)/i.exec(t) ??
    /(FULL\s+SCOPE)\s*:\s*(?:Rs\.?|LKR)\s*([\d,]+)/i.exec(t);
  const total =
    (chosen ? parseAmount(chosen[2]) : null) ??
    firstAmount(t, /TOTAL\s+INVESTMENT/) ??
    firstAmount(t, /GRAND\s+TOTAL/) ??
    null;
  const packageLabel = chosen
    ? chosen[1].replace(/\s+/g, " ").replace(/\s*[—–-]\s*/g, " — ").trim()
    : null;

  // Timeline: "01 Discovery & Kickoff … W E E K 1"
  const timelineBlock = section(t, /TIMELINE/);
  const timeline: BriefTimelineStep[] = [];
  if (timelineBlock) {
    const stepRe = /^\s*(\d{2})\s+([A-Z][^\n]+)$/gm;
    // Same line only — a greedy class ate the newline and the next step number.
    const durRe = /W\s?E\s?E\s?K[ \t]*(\d+(?:[ \t]*[–-][ \t]*\d+)?)/g;
    const titles = [...timelineBlock.matchAll(stepRe)].map((m) => m[2].trim());
    const durations = [...timelineBlock.matchAll(durRe)].map(
      (m) => `Week ${m[1].replace(/[ \t]+/g, "").replace(/-/g, "–")}`,
    );
    titles.forEach((tt, i) => timeline.push({ title: tt, duration: durations[i] ?? null }));
  }

  const exclusions: string[] = [];
  const assumptions = /Assumptions\s*&\s*Exclusions\s*\n([\s\S]*?)(?:\n\s*Next Steps|\n\s*Prepared by|$)/i.exec(t);
  if (assumptions) exclusions.push(...bullets(assumptions[1]).slice(0, 8));

  const confidence: "high" | "low" =
    title && (deposit || paymentTerms.length) && deliverables.length ? "high" : "low";

  return {
    title,
    summary,
    packageLabel,
    deliverables,
    exclusions,
    timeline,
    paymentTerms,
    total,
    depositPercent: deposit?.percent ?? null,
    from: "proposal_pdf",
    confidence,
  };
}

/* ------------------------------------------------------------------ */
/* Putting it together                                                  */
/* ------------------------------------------------------------------ */

/**
 * One brief from whatever was found. Pricing prefers the invoice — it is what
 * the client was actually billed — and falls back to the proposal; the two
 * are compared and any disagreement becomes a warning rather than a silent
 * choice.
 */
export function assembleBrief(input: {
  invoice: BriefPricing | null;
  proposal: BriefProposal | null;
  readAt?: string;
}): DocumentBrief {
  const warnings: string[] = [];
  const inv = input.invoice;
  const prop = input.proposal;

  let pricing: BriefPricing;
  if (inv && inv.total) {
    pricing = { ...inv };
    if (pricing.depositPercent == null && prop?.depositPercent != null) {
      pricing.depositPercent = prop.depositPercent;
      pricing.depositAmount = Math.round((pricing.total! * prop.depositPercent) / 100);
      pricing.balanceAmount = pricing.total! - pricing.depositAmount;
    }
  } else if (prop && (prop.total || prop.depositPercent != null)) {
    const total = prop.total;
    const pct = prop.depositPercent;
    pricing = {
      total,
      currency: null,
      depositPercent: pct,
      depositAmount: total && pct != null ? Math.round((total * pct) / 100) : null,
      balanceAmount: total && pct != null ? total - Math.round((total * pct) / 100) : null,
      invoiceNumber: null,
      invoiceDate: null,
      termsLine: prop.paymentTerms[0] ?? null,
      from: prop.from,
      confidence: total && pct != null ? "high" : "low",
    };
    if (!total) warnings.push("The proposal offers options and names no single total — the value was not filled in.");
  } else {
    pricing = {
      total: null,
      currency: null,
      depositPercent: null,
      depositAmount: null,
      balanceAmount: null,
      invoiceNumber: null,
      invoiceDate: null,
      termsLine: null,
      from: null,
      confidence: "low",
    };
    if (inv) warnings.push("The invoice was read but no total was found on it.");
  }

  if (inv?.total && prop?.total && inv.total !== prop.total) {
    warnings.push(
      `The invoice is for ${inv.total.toLocaleString("en-US")} but the proposal says ${prop.total.toLocaleString("en-US")} — the invoice figure was used.`,
    );
  }
  if (
    inv?.depositPercent != null &&
    prop?.depositPercent != null &&
    inv.depositPercent !== prop.depositPercent
  ) {
    warnings.push(
      `The invoice bills a ${inv.depositPercent}% deposit; the proposal's terms say ${prop.depositPercent}%.`,
    );
  }
  if (pricing.depositPercent == null && pricing.total) {
    warnings.push(
      `No deposit share was found in the documents — the standard ${UPFRONT_PERCENT}/${FINAL_PERCENT} split applies until one is set.`,
    );
  }
  if (inv && inv.confidence === "low" && inv.total) {
    warnings.push("The invoice figures were read with low confidence — check them against the PDF.");
  }

  return {
    version: 1,
    readAt: input.readAt ?? new Date().toISOString(),
    pricing,
    proposal: prop,
    warnings,
  };
}

/** Read a stored brief back, tolerating anything older code may have saved. */
export function asDocumentBrief(value: unknown): DocumentBrief | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DocumentBrief>;
  if (v.version !== 1 || !v.pricing) return null;
  return v as DocumentBrief;
}
