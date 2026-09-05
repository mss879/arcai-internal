# Next Wave — handoff

**Read this first, then `AGENTS.md` and `docs/projects-roadmap-handoff.md` §2/§4.**
Written 2026-09-05 at commit `bd52621`. Paste this into a new chat, or say:
*"Read `docs/next-wave-handoff.md` and continue from step 27."*

---

## 1. Where things stand

**26 of 46 build steps are done. 24 commits on `arc_ai_crm_system` `main`, plus
2 on `arc_ai_website`. Nothing is pushed to either remote.**

```
git log --oneline origin/main..HEAD    # 29 commits (5 predate this wave)
```

Every commit passed the four-command check:

```bash
find .next/types -name "* [0-9].ts" -delete && npx tsc --noEmit && npx vitest run \
  && node scripts/lint-baseline.mjs && npm run build
```

179 tests across 13 files. Lint baseline is 24 errors in 10 files (13 in `src`,
11 in the vendored MediaPipe bundles under `public/arcus/hand/`) — `node
scripts/lint-baseline.mjs --write` re-records it. If `npm run build` fails with
`ENOTEMPTY` on `.next/server`, `rm -rf .next` first.

### ⚠️ Before ANY push

Apply these by hand in the Supabase SQL editor, **in this order**:

```
0112 → 0113 → 0114 → 0115 → 0116 → 0117 → 0118 → 0119
```

`0112`–`0114` predate this wave and were already outstanding. The code degrades
quietly without them (empty lists, unassigned threads, in-process-only rate
limiting) rather than crashing — which is exactly why a missing one is easy not
to notice.

`arc_ai_website` has its own two commits (`39cb034` UTM capture, `d2b9d1c`
client-login link) and needs no migration.

---

## 2. What is built

### Track 1 — one inbox (COMPLETE)

| Commit | Feature |
| --- | --- |
| `dc24cf9` | T5.6 CI + tests. GH Actions runs tsc → vitest → lint → build. Pure cores extracted from the `server-only` modules so they can be tested. |
| `5d7eb90` | T1.1 `sendAndLogEmail()` + migration **0115**. Every client email leaves an `email_messages` row. `email.ts` is transport only. |
| `6a7c9ae` | T1.2 `/inbox` — WhatsApp, SMS, portal, email in one screen. `conversation_meta` owns thread assignment. |
| `4d68022` | T1.3 Targeted hand-off. `notifyEveryone` gained an audience; `handoff_human` wakes the owner, not the team. |
| `5408b0b` | T1.4 Compose email + templates; "Email" on invoices, quotes, proposals. |
| `1f77d45` | T1.5 `.ics` invites. Stable UID + SEQUENCE so a reschedule updates rather than double-books. |
| `5ea1c53` | T1.6 Timeline learns email, portal comments, change requests. |
| `2e5ccec` | T1.7 Notification preferences, quiet hours, per-thread mute, bell v2. |
| `b794887` | T1.9 Assistant `prepare_email` / `prepare_whatsapp` / `assign_conversation`. |

### Track 2 — client & growth machine (COMPLETE)

| Commit | Feature |
| --- | --- |
| `ee7ff92` | T5.4 Rate limiting on every public endpoint + migration **0116**. |
| `2c8c7c3` | T2.8 + T1.8 Lead scoring / churn / digest on the tick; digest emails. |
| `aa2da16` | T2.6 `createInboundLead()` + UTM attribution + migration **0117**. |
| `e232c2f` | T2.7 chat → lead; T2.5 referrals. |
| `978a93a` | T2.1 Proposals signable at `/p/[token]`; `convert_proposal_to_quote` step. |
| `008ee47` | T2.2 Agreements at `/a/[token]` + `src/lib/markdown.ts`. |
| `cbb24cc` | T2.4 Testimonials → website; T2.9 web insight → to-do. |
| `b105629` | T2.10 Outreach sequences + open/click tracking. |
| `a410499` | T2.11 Free site-audit magnet at `/audit`. |
| `a931e69` | T2.3 Portal 2.0 — deliverables, agreements, meetings, booking. |
| `d76b8da` | T2.12 Content client approval + Meta publishing + migration **0118**. |

### Track 3 — team & intelligence (4 of 9)

| Commit | Feature |
| --- | --- |
| `569d6d3` | T3.2 `/approvals` — all seven queues in one list + migration **0119**. |
| `c78d837` | T3.3 To-do recurrence, templates, labels, estimates, comments. |
| `de102a2` | T3.4 Knowledge base at `/kb`, fed to the WhatsApp agent. |
| `bd52621` | T3.1 Targets + leaderboard + `src/lib/finance-math.ts`. |

