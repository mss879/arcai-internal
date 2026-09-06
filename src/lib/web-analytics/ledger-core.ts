/**
 * The lead ledger's rules, as pure functions.
 *
 * Kept free of I/O so they can be tested, and so `ledger.ts` stays a thin
 * read/classify/write around them. Everything here answers one of three
 * questions about a website conversion event:
 *
 *   1. What IS it? — `categoryOf`: an enquiry, a contact click, or a form
 *      that was never a lead (newsletter, job application, review).
 *   2. Which ledger row is it? — `ledgerKey`: the lead id the website's
 *      tracker minted, or a key derived from the session so repeated
 *      clicks on one WhatsApp button collapse into one row.
 *   3. Is it real? — `classifyConversion`: the rules that filed fifteen
 *      newsletter signups from one spam script as spam instead of as the
 *      month's conversions. A rule only ever sets the FIRST verdict; a
 *      person's verdict is never overwritten (see `mergeVerdict`).
 *
 * Duplicated from the website's tracker on purpose rather than imported —
 * the two apps are separate repositories and separate deployments, and a
 * shared package would couple their release cycles for three constants.
 */

export type ConversionCategory = "enquiry" | "contact_click" | "other";
export type LedgerStatus = "unreviewed" | "lead" | "test" | "spam";
export type LedgerStatusSource = "none" | "rule" | "manual";

const CATEGORY: Record<string, ConversionCategory> = {
  contact_form: "enquiry",
  chat_lead: "enquiry",
  job_request: "enquiry",
  proposal_request: "enquiry",
  // The pre-fix tracker named a conversion after the DOM event or the page
  // it happened on. Those rows describe form submits that were CLAIMED as
  // enquiries, so they are judged as enquiries — which is what lets the
  // zero-engagement rule below file the spam ones correctly.
  form_submit: "enquiry",
  unspecified: "enquiry",
  whatsapp_click: "contact_click",
  call_click: "contact_click",
  email_click: "contact_click",
  newsletter: "other",
  career_application: "other",
  review: "other",
};

/** What a conversion kind is. An unknown kind is an enquiry until proven otherwise. */
export function categoryOf(kind: string | null | undefined): ConversionCategory {
  const key = (kind ?? "").trim();
  if (!key) return "enquiry";
  // The website's tracker also stamps the category on the event; the map
  // is the fallback for rows recorded before it did.
  return CATEGORY[key] ?? "enquiry";
}

/**
 * The row a conversion event belongs to.
 *
 *   • an enquiry carries the lead id the form minted before it sent, and
 *     that id is also on the CRM lead — one key, both sides;
 *   • a contact click is keyed by kind and session, so the fourth click on
 *     the same WhatsApp button is `occurrences: 4` on one row, not a
 *     fourth conversion;
 *   • an enquiry recorded by the OLD tracker (no lead id) is keyed the same
 *     way, so the three footer submits one visitor rage-clicked into one
 *     session are one row.
 */
export function ledgerKey(
  kind: string,
  sessionId: string,
  meta: Record<string, unknown> | null | undefined,
): string {
  const given = meta && typeof meta.lead_id === "string" ? meta.lead_id.trim() : "";
  if (given) return given.slice(0, 200);
  return `${kind}:${sessionId}`.slice(0, 200);
}

/** The key the ledger uses for a session flagged converted whose conversion event never arrived. */
export function sessionLedgerKey(sessionId: string): string {
  return `session:${sessionId}`.slice(0, 200);
}

/**
 * Does this row count as a conversion on the dashboard?
 *
 * A confirmed lead always does. An enquiry does until somebody says
 * otherwise — the form was accepted by the server, so the default is to
 * believe it. A contact click never does on its own: it is intent, and it
 * becomes a conversion only when a person confirms the conversation
 * happened.
 */
export function countsAsConversion(row: {
  status: LedgerStatus;
  category: ConversionCategory;
}): boolean {
  if (row.status === "lead") return true;
  return row.status === "unreviewed" && row.category === "enquiry";
}

/** A row that is neither spam nor a test — intent of some kind, whatever its category. */
export function isGenuine(row: { status: LedgerStatus }): boolean {
  return row.status !== "spam" && row.status !== "test";
}

export type ClassifyInput = {
  kind: string;
  category: ConversionCategory;
  /** The conversion event's meta, as the tracker sent it. */
  meta: Record<string, unknown> | null | undefined;
  /** The browsing session the event belongs to, when the mirror has it. */
  session: {
    is_bot: boolean;
    engaged_seconds: number;
    forms_started: number;
    page_count: number;
    user_agent: string | null;
    identified_email: string | null;
  } | null;
  /** An email attached by any route — the session, the CRM lead, the chat. */
  email?: string | null;
};

export type Verdict = {
  status: LedgerStatus;
  source: LedgerStatusSource;
  reason: string | null;
  flags: Record<string, boolean>;
};

const TEST_DOMAINS = ["arcai.agency", "arcai.online", "example.com", "test.com", "mailinator.com"];

