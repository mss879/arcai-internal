import { INVOICE_COMPANY } from "@/lib/invoice";
import { FINAL_PERCENT, UPFRONT_PERCENT } from "@/lib/payment-terms";

/**
 * The agency's two standard agreements, as text.
 *
 * Everything printed here was read out of the systems that already state it,
 * so there is exactly one place each fact lives:
 *
 *   · the entity, addresses, phones and email — `INVOICE_COMPANY` (invoice.ts)
 *   · the registration number and governing law — the public Terms of Service
 *     on arc_ai_website (`/terms-of-service`)
 *   · 70/30 payment, hosting, storage and domain — `defaultContent()` in
 *     proposal.ts, i.e. the same words every proposal already carries
 *   · Protection plans and Pay-Per-Fix pricing — the same defaults
 *   · the sub-processor list — the public Privacy Policy
 *
 * Deliberately NOT here: scope, deliverables, timeline and price. Those are
 * the proposal's job, and the contract points at the accepted proposal rather
 * than restating it — one document owns each fact, so the two can never
 * disagree about what was bought.
 *
 * Kept in code rather than seeded into `agreement_templates` so the wording is
 * versioned with the app and is there on a fresh database. The table is still
 * read: anything the team writes there is offered alongside these.
 */

/** The entity block agreements are signed in the name of. */
export const AGREEMENT_COMPANY = {
  ...INVOICE_COMPANY,
  /**
   * The registered office, and ONLY that.
   *
   * Deliberately overrides `INVOICE_COMPANY.addressLines`, which carries a
   * Birmingham line as a second point of contact. An agreement names the place
   * the company is registered and can be served notice — the entity is
   * Sri Lankan, so one address is the correct answer and a UK line would
   * misstate where it sits. Invoices, proposals and statements are unaffected.
   */
  addressLines: ["91 Daisy Villa Avenue, Colombo 4, Sri Lanka"],
  /** From the public Terms of Service, §2 Company Information. */
  registrationNumber: "PV00352581",
  incorporatedIn: "Sri Lanka",
  /** Terms of Service §10. */
  governingLaw: "Sri Lanka",
  signatory: "Shahid Shamir",
};

/** How long a project may sit unanswered before it is paused. */
export const PAUSE_AFTER_DAYS = 21;
/** What it costs to bring a paused project back. */
export const RESTART_FEE_LKR = 10_000;

/**
 * Tokens a template may carry, filled in from the editor when the template is
 * chosen. An unknown token is left exactly as typed — a placeholder somebody
 * can still see and fill is safer in a contract than a silent empty string.
 */
export type AgreementTokens = {
  client?: string | null;
  project?: string | null;
  date?: string | null;
};

/** "2026-09-06" -> "06 Sept 2026", the way the PDF header prints it. */
function readableDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fillAgreementTokens(body: string, tokens: AgreementTokens): string {
  const map: Record<string, string> = {
    client: tokens.client?.trim() || "[Client legal name]",
    project: tokens.project?.trim() || "[Project name]",
    date: readableDate(tokens.date?.trim() || new Date().toISOString().slice(0, 10)),
    company: AGREEMENT_COMPANY.name,
  };
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in map ? map[key] : whole,
  );
}

export type BuiltInTemplate = {
  id: string;
  name: string;
  kind: "contract" | "nda";
  body_md: string;
};

const COMPANY_BLOCK = `**${AGREEMENT_COMPANY.name}**, a company incorporated in ${AGREEMENT_COMPANY.incorporatedIn} under registration number ${AGREEMENT_COMPANY.registrationNumber}, of ${AGREEMENT_COMPANY.addressLines.join("; ")} ("ARC AI", "we", "us").`;

/* ------------------------------------------------------------------ */
/* 1. Mutual NDA                                                        */
/* ------------------------------------------------------------------ */

