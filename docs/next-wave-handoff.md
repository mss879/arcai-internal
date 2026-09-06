# Next Wave — handoff (fourth edition — the wave is built)

**Read this first, then `AGENTS.md` and `docs/projects-roadmap-handoff.md` §2/§4.**
Updated 2026-09-06 at commit `90b884d` ("backups written down, dead code out,
the public surface documented"). **All 46 build steps are done.** There is
nothing left to build in this wave; what remains is the push checklist in
§1. Paste this into a new chat, or say:
*"Read `docs/next-wave-handoff.md` — the wave is built; help me apply the
migrations and push."*

This file was refreshed after every committed step, so each step's entry
below is complete.

---

## 1. Where things stand

**46 of 46 build steps are done — all five tracks — plus an audit-and-fix
pass over the first 26. 56 commits on `arc_ai_crm_system` `main` ahead of
`origin/main`, plus 2 on `arc_ai_website`. Nothing is pushed to either
remote.**

```
git log --oneline origin/main..HEAD
```

Every commit passed the four-command check:

```bash
find .next/types -name "* [0-9].ts" -delete && npx tsc --noEmit && npx vitest run \
  && node scripts/lint-baseline.mjs && npm run build
```

209 tests across 15 files. Lint baseline is 24 errors in 10 files (13 in `src`,
11 in the vendored MediaPipe bundles under `public/arcus/hand/`) — `node
scripts/lint-baseline.mjs --write` re-records it. If `npm run build` fails with
`ENOTEMPTY` on `.next/server`, `rm -rf .next/server` first.

Every commit, including the last one, passed the full check.

### ⚠️ Before ANY push

Apply these by hand in the Supabase SQL editor, **in this order**:

```
0112 → 0113 → 0114 → 0115 → 0116 → 0117 → 0118 → 0119 → 0120 → 0121
```

**Added 2026-09-07 (after the wave): `0125_web_lead_ledger.sql`.** The lead
ledger behind Web Analytics → Leads, the `leads.website_lead_id` key the
website's contact form now sends, and the checklist's *Check progress*
columns. Safe to run at any time and idempotent; the code degrades to the old
session-flag conversions until it is applied and records
`ledger: The lead ledger table (web_leads) does not exist yet` on the Setup
tab. After applying it, press **Rebuild history** once so every past
conversion (including the 15 newsletter-script "conversions") is reconciled.
See `docs/web-analytics.md` → *The lead ledger*.

`0112`–`0114` predate this wave and were already outstanding. The code degrades
quietly without them (empty lists, unassigned threads, in-process-only rate
limiting, invoices with no status column) rather than crashing — which is
exactly why a missing one is easy not to notice.

**`0120` is the only migration in the wave that backfills. Run it on a branch
database first.** Its header carries five pre-check queries; the DO blocks
raise notices with the counts they touched, and the three partial unique
indexes are guarded — if duplicate quote or notice numbers exist, the index is
skipped with a notice telling you to fix them by hand and re-run that one
statement. `0120` was extended twice after it was first written (the
`approvals_count()` replacement in §7b, and the slip bucket policies) — apply
the file as it is now, not a copy taken earlier.

**`0121_platform_foundation.sql` is new and additive** (no backfill). It
holds §1 (the `expenses` category CHECK widened with `commission`) and §2
(`profiles.capabilities` + CHECK + the all-four backfill for members, and
the `capabilities_enforced` seed row), §3 (`system_events` + policies) and
§4 (`error_events` + policies) and §5 (`clients.anonymised_at`). It is
complete; nothing else in the wave needs SQL.

### The push checklist

1. Apply `0112` → … → `0121` in the Supabase SQL editor, in order (`0120` on
   a branch database first — see above). Every one is additive except the
   documented backfills in `0120` and the members' capability backfill in
   `0121` §2.
2. Set the two new environment variables when you want the features:
   `SOCIAL_TOKEN_KEY` (before connecting a social account on `/settings`)
   and `SENTRY_DSN` (optional — errors are recorded in `error_events`
   either way).
3. Push `arc_ai_crm_system` `main` (CI runs the four-command check), then
   `arc_ai_website` `main` on its own remote.
4. Point an uptime monitor at `GET /api/health`.
5. Leave `capabilities_enforced` OFF for a week (the sidebar already hides
   areas members are not ticked for); switch it on from `/settings` once the
   Team page's ticks look right.
Apply it last, as the file stands when you push.

`arc_ai_website` has its own two commits (`39cb034` UTM capture, `d2b9d1c`
client-login link) and needs no migration.

---

## 2. What is built

### Track 1 — one inbox (COMPLETE)

| Commit | Feature |
| --- | --- |
| `dc24cf9` | T5.6 CI + tests. GH Actions runs tsc → vitest → lint → build. |
| `5d7eb90` | T1.1 `sendAndLogEmail()` + migration **0115**. |
| `6a7c9ae` | T1.2 `/inbox` — WhatsApp, SMS, portal, email in one screen. |
| `4d68022` | T1.3 Targeted hand-off. |
| `5408b0b` | T1.4 Compose email + templates; "Email" on invoices, quotes, proposals. |
| `1f77d45` | T1.5 `.ics` invites. |
| `5ea1c53` | T1.6 Timeline learns email, portal comments, change requests. |
| `2e5ccec` | T1.7 Notification preferences, quiet hours, bell v2. |
| `b794887` | T1.9 Assistant `prepare_email` / `prepare_whatsapp` / `assign_conversation`. |

### Track 2 — client & growth machine (COMPLETE)

| Commit | Feature |
| --- | --- |
| `ee7ff92` | T5.4 Rate limiting + migration **0116**. |
| `2c8c7c3` | T2.8 + T1.8 Scoring / churn / digest on the tick; digest emails. |
| `aa2da16` | T2.6 `createInboundLead()` + UTM + migration **0117**. |
| `e232c2f` | T2.7 chat → lead; T2.5 referrals. |
| `978a93a` | T2.1 Proposals signable at `/p/[token]`. |
| `008ee47` | T2.2 Agreements at `/a/[token]` + `src/lib/markdown.ts`. |
| `cbb24cc` | T2.4 Testimonials → website; T2.9 web insight → to-do. |
| `b105629` | T2.10 Outreach sequences + open/click tracking. |
| `a410499` | T2.11 Free site-audit magnet at `/audit`. |
| `a931e69` | T2.3 Portal 2.0. |
| `d76b8da` | T2.12 Content client approval + Meta publishing + migration **0118**. |

### Track 3 — team & intelligence (COMPLETE)

| Commit | Feature |
| --- | --- |
| `569d6d3` | T3.2 `/approvals` + migration **0119**. |
| `c78d837` | T3.3 To-do recurrence, templates, labels, estimates, comments. |
| `de102a2` | T3.4 Knowledge base at `/kb`. |
| `bd52621` | T3.1 Targets + leaderboard + `src/lib/finance-math.ts`. |
| `e13d6aa` | **Audit fix** — the pieces of steps 0–26 the plan named and the build skipped (see §3). |
| `e9ab085` | T3.5 Goals + Forecast tabs on Intelligence; the forecast card and targets tile on Finance Overview (that half of T4.9 is done). |
| `6bdb4c7` | T3.6 Member scorecards (`src/lib/scorecards.ts`, this month and last). |
| `faf2fc1` | T3.7 Assistant `create_milestone`, `send_portal_link` (card → `/api/assistant/send-portal-link`). |
| `3b8ec71` | T3.8 Calendar month/week/day + milestones + instalments. |
| `e6a4c4a` | T3.9 Offline `/projects/go` (service worker cache, IndexedDB outbox, `/api/go/data`, `/api/go/sync`). |

### Track 4 — get paid faster (COMPLETE)

| Commit | Feature |
| --- | --- |
| `ad4fe77` | **T4.1 + T4.8 + T4.2** on migration **0120**: invoices as a state (`src/lib/invoices.ts`), `document_counters` + `next_document_number()` (`src/lib/document-number.ts`), `recordPayment()` (`src/lib/payments.ts`), assistant `mark_invoice_paid` card → `/api/assistant/confirm-payment`. Currency reaches the PDF, the public page and the email data. |
| `4f80d33` | **T4.3 + T4.4** Bank slips: upload on the public invoice page and the portal (3 languages), WhatsApp slips filed to the same queue, `parseSlipImage`/`parseSlipText`, Finance → Slips tab, slips on `/approvals`, `notifyClient()` (`src/lib/client-notify.ts`). |
| `908e8b8` | **T4.5** Recurring billing: `auto_invoice` + `remind` on an arrangement, `createRecurringInvoice()`, reminders on the tick, "Invoice now", retainer projects upsert their `recurring_income` row. |
| `97f64e1` | **T4.6** Client statement of account: `src/lib/statement.ts` (`composeStatement()` pure + `buildClientStatement()`, pinned by `statement.test.ts`), `statement-pdf.tsx` (fixed page footer, no Page lineHeight), authed `/api/statements/[clientId]/pdf`, public `/public/statement/[token]` + PDF on `clients.statement_token` (rate-limited), Statement card on the client's Money tab (Download / Email via the compose modal's `attachStatement` → kind `statement` / WhatsApp as a document while the window is open, link by SMS otherwise — first use of `sendWhatsAppDocument`), statement link on `/portal`, assistant `client_statement`. |
| `20e45e8` | **T4.7** Commission payout run: `runCommissionPayout()` in `team/[id]/actions.ts` (one `commission_payouts` row; approved → paid in ONE update; loan deduction through `saveLoanRepayment` with `payout_id` + `silent`; an `expenses` row, category `commission` from **0121** with `salaries` fallback; `notifyUsers` type `commission`). `summariseMemberMoney()` gains `commissionApproved`. "Pay out" + payout modal + Payouts card on the member page. |
| `76c63f9` | **T4.9** `inflowLines()` in `finance-math.ts` — `monthlyInflows()` is now those lines minus the words, and the Tax tab reads them, so Overview and Tax cannot disagree (tested). `profitAndLoss()` + a P&L strip on Overview (payouts shown as "of which", never subtracted twice — the run's expense row is already in "out"). `src/components/finance/receipt-reader.tsx` on the company expense form. |

---

### Track 5 — platform foundation (COMPLETE)

| Commit | Feature |
| --- | --- |
| `(step 41)` | **T5.1** `/settings` hub (`src/app/(app)/settings/`): cards to every module's settings, forms for `app_settings.lead_form` / `outreach` / `web_chat_auto_lead`, the social-accounts connect form (first writer of `social_accounts`; `encryptToken()`, refuses without `SOCIAL_TOKEN_KEY`), `document_counters` read-only + forward-only "set next number" (service-role client behind `requireAdmin()` — the table has no RLS policies). Nav item (adminOnly), topbar gear, app-map entry. Delivery / WhatsApp / Content / Automation / Intelligence views take `?tab=` (`initialTab` prop, validated against `TAB_KEYS`). |
| `(step 42)` | **T5.2** Capabilities: `src/lib/capabilities.ts` (pure `hasCapability()`, `CAPABILITIES`, `normaliseCapabilities`), `capabilities-server.ts` (`capabilitiesEnforced()` via the service-role client, `actorHasCapability()`, `capabilityAudienceIds()`), `auth.ts` `requireCapability()` / `assertCapability()`; `NavItem.capability` + the sidebar filter (committed as an index-only hunk); guards on 9 pages; `recordPayment()` choke point; `notifyFinance()` = finance audience in `payments.ts` and `slips.ts`; member editor checkboxes; Permissions panel on `/settings`; `docs/ops.md` "RLS-lite". Enforcement is OFF until an admin switches it on. |
| `(step 43)` | **T5.3** `system_events` (0121 §3) + `src/lib/system-audit.ts` `logSystemWrite()` (best-effort) / `listSystemEvents()`; called from `recordPayment()` (null actor), `generateProjectInvoice()`, `createRecurringInvoice()`, `processDueSocialPosts()`, `publishReview()`, `publishVacancy()`, `createSlip()` (whatsapp), `runCommissionPayout()`. Team page "System activity" (`team/system-activity.tsx`) merges `member_changes` + `system_events`, 7 days, people/system filter. |
| `(step 44)` | **T5.5** `/api/health` (public + machine, rate-limited; DB ping, `automation_tick` + new `wa_agent_tick` stamps, env booleans, open-fault count → 200/503). `error_events` (0121 §4) + `src/lib/errors.ts` `captureError()` (fingerprinted, counted, admin notify on first sighting / 6h, raw Sentry envelope when `SENTRY_DSN`), hooked into the three tick routes; `src/app/error.tsx` + `global-error.tsx` → `POST /api/errors`; Errors panel on `/settings` (resolve / reopen); `docs/ops.md` runbook paragraph. |
| `(step 45)` | **T5.7** `src/lib/client-erasure.ts`: `eraseClient(db, id, mode, {actorId})` (anonymise scrubs clients + wa_contacts/wa_messages + sms_messages + leads + email_messages + meeting_bookings + agreements + payment_slips objects/parse + client_login_codes, re-mints `statement_token`, stamps `anonymised_at`; delete refused with invoices/payments) and `exportClientData()` (zip via jszip). `GET /api/clients/[id]/export` (admin). `deleteClient()` on the list is now the erasure; `eraseClientAction()` with the typed name; "Export data" / "Erase…" on the client page. Both logged to `system_events` (job `gdpr`). |
| `90b884d` | **T5.8** `docs/ops.md` backups section (daily backups + PITR; storage is not in `pg_dump`; the private `payment-slips` bucket holds images of bank-account details; secrets live in Netlify); `docs/api.md` (every public URL, its guard and its rate limit, the two public slip uploads); `sendCredentialsEmail()` removed; root `zz_*.mjs` and the untracked `mobile-voice-screen.tsx` deleted. |

## 3. The audit of steps 0–26

The previous chat's handoff said 26 steps were done. Against the plan's "How"
bullets, the cores, migrations and pages were all there; a set of named
details were not. Commit `e13d6aa` closed them: rate limits on the booking
form, the portal's calendar file and the client login; the assistant's
WhatsApp send refusing free text outside the 24h window; a lead's first
open/click on its timeline; the `utm_source` filter and the pipeline report's
by-source table; "New agreement" from a project's Client tab and a proposal
row; the `/portal` account page listing files, agreements, meetings, booking
and a referral code; the referral block on the per-project portal (3
languages) and the introductions column on `/clients`; a Publishing tab in
Content Studio with `queueSocialPost()` as the one queue writer and the
assistant's `schedule_social_post` card + `content_queue`; a targets tile on
the dashboard and `set_target` / `targets_report` / `kb_page`; the approvals
badge in the topbar (`approvals_count`, realtime on the two outside-in queues)
and the `approval` notification type on change requests and design picks;
label filter, apply-template and save-as-template on To-Dos.

Two things were judged fine as built and left alone: the lead attribution
card lives on the lead's detail page rather than the form modal, and
deliverables have their own card on the project's Files tab rather than a
toggle inside `files-section.tsx`. Social accounts still have no management
UI — the plan puts it under `/settings` (step 41).

---

## 4. What remains

Nothing to build. The push checklist is in §1. Two things a later wave may
want, both deliberately left: the WhatsApp admin tabs are gated by role, not
by the `marketing` capability (an admin has every capability, so there was
nothing to gate); and `agreements.pdf_path` objects are not removed on
erasure (the bucket is not recorded on the row — the signature image inside
the row IS nulled).

## 5. Corrections to the original plan

Five things the plan got wrong. They are all silent failures.

1. **Widening a CHECK is `drop constraint if exists` + `add constraint`** —
   not a `do $$ … exception when duplicate_object` block, which swallows the
   failure and leaves the OLD constraint in place. The do-$$ form is only for
   adding a brand-new named constraint.
2. **Widening REPLACES a CHECK**, so the new list must repeat every value any
   earlier migration added. Always `grep -rn "<constraint_name>"
   supabase/migrations/` before widening. (0120 does this for
   `delivery_events_kind_check` and `invoices_status_check`.)
3. **Public route prefixes are NOT matched in `src/proxy.ts`.** The list is
   `PUBLIC_PREFIXES` in `src/lib/supabase/middleware.ts` (machine routes also
   go in `MACHINE_PREFIXES` there AND the matcher exclusion in `proxy.ts`).
4. **`src/lib/database.types.ts` is hand-authored**, not generated. Never run
   `supabase gen types`. Tables are NOT alphabetical: a new one goes at the END
   of `Tables` (before `Views`!) under a `// 0NNN — summary` comment. **Views
   come after Tables in the same object** — a new table pasted after
   `project_rollups` lands in `Views` and every `Database["public"]["Tables"]
   ["x"]` reference fails. (This bit me once.)
5. **`payments.project_id` is nullable since 0120.** Every place that keyed a
   Map on `p.project_id` needed a null guard (`tools-delivery.ts`,
   `tools-finance.ts`, `intelligence.ts`). Anything new that reads `payments`
   must expect null.

---

## 6. Conventions this wave established

**Single-owner cores. Do not reimplement any of these anywhere else.**

| Core | File |
| --- | --- |
| `sendAndLogEmail()` — every client/lead/project email | `src/lib/email-outbox.ts` |
| `createInboundLead()` — every inbound enquiry | `src/lib/lead-intake.ts` |
| `monthlyInflows()` / `forecastCash()` / `detectStandingCosts()` | `src/lib/finance-math.ts` |
| `loadCashForecast()` — the one forecast object (Intelligence + Finance) | `src/lib/finance-forecast.ts` |
| `enforceRateLimit()` — every public route and action | `src/lib/rate-limit.ts` |
| `listApprovalItems()` — the eight decision queues (slips added) | `src/lib/approvals.ts` |
| `upsertTarget()` — the only writer of `targets` | `src/lib/targets.ts` |
| `queueSocialPost()` — the only writer of `social_posts` | `src/lib/social/queue.ts` |
| `recordPayment()` — every payment, from any screen, slip or the assistant | `src/lib/payments.ts` |
| `reconcileInvoice()` / `updateInvoice` / `voidInvoice` / `reissueInvoice` / `createRecurringInvoice` — the only writers of invoice state | `src/lib/invoices.ts` |
| `allocateDocumentNumber()` → `next_document_number(kind)` — every invoice/quote/notice number at INSERT | `src/lib/document-number.ts` (+ `nextQuoteNumber`, `nextInvoiceNumberFor` in `src/lib/quotes.ts`) |
| `notifyClient()` — every client message outside an open thread | `src/lib/client-notify.ts` |
| `createSlip()` / `confirmSlip()` / `rejectSlip()` / `listSlips()` | `src/lib/slips.ts` |
| `loadGoProjects()` — the on-the-go list for the page and `/api/go/data` | `src/lib/go-projects.ts` |
| `memberScorecard()` — a mirror, never a writer | `src/lib/scorecards.ts` |
| `invoiceStatusFor()` / `allocatePayment()` / `settledAmount()` etc. | `src/lib/projects.ts` |
| `markdownToHtml()` — the ONLY escaper for stored text | `src/lib/markdown.ts` |
| `choosePortalChannel()` — the portal send ladder | `src/lib/portal-send-core.ts` |
| `publishReview()` + `careers/sync` — the ONLY website writers | `src/lib/reviews/publish.ts` |
| `composeStatement()` / `buildClientStatement()` — the client statement, every surface | `src/lib/statement.ts` |
| `inflowLines()` → `monthlyInflows()` — money in, with and without words | `src/lib/finance-math.ts` |
| `runCommissionPayout()` — the only thing that marks a commission `paid` | `src/app/(app)/team/[id]/actions.ts` |
| `logSystemWrite()` — every write nobody clicked for | `src/lib/system-audit.ts` |
| `captureError()` — every failure, one row per fault | `src/lib/errors.ts` |
| `eraseClient()` / `exportClientData()` — forgetting a person, and their copy | `src/lib/client-erasure.ts` |

**Money rules that are now load-bearing:**

- `recordPayment()` never writes `deposit_paid`; `settledAmount()` reconciles.
- An instalment ticked off and a recurring month received are THE money for
  `monthlyInflows()` — `recordPayment()` links them and writes **no** `payments`
  row for them. A slip, a project payment, a board row flip or the assistant
  DO write (or link) a row. Double-counting is the bug this guards against.
- `reconcileInvoice()` sums linked `payments` + `company_payments` +
  `payment_installments` + `recurring_income_entries`; with nothing linked it
  falls back to the legacy `amount_paid` snapshot / `payment_received` stamp.
  The stamp follows the state (its two automatic values only).
- `allocatePayment()` settles a project's open invoices oldest first; a
  payment row links to the first invoice it settles (no per-invoice split is
  stored — reported, not recorded).
- Every document number comes from the counter at INSERT.
  `nextDocumentNumber()` / `nextInvoiceNumber()` in TS are form PREVIEWS and
  the fallback before 0120 exists.

**Other rules in force:**

- A new assistant confirm card touches four files: `src/lib/assistant-cards.ts`
  (data type + union), `assistant-card.tsx` (component + `ConfirmFooter` +
  dispatch + prop), `use-voice-chat.tsx` (`CONFIRM_CARD_TYPES`, the send
  callback, the voice-confirm branch AND its reply text, the `VoiceChat` type,
  the returned object), and `src/lib/assistant/missions.ts` (`isConfirmCard`
  + `parkApproval` kind). Then the three surfaces pass the callback:
  `voice-assistant.tsx`, `assistant-workspace.tsx` (props type + destructure +
  two mounts), `approvals-tray.tsx` (wrapped in `record()`). Five cards exist
  now as worked examples: email, whatsapp, social_post, portal_link, mark_paid.
- A new automation trigger or step touches three: `database.types.ts`,
  `automation-meta.ts`, the executor switch in `automation.ts`.
- A new tick pass is registered in `PASSES` (`api/automation/tick/route.ts`)
  and self-gates with a stamp in `app_settings`, claimed BEFORE the work.
  Reminders in `recurring-income.ts` claim the stamp on the ROW before
  sending, which is the same idea.
- `"use server"` modules export only async functions. Every server action that
  a public page can reach re-resolves its token and calls `enforceRateLimit()`
  before touching the database; `src/app/public/invoice/[token]/actions.ts`
  and `uploadPortalPaymentSlip` are the newest examples.
- A `"use client"` component may receive a server action as a prop from
  another client component (`SlipUploadForm` takes `onUpload`); never from a
  server component.
- Never `git add -A`. The repo carries a large uncommitted hand-tracking
  feature (`src/components/assistant/interactivity/*`, `studio-*`,
  `command/*`, `public/arcus/hand/*`, `arcus-preview/*`, `layout/sidebar.tsx`,
  `globals.css`, `mobile-voice-screen.tsx`). Stage explicitly, every time —
  the previous chat kept a file list in the scratchpad and piped it to
  `git add` (`cat list | xargs git add`; BSD `xargs` has no `-a`).
- The shell's working directory sometimes resets to `~/Desktop/ARC_AI`
  between tool calls. Start commands with
  `cd /Users/shahidshamir/Desktop/ARC_AI/arc_ai_crm_system &&`.
- The two repos are separate remotes. Commit and push each on its own.

---

## 7. Known deferrals and open questions

- **Meta app review** for `instagram_content_publish` / `pages_manage_posts`
  takes weeks. `SOCIAL_DRY_RUN=1` runs the whole publish queue without calling
  Meta. Accounts are connected on `/settings` (needs `SOCIAL_TOKEN_KEY`).
- **WhatsApp template approvals** are needed for slip confirmations and
  recurring reminders outside the 24h window. `notifyClient()` has no
  template rung on purpose (the only approved template is the portal link);
  it falls to SMS, then a task. When templates are approved, the rung goes in
  `src/lib/client-notify.ts` and nowhere else.
- **`payment-slips` bucket policies** in 0120 grant authenticated read/insert/
  delete; the public routes upload through the service-role client. There is
  no anon policy, on purpose.
- **Commission expense category**: decided in step 39 — `commission`, via
  the 0121 CHECK widening; `runCommissionPayout()` falls back to `salaries`
  on a database without 0121.
- **Slip idempotency on WhatsApp**: `fileWhatsAppSlip()` files on every
  classified slip; the 30-day reference/amount duplicate check marks a
  repeat as `duplicate` rather than dropping it.
- **`notifyFinance()`** now means admins + members with the `finance`
  capability (step 42).
- Out of scope this wave, deliberately: payment gateways (hook point only —
  `source: 'gateway'` + `payments.provider_ref`), mailbox/calendar provider
  sync, LinkedIn/TikTok publishing, start/stop timers, multi-tenancy, FX
  conversion (currency is carried and displayed, not converted).