/**
 * A Gmail address with the local part chopped up by dots — `u.we.y.o.bu1.4.7`.
 * Gmail ignores dots, so a script can mint unlimited "different" addresses
 * that all deliver to one inbox; a person almost never types three.
 */
export function looksLikeDottedGmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain || !/^(gmail|googlemail)\.com$/.test(domain)) return false;
  return (local.match(/\./g) ?? []).length >= 3;
}

export function looksLikeTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase().trim();
  const [local, domain] = lower.split("@");
  if (!domain) return false;
  if (TEST_DOMAINS.includes(domain)) return true;
  return /(^|[.+_-])test([.+_0-9-]|$)/.test(local ?? "");
}

/**
 * The first verdict on a conversion, from what the tracker and the session
 * can show. Ordered from certain to circumstantial; the first rule that
 * fires wins. Anything no rule can call is left `unreviewed`, which for an
 * enquiry means "counted, and listed for a person to confirm".
 */
export function classifyConversion(input: ClassifyInput): Verdict {
  const meta = input.meta ?? {};
  const s = input.session;
  const email = input.email ?? s?.identified_email ?? null;
  const flags: Record<string, boolean> = {};

  if (meta.test === true) flags.test_mode = true;
  if (meta.untouched === true) flags.untouched = true;
  if (meta.implicit === true) flags.implicit_start = true;
  if (s?.is_bot) flags.bot = true;
  if (s && s.user_agent && s.user_agent.trim().startsWith('"')) flags.quoted_user_agent = true;
  if (s && s.engaged_seconds === 0 && s.forms_started === 0) flags.zero_engagement = true;
  if (looksLikeDottedGmail(email)) flags.dotted_gmail = true;
  if (looksLikeTestEmail(email)) flags.test_email = true;

  const verdict = (status: LedgerStatus, reason: string): Verdict => ({
    status,
    source: "rule",
    reason,
    flags,
  });

  // A test is a test whatever else is true of it — the person running it
  // asked for it to be filed that way.
  if (flags.test_mode) return verdict("test", "Sent in test mode (?arc_test=1).");
  if (flags.test_email) return verdict("test", `Test address: ${email}.`);

  if (flags.bot) return verdict("spam", "The session's user agent is a known bot or crawler.");
  if (flags.quoted_user_agent) {
    return verdict(
      "spam",
      "The user agent arrived wrapped in literal quote characters — the signature of the newsletter script.",
    );
  }

  // Only a form can be submitted without being touched. A chat lead is
  // typed, a click is clicked — the zero-engagement rules are for forms.
  const isForm = input.category === "enquiry" && input.kind !== "chat_lead";
  if (isForm && flags.untouched) {
    return verdict("spam", "The form reported a success without anyone ever focusing a field.");
  }
  if (isForm && s && flags.zero_engagement) {
    return verdict(
      "spam",
      "A form was submitted in a session with zero engaged seconds and no form interaction — a script, not a person.",
    );
  }
  if (isForm && flags.dotted_gmail && s && s.engaged_seconds < 5) {
    return verdict(
      "spam",
      `A dot-obfuscated Gmail address (${email}) in a session with almost no engagement.`,
    );
  }

  return { status: "unreviewed", source: "none", reason: null, flags };
}

/**
 * What the stored row's verdict becomes when the ledger sees the same
 * conversion again — on a re-sync, a rebuild, or a later event for the
 * same key.
 *
 * A person's verdict is final: the classifier never touches a `manual`
 * row. A rule's verdict is recomputed (the rules may have improved). A
 * row nobody and no rule has judged takes whatever the classifier says now.
 */
export function mergeVerdict(
  existing: {
    status: LedgerStatus;
    status_source: LedgerStatusSource;
    status_reason: string | null;
  } | null,
  fresh: Verdict,
): { status: LedgerStatus; status_source: LedgerStatusSource; status_reason: string | null } {
  if (existing?.status_source === "manual") {
    return {
      status: existing.status,
      status_source: "manual",
      status_reason: existing.status_reason,
    };
  }
  return { status: fresh.status, status_source: fresh.source, status_reason: fresh.reason };
}

/** The UTC day a timestamp falls on, the way every rollup groups. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Whether a matched CRM lead makes the conversion a QUALIFIED lead.
 *
 * Qualified means somebody looked and thought it was worth pursuing: the
 * ledger row was confirmed by hand, or the CRM lead it matched is alive
 * and scored hot or warm. Won is simpler — the CRM says won.
 */
export function leadOutcome(
  row: { status: LedgerStatus; status_source: LedgerStatusSource },
  lead: { status: string; score: string | null; deleted_at: string | null } | null,
): { qualified: boolean; won: boolean; outcome: "open" | "won" | "lost" | "none" } {
  const alive = lead && !lead.deleted_at;
  const won = Boolean(alive && lead!.status === "won");
  const lost = Boolean(alive && lead!.status === "lost");
  const scored = Boolean(alive && (lead!.score === "hot" || lead!.score === "warm"));
  const confirmed = row.status === "lead" && row.status_source === "manual";
  return {
    qualified: !lost && (confirmed || scored || won),
    won,
    outcome: !alive ? "none" : won ? "won" : lost ? "lost" : "open",
  };
}