const NDA_BODY = `# Mutual Non-Disclosure Agreement

Dated {{date}}.

## 1. The parties

${COMPANY_BLOCK}

**{{client}}** ("the Client", "you"), whose details are recorded on the signature page.

Each party may disclose information to the other. This agreement protects both of them.

## 2. Purpose

The parties wish to discuss and, if they proceed, carry out {{project}} — including scoping, quoting, design, development, automation and marketing work. Confidential Information may be exchanged for that purpose only ("the Purpose").

## 3. What is confidential

Any non-public information disclosed by one party (the "Discloser") to the other (the "Recipient"), in any form, whether or not marked confidential. It includes:

- business plans, strategy, pricing, quotations, proposals and commercial terms;
- customer, supplier, employee and contact data;
- financial information, sales figures and performance data;
- source code, databases, schemas, prompts, models, automations and technical designs;
- designs, brand assets, unreleased campaigns and marketing plans;
- credentials, API keys, access tokens and hosting details;
- the existence and contents of the discussions between the parties.

## 4. What is not confidential

Information that the Recipient can show:

- was public at the time of disclosure, or became public without any breach of this agreement;
- was already lawfully known to the Recipient, free of any duty of confidence;
- was received from a third party entitled to disclose it; or
- was independently developed without use of the Discloser's information.

## 5. What each party must do

The Recipient will:

1. use the Confidential Information solely for the Purpose;
2. keep it secret, with at least the care it applies to its own confidential information and no less than reasonable care;
3. not copy or record it beyond what the Purpose requires;
4. not reverse engineer, decompile or attempt to derive the underlying know-how of anything disclosed;
5. tell the Discloser without delay if it becomes aware of any loss, unauthorised access or disclosure.

## 6. Who it may be shared with

The Recipient may share Confidential Information with those of its directors, employees, contractors and professional advisers who need it for the Purpose, provided they are bound by confidentiality obligations no weaker than these. The Recipient stays responsible for their compliance.

ARC AI additionally uses the service providers named in its Privacy Policy — currently Supabase (database and storage), Resend (email delivery), Google Analytics (analytics) and Make.com (workflow automation) — under contractual duties of confidentiality. Adding or replacing a provider does not require a new agreement, but ARC AI remains responsible for their handling of your information.

## 7. Disclosure required by law

If the Recipient is required by law, a court or a regulator to disclose Confidential Information, it may do so — but only to the extent required, and (where lawful and practicable) after giving the Discloser enough notice to seek protective measures.

## 8. Term and survival

This agreement starts on the date above and continues for **two (2) years**, whether or not the parties go on to work together. The confidentiality obligations survive for **three (3) years** from the date each item of Confidential Information was disclosed, and indefinitely for anything that is a trade secret or personal data.

## 9. Return and deletion

On written request, the Recipient will return or destroy the Confidential Information in its possession and confirm it has done so. It may keep one copy where required by law, by its professional obligations, or where held in routine backups that are not readily accessible — and that copy stays subject to this agreement for as long as it is kept.

## 10. No licence, no commitment

Nothing here transfers or licenses any intellectual property, and nothing obliges either party to proceed with any transaction, enter any further agreement or continue discussions.

## 11. Publicity

Neither party will announce or publicise the discussions, or use the other's name or logo, without prior written consent. Consent for ARC AI to reference the engagement in its portfolio and case studies, if given, will be recorded in the services agreement rather than here.

## 12. Data protection

Where Confidential Information includes personal data, each party will comply with the data protection law applicable to it, including the UK GDPR and the EU GDPR where they apply, and Sri Lanka's Personal Data Protection Act. Where ARC AI processes personal data on the Client's instructions, it does so as a processor and the parties will put a separate data processing agreement in place if either asks for one.

## 13. No warranty

Confidential Information is provided "as is". Neither party warrants its accuracy or completeness, and neither is liable to the other for relying on it — save that nothing in this clause limits liability for fraud or fraudulent misrepresentation.

## 14. Remedies

Damages alone may not be an adequate remedy for a breach of this agreement. Either party may seek injunctive or other equitable relief, without needing to prove actual damage and without posting security, in addition to any other remedy available to it.

## 15. Governing law

This agreement is governed by the laws of ${AGREEMENT_COMPANY.governingLaw}, and the courts of ${AGREEMENT_COMPANY.governingLaw} have jurisdiction. Where the Client is established in the United Kingdom, the parties may instead agree in writing that the courts of England and Wales have jurisdiction.

## 16. General

- **Entire agreement.** This is the whole agreement between the parties on confidentiality, and replaces anything said or written before it on that subject.
- **Variation.** Only a written variation signed by both parties has effect.
- **No assignment.** Neither party may assign this agreement without the other's written consent.
- **Severance.** If any part is unenforceable, the rest continues in force.
- **No waiver.** A delay in enforcing a right does not waive it.
- **Electronic signature.** This agreement may be signed electronically and in counterparts, each of which is an original and which together form one agreement.

---

By signing below, the Client confirms they have read and accept this agreement and are authorised to sign for the organisation named above.
`;