---

## 3. What remains — steps 27 to 46

Numbers are the original plan's sequencing table.

### Track 3, remaining

**27 · T3.5 Goals + forecast on Intelligence** — M, no migration.
`intelligence-view.tsx:45` has `type Tab`; add `goals` and `forecast`.
`forecastCash()` already exists and is tested in `src/lib/finance-math.ts`.
The next step is `src/components/finance/forecast-card.tsx` — **`mkdir -p
src/components/finance` first, that directory does not exist yet** (a write to
it failed for exactly this reason). Feed it: scheduled instalments, recurring
entries, open invoices as `scheduledIn`; recurring expenses as `scheduledOut`;
`monthlyInflows`/`monthlyOutflows` history for the run rate. Mount the same
card on Finance Overview for T4.9.

**28 · T3.6 Member scorecards** — S, no migration.
`src/lib/scorecards.ts memberScorecard(db, userId, period)` reusing
`targetsProgress` (`src/lib/targets.ts`), `summariseMemberMoney`
(`src/lib/loans.ts:75`), `time_entries`, `todos`, and first-reply delta from
`conversation_meta.assigned_at`. Section on `team/[id]/member-dashboard.tsx`.
Admin-only figures stay hidden from the member.

**29 · T3.7 Assistant write coverage** — M, needs T4.2 for one tool.
`create_milestone` (tools-delivery.ts), `send_portal_link` (card
`confirm_portal_link` → new `/api/assistant/send-portal-link` →
`sendPortalLink(actor:'assistant')`), `mark_invoice_paid` (card → new
`/api/assistant/confirm-payment` → `recordPayment(source:'assistant')` —
**register only after step 34**). A new card touches four files; see §5.

**30 · T3.8 Calendar week/day + milestones/instalments** — S, no migration.
`src/components/dashboard/calendar.tsx:47` `DayEvent` gains `milestone` and
`installment`; `dashboard/page.tsx` loads both for the window. Month/week/day
switch is local component state. "Add to calendar" per meeting already exists
(`/api/meetings/[id]/ics`).

**31 · T3.9 Offline `/projects/go`** — M, no migration.
`public/sw.js` already exists and is served no-cache (see `next.config.ts`).
Precache the `/projects/go` shell; network-first with cache fallback for it and
a new `/api/go/data`. IndexedDB outbox + Background Sync replaying to a new
authed `/api/go/sync` — which must call `logTime` (`plan-actions.ts:286`) and
`setProjectDeliveryStage`, never write those tables directly.

### Track 4 — get paid faster (migration **0120**, not yet written)

**Write 0120 on a branch database first.** It is the only migration in this
wave that backfills. Put a dry-run count query in its header the way
`0113_merge_website_projects.sql:32-37` does.

**32 · T4.1 Invoice real paid state + currency + update instead of re-issue** — M.
Today "paid" is the `invoices.stamp` image and `saveInvoice`
(`invoices/actions.ts:59-68`) always INSERTs, so re-stamping duplicates the
row. Add `status issued|sent|partially_paid|paid|void`, `paid_at`,
`paid_amount`, `due_date`, `voided_at`, `void_reason`, `reissued_from_id`;
backfill from `stamp`/`sent_at`. New `src/lib/invoices.ts` with `updateInvoice`,
`voidInvoice`, `reissueInvoice`, `reconcileInvoice()`. Pure
`invoiceStatusFor(paid, total)` goes in `projects.ts` **with tests**.
`invoices.currency` (0112) is written by two of five creators and read by no
renderer — fix `invoice-pdf.tsx money()`, the public invoice page and
`invoice-view.tsx`.

**33 · T4.8 Document numbering** — M. `document_counters` +
`next_document_number(kind)` (row lock). Five numbering rules exist today
(`invoice.ts:60-108`, `quote-actions.ts:81,163`, `automation.ts:1296`,
`quotes.ts createQuoteFromProposal`) and no constraint. A DO block marks
duplicate `invoice_number`s as re-issues (keep the oldest) before the partial
unique indexes are created; guard index creation with `exception when
unique_violation` + `raise notice`.

**34 · T4.2 `recordPayment()`** — M. Five writers today
(`projects/actions.ts:208`, `payments/actions.ts:48`, `finance/actions.ts:77`,
`deposit-actions.ts:166`, `ai/tools.ts:3717`), each firing its own event, none
touching an invoice. One core: insert the payment, resolve the invoice →
`reconcileInvoice`, mark the instalment paid, fire ONE `buildPaymentEvent`
(`delivery.ts:363`), log the delivery event, notify finance. **Never write
`deposit_paid`** — `settledAmount()` reconciles. Pure `allocatePayment` in
`projects.ts`, tested.