/* ------------------------------------------------------------------ */
/* 2. Services agreement                                                */
/* ------------------------------------------------------------------ */

const CONTRACT_BODY = `# Services Agreement

Dated {{date}}.

## 1. The parties

${COMPANY_BLOCK}

**{{client}}** ("the Client", "you"), whose details are recorded on the signature page.

## 2. What this agreement covers

This agreement sets the terms on which ARC AI provides services to the Client. It applies to {{project}} and to any further work the parties agree under it.

**The scope, deliverables, timeline and price are not set out here — they are set out in the proposal ARC AI has issued and the Client has accepted.** That accepted proposal and this agreement are read together. If they conflict, the accepted proposal governs the work and the price; this agreement governs everything else.

Any work not described in the accepted proposal is out of scope until it is quoted and accepted in writing.

## 3. Fees and payment

1. **${UPFRONT_PERCENT}% of the project fee is payable upfront**, before the project commences.
2. **${FINAL_PERCENT}% is payable on completion**, and before launch, handover, admin access, credentials or transfer of final files.
3. Work begins only once the upfront payment has been received.
4. The site or system will not be launched, published, transferred or handed over until the final payment has been received in full.
5. Recurring fees — retainers, protection plans and subscriptions — are billed in advance for each period and continue until cancelled in writing with at least 30 days' notice before the next renewal.
6. All amounts are exclusive of taxes, bank charges and currency conversion costs unless the proposal says otherwise. Amounts are stated in the currency of the accepted proposal.
7. Payments made are non-refundable, except where ARC AI has failed to deliver and has not remedied that failure within a reasonable period after written notice.

## 4. Late payment

If an invoice is not paid by its due date, ARC AI may suspend work and withhold deliverables, access and hosting until the account is settled, and may charge reasonable costs of recovery. Suspension for non-payment does not extend any agreed timeline and does not relieve the Client of the sums due.

## 5. What the Client provides

The Client will provide, promptly and in a usable format:

- brand assets — logo, colours and fonts — where available;
- copy, product data, images and any other content the work requires;
- access to domains, hosting, analytics, social accounts and any third-party systems the work touches;
- a single named person authorised to give feedback and approvals;
- approval of, or the text for, any policy or legal content that must appear.

The Client confirms it owns, or is licensed to use, everything it supplies, and that ARC AI may use it for the project.

## 6. Response times, pause and restart

ARC AI schedules a team and a delivery slot for each project, and that slot cannot be held open indefinitely while a project is waiting on the Client.

1. ARC AI will make its requests for content, feedback, approvals or access in writing, by email or through the client portal.
2. **If ARC AI receives no substantive response to such a request for three (3) consecutive weeks — ${PAUSE_AFTER_DAYS} calendar days from the date the request was sent — the project is placed on pause.** ARC AI will notify the Client when this happens and will release the assigned team and delivery slot.
3. **Restarting a paused project requires a restart fee of Rs ${RESTART_FEE_LKR.toLocaleString("en-US")}**, payable before work resumes. This covers rescheduling, re-briefing the team and reloading the project environment. It is in addition to the project fee and is not credited against it.
4. A restart is subject to availability. Timelines are re-agreed from the restart date; the original dates no longer apply.
5. A pause does not change the payment schedule. Sums already paid are not refunded, and sums already due remain due.
6. If a project stays paused for more than **ninety (90) days**, ARC AI may close it and treat the engagement as terminated under clause 18. Work completed to that point will be invoiced, and any files ready for handover will be released once the account is settled.

## 7. Revisions and changes

The accepted proposal states what is included. Revisions within that scope are included; a change of direction, an added page, an added feature or a rewrite after approval is a change request, quoted separately and started only once accepted in writing.

Approval given by the Client's named contact is final for that stage. Reopening an approved stage is a change request.

## 8. Timelines

Timelines in the accepted proposal are estimates made on the assumption that the Client responds and approves within the times agreed, and that the content and access in clause 5 arrive when requested. Delay on the Client's side moves the delivery dates by at least the length of that delay. ARC AI will tell the Client when a date is at risk.

## 9. Hosting, storage and domains

- Hosting is included under the agreed setup, subject to normal usage limits.
- The backend includes 500MB of free Supabase storage. If the project exceeds the free storage limits, any required upgrade or additional backend cost will be discussed and approved before it is billed.
- Domain purchase and renewal are not included. The domain must be provided or purchased by the Client.
- Third-party services the project depends on — hosting providers, payment gateways, AI providers, messaging platforms and similar — are supplied on their own terms, and their fees, availability and policy changes are outside ARC AI's control.

## 10. Maintenance and support

After launch, support is available under either of the following. Neither is automatic; the Client chooses.

- **Website Protection plans** — 3 months Rs 40,000 · 6 months Rs 60,000 · 12 months Rs 90,000. Includes security and dependency updates, uptime monitoring and backups, minor text and image updates, and priority bug fixes.
- **Pay-Per-Fix** — Rs 5,000 per fix for small bugs, UI tweaks, text or image updates, or broken links.

New pages and custom feature development are quoted separately based on scope.

Genuine defects in ARC AI's own work, reported within 30 days of handover, are corrected at no charge. That warranty does not cover changes made by the Client or a third party, third-party service outages, or new requirements.

## 11. Intellectual property

1. On receipt of payment in full, the Client owns the final deliverables produced specifically for it, and ARC AI assigns to the Client the rights it holds in them.
2. ARC AI keeps ownership of everything it brings to the project or develops for general use — its frameworks, components, libraries, prompts, automation templates, internal tooling and know-how — and grants the Client a perpetual, non-exclusive, non-transferable licence to use those elements as part of the deliverables.
3. Third-party materials — fonts, stock media, plugins, open-source components, AI providers — remain with their owners and are supplied under their own licences. Licence fees are the Client's responsibility unless the proposal says otherwise.
4. Until payment in full is received, all deliverables remain ARC AI's property and the Client has no right to use them.

## 12. Portfolio and publicity

ARC AI may describe the engagement and display the work in its portfolio, case studies and marketing, using the Client's name and logo for that purpose. The Client may withdraw this permission in writing at any time, and ARC AI will remove the material from anything it controls within a reasonable period. Nothing confidential is published either way.

## 13. Confidentiality

Each party will keep the other's non-public information confidential and use it only for this engagement. Where the parties have signed a non-disclosure agreement, that agreement continues to apply and governs confidentiality between them.

## 14. Data protection

Each party will comply with the data protection law applicable to it, including the UK GDPR and the EU GDPR where they apply, and Sri Lanka's Personal Data Protection Act. Where ARC AI processes personal data on the Client's instructions it acts as a processor, and will do so only on those instructions, keep it secure, and impose equivalent duties on its sub-processors — currently Supabase (database and storage), Resend (email delivery), Google Analytics (analytics) and Make.com (workflow automation). The parties will enter a separate data processing agreement if either asks for one.

## 15. AI-assisted work

Where the services include AI agents, automation or AI-assisted content, the Client acknowledges that AI systems can produce inaccurate or unexpected output, and that they depend on third-party models whose availability, pricing and behaviour may change. ARC AI will configure and test the systems it builds, but the Client is responsible for reviewing AI-generated output before it is relied on, published or sent to its own customers.

## 16. Warranties and limits

ARC AI will provide the services with reasonable skill and care, by suitably skilled people.

Beyond that, and to the fullest extent permitted by law, the services are provided without further warranty. ARC AI does not warrant uninterrupted or error-free operation, and does not guarantee specific commercial results from marketing, SEO or AI automation work, as outcomes depend on factors outside its control.

## 17. Limitation of liability

Neither party excludes liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot lawfully be excluded.

Subject to that, and to the fullest extent permitted by law:

1. neither party is liable for indirect, incidental, special, consequential or punitive loss, including loss of profit, revenue, data, goodwill or business opportunity; and
2. **ARC AI's total liability for all claims arising out of or in connection with this agreement is limited to the amount actually paid by the Client for the specific service giving rise to the claim.**

## 18. Term and termination

This agreement runs from the date above until the engagement ends or either party terminates it.

Either party may terminate on 30 days' written notice, or immediately if the other commits a material breach that is not remedied within 14 days of written notice, becomes insolvent, or ceases to trade.

On termination: the Client pays for all work completed and all costs committed up to that date; ARC AI hands over the completed deliverables once the account is settled; and clauses 11 to 17, 19 and 20 survive.

## 19. Force majeure

Neither party is liable for a failure or delay caused by something beyond its reasonable control, including power or internet failure, third-party platform outage, act of government, civil unrest, natural disaster or epidemic. The affected party will tell the other promptly, and the timeline moves by the length of the disruption.

## 20. Governing law

This agreement is governed by the laws of ${AGREEMENT_COMPANY.governingLaw}, and the courts of ${AGREEMENT_COMPANY.governingLaw} have jurisdiction. Where the Client is established in the United Kingdom, the parties may instead agree in writing that the courts of England and Wales have jurisdiction.

## 21. General

- **Independent contractor.** ARC AI provides the services as an independent contractor. Nothing here creates a partnership, joint venture or employment.
- **Subcontracting.** ARC AI may use subcontractors and remains responsible for their work.
- **Non-solicitation.** During the engagement and for 12 months after it, neither party will solicit for employment anyone the other assigned to the project, except through a general public advertisement.
- **Entire agreement.** This agreement and the accepted proposal are the whole agreement between the parties, and replace anything said or written before them.
- **Variation.** Only a written variation agreed by both parties has effect.
- **Assignment.** Neither party may assign this agreement without the other's written consent, which will not be unreasonably withheld.
- **Severance.** If any part is unenforceable, the rest continues in force.
- **Notices.** Notices are given in writing by email — to ${AGREEMENT_COMPANY.email} for ARC AI, and to the Client's address on the signature page.
- **Electronic signature.** This agreement may be signed electronically and in counterparts, each of which is an original and which together form one agreement.

---

By signing below, the Client confirms they have read and accept this agreement together with the accepted proposal for {{project}}, and are authorised to sign for the organisation named above.
`;

/**
 * The built-in templates, offered in the editor alongside anything the team
 * has saved in `agreement_templates`.
 */
export const BUILT_IN_AGREEMENT_TEMPLATES: BuiltInTemplate[] = [
  {
    id: "builtin:contract",
    name: "Services agreement (standard contract)",
    kind: "contract",
    body_md: CONTRACT_BODY,
  },
  {
    id: "builtin:nda",
    name: "Mutual NDA",
    kind: "nda",
    body_md: NDA_BODY,
  },
];

/** A built-in template by id, or null — used when one is picked in the editor. */
export function builtInTemplate(id: string): BuiltInTemplate | null {
  return BUILT_IN_AGREEMENT_TEMPLATES.find((t) => t.id === id) ?? null;
}