**35 · T4.3 Bank-slip upload + verification queue** — L. `payment_slips` +
private bucket `payment-slips` in `STORAGE_BUCKETS` (`constants.ts:176`).
`src/lib/ai/receipt.ts` gains `parseSlip()`. Slip card on the public invoice
page under the bank block (`invoice-view.tsx:186-201`) and on the portal Money
section. Confirm → `recordPayment(source:'slip')` → `notifyClient()` (new
`src/lib/client-notify.ts`, the `portal-send.ts` ladder generalised — note
`choosePortalChannel()` is already extracted and tested). Gateway hook point:
`source:'gateway'` + `payments.provider_ref`.

**36 · T4.4 WhatsApp slip → the same queue** — S. `handleInboundPaymentSlip`
(`wa-agent.ts`, near the `handoffAudience` call added in `4d68022`) creates a
`payment_slips` row instead of a task.

**37 · T4.5 Recurring billing** — M. `recurring_income` + `auto_invoice`,
`remind`, `invoice_item`; entries + `invoice_id`, `reminded_at`,
`overdue_reminded_at`. `processRecurringIncome` (`recurring-income.ts:30-114`)
raises the invoice; `runRetainers` (`project-automation.ts:120`) upserts the
retainer's `recurring_income`.

**38 · T4.6 Client statements** — M. `src/lib/statement.ts` +
`statement-pdf.tsx`; authed `/api/statements/[clientId]/pdf` and public
`/public/statement/[token]` using `clients.statement_token` (already added in
0117). Maths reuses `projects.ts` only.

**39 · T4.7 Commission payout run** — S. `commission_payouts` +
`commissions.payout_id`, `member_loan_repayments.payout_id`.

**40 · T4.9 Finance forecast/targets/OCR/tax** — S. Mount the forecast card and
a targets tile on Overview; **write a unit test asserting Overview's total and
Tax's total are equal** (both must go through `monthlyInflows`).

### Track 5 — platform foundation (migration **0121**, not yet written)

**41 · T5.1 `/settings` hub** — S. Cards to every settings surface, plus forms
for `app_settings.lead_form`, `outreach` (`lead-outreach.ts:117`),
`web_chat_auto_lead` (read by `web-analytics/sync.ts chatAutoLeadEnabled`), and
the WhatsApp `handoff_user_id`.

**42 · T5.2 Permissions v2** — M. `profiles.capabilities text[]` backfilled
with all four for members. `hasCapability` / `requireCapability` /
`assertCapability` in `auth.ts`; `NavItem.capability?`. Ship nav-only behind
`app_settings.capabilities_enforced=false` for a week. RLS stays USING(true) —
document as server-check "RLS-lite".

**43 · T5.3 System write audit** — S. `system_events` + `logSystemWrite()` from
`recordPayment`, `generateProjectInvoice`, recurring invoices,
`processDueSocialPosts`, `publishReview`, careers publishes.

**44 · T5.5 Health + error tracking** — S. `/api/health` (DB ping, tick
freshness from `app_settings.automation_tick`, env flags → 200/503) — **add
`/api/health` to `PUBLIC_PREFIXES` in `src/lib/supabase/middleware.ts`**.
`error_events` + `captureError()`.

**45 · T5.7 GDPR erasure + export** — S. `clients.anonymised_at`;
`eraseClient()` replacing the bare delete at `clients/actions.ts:66`;
`exportClientData()` → zip via jszip.

**46 · T5.8 Backups, dead code, `docs/api.md`** — S. Delete
`src/components/assistant/mobile-voice-screen.tsx` (untracked), `email.ts`'s
`sendCredentialsEmail` (zero callers), root `zz_*.mjs`. Write `docs/api.md`
covering `/api/public/v1/*`, hooks, forms (incl. `utm`, `ref`), track,
webhooks, `/api/health` and the rate limits.

---

## 4. Corrections to the original plan

Four things the plan got wrong. They are all silent failures.

1. **Widening a CHECK is `drop constraint if exists` + `add constraint`** — not
   a `do $$ … exception when duplicate_object` block. That form swallows the
   failure and leaves the OLD constraint in place. The do-$$ form is only for
   adding a brand-new named constraint.
2. **Widening REPLACES a CHECK**, so the new list must repeat every value any
   earlier migration added. 0104 had already widened
   `assistant_approvals.kind`; writing 0115's list from 0103's would have
   revoked `campaign_launch` and `engine_start`. Always
   `grep -rn "<constraint_name>" supabase/migrations/` before widening.
3. **Public route prefixes are NOT matched in `src/proxy.ts`.** The list is
   `PUBLIC_PREFIXES` in `src/lib/supabase/middleware.ts` (some routes also need
   `MACHINE_PREFIXES` in the same file). `/p`, `/a`, `/audit` are already added.
4. **`src/lib/database.types.ts` is hand-authored**, not generated — its header
   says so. Never run `supabase gen types`; it would destroy ~600 lines of
   hand-written unions and every jsdoc. Tables are NOT alphabetical: a new one
   goes at the END of `Tables` under a `// 0NNN — summary` comment.

---

## 5. Conventions this wave established

**Single-owner cores. Do not reimplement any of these anywhere else.**

| Core | File |
| --- | --- |
| `sendAndLogEmail()` — every client/lead/project email | `src/lib/email-outbox.ts` |
| `createInboundLead()` — every inbound enquiry | `src/lib/lead-intake.ts` |
| `monthlyInflows()` / `forecastCash()` — every inflow array | `src/lib/finance-math.ts` |
| `enforceRateLimit()` — every public route and action | `src/lib/rate-limit.ts` |
| `listApprovalItems()` — the seven decision queues | `src/lib/approvals.ts` |
| `nextOccurrence()` / `catchUpOccurrence()` | `src/lib/todo-recurrence.ts` |
| `markdownToHtml()` — the ONLY escaper for stored text | `src/lib/markdown.ts` |
| `choosePortalChannel()` — the portal send ladder | `src/lib/portal-send-core.ts` |
| `publishReview()` + `careers/sync` — the ONLY website writers | `src/lib/reviews/publish.ts` |
| `settledAmount()` etc. — project money | `src/lib/projects.ts` (unchanged) |

Still to come, per the plan: `recordPayment()` (`payments.ts`),
`reconcileInvoice()` (`invoices.ts`), `notifyClient()` (`client-notify.ts`),
`next_document_number(kind)` (SQL).

**Other rules in force:**

- A new assistant card touches four files: `src/lib/assistant-cards.ts` (the
  union), `assistant-card.tsx` (render + a `ConfirmFooter`), `use-voice-chat.tsx`
  (`CONFIRM_CARD_TYPES` + the send callback + the voice-confirm branch), and
  `src/lib/assistant/missions.ts` (`isConfirmCard` + `parkApproval`). Anything
  that reaches a customer is a card → a `/api/assistant/send-*` route on a human
  tap. Missions must never import a sender.
- A new automation trigger or step touches three: the union in
  `database.types.ts`, `automation-meta.ts`, and the executor switch in
  `automation.ts`.
- A new tick pass is registered in `PASSES` (`api/automation/tick/route.ts`) and
  self-gates with a stamp in `app_settings`, claimed BEFORE the work.
- `"use server"` modules export only async functions. A plain const there breaks
  the Turbopack build — that is why `DEFAULT_NOTIFICATION_PREFS` lives in
  `src/lib/notification-prefs.ts`.
- Never `git add -A`. The repo carries a large uncommitted hand-tracking feature
  (`src/components/assistant/interactivity/*`, `studio-*`, `command/*`,
  `public/arcus/hand/*`, `arcus-preview/*`, `layout/sidebar.tsx`). Stage
  explicitly, every time.
- The two repos are separate remotes. Commit and push each on its own.

---

## 6. Known deferrals

- **Meta app review** for `instagram_content_publish` / `pages_manage_posts`
  takes weeks. `SOCIAL_DRY_RUN=1` runs the whole publish queue without calling
  Meta. The ZIP hand-off stays for LinkedIn/TikTok. Submit the review now if it
  should be live this quarter.
- **WhatsApp template approvals** are needed for slip confirmations, recurring
  reminders and content-approval links outside the 24h window. `notifyClient()`
  (step 35) always falls back to SMS then a task.
- **Resend open/click tracking** must be switched on for the sending domain
  before the outreach analytics show anything; the UI already says so rather
  than displaying a misleading zero.
- **`SOCIAL_TOKEN_KEY`** must be set before a social account can be connected.
- Out of scope this wave, deliberately: payment gateways (hook point only),
  mailbox/calendar provider sync, LinkedIn/TikTok publishing, start/stop timers,
  multi-tenancy, FX conversion.
