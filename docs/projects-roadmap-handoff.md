# Projects module — handoff for themes 5–8

**Read this first, then `AGENTS.md`.** It is the complete brief for continuing the Projects
roadmap in a fresh session. Written 2026-08-23, at commit `0d008fd`.

Paste this into a new chat, or just say: *"Read `docs/projects-roadmap-handoff.md` and build
theme 5."*

---

## 1. What this is

`arc-ai-management` is ARC AI's internal workspace (Next.js 16 + React 19 + Tailwind v4,
Supabase, Netlify). A 72-idea roadmap for the **Projects** module was written and grouped into
eight themes. **Themes 1–7 are built, and four of theme 8's five items with them. Only `BIG-4` (sell the
delivery portal as multi-tenant SaaS) is left, deliberately — it is a business decision, not an
engineering one.**

The full roadmap, with every item and its rationale, is a private artifact:
<https://claude.ai/code/artifact/17e528c4-ddfe-4d11-b71f-03e7ee53ab68>
(Everything needed to build 5–8 is inlined in §6 below, so the link is optional.)

---

## 2. Ground rules for this repo

- **This is not the Next.js you know.** Next 16. Read the relevant guide in
  `node_modules/next/dist/docs/` before writing code. Middleware is called **`proxy`**
  (`src/proxy.ts`); `cookies()` is **async**.
- **The user applies the SQL migrations themselves.** Never run them. Add a new numbered file in
  `supabase/migrations/` and keep `src/lib/database.types.ts` in sync by hand.
- **Verify with `npx tsc --noEmit` + `npm run build`.** Both must be clean.
- **Push to `main` = production deploy** (Netlify → `www.arcai.online`). Only push on explicit
  instruction. **Apply migrations to production BEFORE pushing** — the app reads the new columns
  immediately. All migrations here are additive, so they are always safe to run against the
  currently-live build first.
- Explain the plan before building anything large. Do not use the Workflow tool (credits).

### Verification quirks worth knowing

- `.next/types/` keeps sprouting duplicate `routes.d 2.ts` files on this machine (some sync tool).
  `find .next/types -name "* [0-9].ts" -delete` before `tsc --noEmit`, or it reports phantom errors.
- Lint baseline is **13 errors across `src`**, all pre-existing `no-explicit-any` /
  `react-hooks/purity` in files unrelated to this work. Do not add to it; do not "fix" them
  unasked.
- A **hydration error fires on every page, including untouched `/login`** — almost certainly a
  browser extension in the dev profile. Not a regression. Don't chase it.

---

## 3. Where the code lives

```
src/app/(app)/projects/
  page.tsx / projects-view.tsx      the month board (filters, sort, archive, health, margin)
  [id]/page.tsx                     the project — fetches everything, builds the view models
  [id]/project-tabs.tsx             Overview │ Plan │ Client │ Money │ Files │ History
  [id]/portal-section.tsx           portal access card + asset timeline (team side)
  actions.ts                        projects, payments, commissions, expenses, archive, stage
  plan-actions.ts                   members, milestones, time, templates, dependencies
  deposit-actions.ts                confirm deposit → stamped invoice → SMS
  portal-actions.ts                 passcode, expiry, revoke, send portal, ask for review
  cx-actions.ts                     change requests, approvals, team comments
  client-sms-actions.ts             free-text / milestone / stage texts to the client
  reports/ templates/               profitability + workload + timeline, and plan templates

src/components/projects/            all the cards (ledger, margin, plan, tasks, files, desk, …)
src/app/public/project/[token]/     the client portal (+ passcode gate)
src/app/public/invoice/[token]/     one invoice, public, nothing else
src/app/public/review/[token]/      the review form

src/lib/projects.ts                 THE money + health maths (client-safe)
src/lib/project-events.ts           the six project automation triggers, fired from one place
src/lib/project-templates.ts        plan-template seeding, shared by the button and the step
src/lib/project-costs.ts            THE cost merge — project_expenses + tagged Finance expenses
src/lib/project-history.ts          THE historical maths — medians, outcomes (feeds AI-1/2/6)
src/lib/recurring-income.ts         monthly hosting/retainer income generation (0100)
src/lib/project-anomalies.ts        rule-based duplicate/anomaly guards (AI-9)
src/lib/project-export.ts           CSV + the export row shape (VIEW-5)
src/lib/ai/project-brief.ts         AI-1   src/lib/ai/project-estimate.ts   AI-2
src/lib/ai/scope-creep.ts           AI-3   src/lib/ai/risk-radar.ts         AI-4
src/lib/ai/progress-note.ts         AI-5   src/lib/ai/project-postmortem.ts AI-6
src/lib/ai/project-query.ts         AI-8

src/app/(app)/projects/insights/    the AI layer's home (Ask · Risk · Estimates · Lessons · Guards)
src/app/(app)/projects/ai-actions.ts        theme 5 server actions
src/app/(app)/projects/view-actions.ts      saved board views (VIEW-2)
src/components/projects/board-views.tsx     kanban / table / calendar (VIEW-1)
src/components/projects/chain-card.tsx      lead→quote→proposal→project→invoice (BIG-2)

src/lib/client-auth.ts              client portal login: SMS code, hashed, rate-limited (BIG-1)
src/app/portal/                     the client's own account area (BIG-1)
src/app/api/public/v1/projects/     the projects API (BIG-3)
src/app/(app)/projects/go/          phone-first delivery (BIG-5)
src/lib/project-automation.ts       tick jobs: budget alerts, retainers, chases, aftercare
src/lib/project-sms.ts              the one way a client gets texted
src/lib/portal-access.ts            passcode gate, HMAC cookie, lockout
src/lib/portal-copy.ts              portal wording in en / si / ta
```

---

## 4. Non-negotiable invariants

These were each learned the hard way. Breaking one is a real bug, not a style choice.

1. **`deposit_paid` and a project's `payments` rows are THE SAME MONEY.** At the time of writing,
   9 of 10 projects had `deposit_paid` exactly equal to the sum of their payment rows. Adding them
   doubles every Received figure. `settledAmount()` reconciles with `max()`; only
   `company_payments` (the Payments board) adds on top. **Never compute project money anywhere but
   `src/lib/projects.ts`.**

2. **Assume any column from an older migration may be absent.** `invoices.stamp` (migration 0024)
   was never applied to the live database and went unnoticed for months, because the only writer
   sets it in a separate best-effort UPDATE. Selecting it inline 404'd every client invoice. Probe
   before you rely on an old column; follow `saveInvoice`'s pattern (separate best-effort
   read/write) for optional ones.

3. **A `"use server"` module may only export `async` functions.** A sync helper there breaks the
   Turbopack build. Put shared pure helpers in a client-safe lib.

4. **Functions cannot cross the server → client boundary.** `portalCopy()` returns an object
   containing functions, so pages pass the **language code** and the client component resolves the
   dictionary itself.

5. **Every public server action re-resolves its token AND re-checks the gate.** Server actions are
   public POST endpoints. See `openPortal()` in `src/app/public/project/[token]/actions.ts`.

6. **Public pages never `select("*")`.** Hand-pick columns and build an explicit client-safe view
   model — the project row carries internal budget, cost expenses and the share token.

7. **Never size a card with viewport breakpoints (`sm:`/`md:`) if it can sit in a narrow column.**
   Use Tailwind v4 `@container` + `@md:`. A `sm:grid-cols-3` inside a ~340px rail is what once
   clipped a date field to "23/08/2".

8. **A project's COSTS live in two ledgers, and both count.** `project_expenses` (raised on
   the project, usually billable extras) and `expenses` where `project_id` is set (0100 — the
   company ledger: hosting, ads, software). `projectMargin()` takes one list, so
   **`src/lib/project-costs.ts` is the only place they are merged** — seven surfaces show margin
   or spend, and each doing its own merge is how they drift. A Finance cost is always
   `billable: false`: the agency paid it and is not re-billing it. Anything headed for the
   client's invoice belongs in `project_expenses`, so the two can never double-count. The
   invoice generator and the anomaly guard deliberately read `project_expenses` ONLY.

9. **A `"use client"` module's exports become CLIENT REFERENCES when a Server Component
   imports them.** A plain helper exported from a client component and called on the server
   throws at runtime — and `tsc` and `next build` both pass. Type-only imports
   (`import { X, type Y }`) are erased and always safe; anything else callable must live in a
   server-safe module.

10. **Don't call `Date.now()` / `new Date()` during render** — `react-hooks/purity` forbids it. Use
   `date-fns` (`startOfToday()`, `isBefore`, `differenceInCalendarDays`).

11. **Margin is admin-only**, matching commissions. `profiles.hourly_cost` is never shown to the
   member it belongs to. And margin is **hidden entirely until costs exist** — with none recorded
   it always reads 100%, which is an empty cost sheet dressed as a result
   (`marginIsMeaningful()`).

### Small facts that cost time to rediscover

- `notifyEveryone` lives in `@/lib/wa-agent`, **not** `@/lib/delivery`.
- `ChurnSeverity` is `cooling | warm | cold`. `NotificationType` has no `"project"` — use
  `"assignment"`.
- `company_payments.status` is `pending | upcoming` — it means *when expected*, not *paid*.
  `is_paid` is the only settled flag.
- App-router folders starting with `_` are private and **won't route**.
- Delivery stage moves must go through `setProjectDeliveryStage()` in `src/lib/delivery.ts` — it
  fires the triggers and the client milestone message.
- One cron endpoint drives everything: `/api/automation/tick`.

---

## 5. What's already built (don't rebuild it)

**Migrations `0090`–`0100`.** `0095`–`0099` are applied; **`0100` is not yet.**
`0095` re-adds `invoices.stamp` — apply it, or the DEPOSIT PAID stamp won't print. `0096`
(theme 6), `0097` (theme 7) and `0098` (theme 5) **must all be applied before the next
push**: the tick filters on `projects.automation_paused` every run, the board reads
`project_views`, and the AI layer reads `project_lessons`, `project_anomalies` and four new
`projects` columns, and `0099` adds the chain foreign keys plus the client-login table. All five
are additive and safe to run against the currently-live build.

| | |
|---|---|
| `0090` | archive (`projects.deleted_at`) |
| `0091` | money: budget cap, deposit gate, retainers, balance-chase, `payment_plans.project_id`, `invoices.project_id`, commission basis |
| `0092` | planning: templates, milestones, members, time entries, blocked, task dependencies, aftercare |
| `0093` | deposit confirmation + `invoices.share_token` + client SMS |
| `0094` | CX: portal passcode/expiry/revoke/language, reviews, approvals, change requests, comments, pulses |
| `0095` | re-applies `invoices.stamp` (0024, never run) |
| `0096` | AUTO: 10 triggers + 10 steps on the CHECK constraints, `projects.automation_paused`, two scan indexes |
| `0097` | VIEW: `project_views` (saved board filters) |
| `0098` | AI: `project_lessons`, `project_anomalies`, `projects.risk_*` + `scope_checked_at`, `project_change_requests.ai_flagged` |
| `0099` | BIG: `projects.lead_id/quote_id/proposal_id`, `proposals.lead_id/client_id/quote_id/project_id`, `client_login_codes`, `clients.portal_last_login_at` |
| `0100` | Finance ↔ Projects: `expenses.project_id`, `recurring_income` + `recurring_income_entries` |

**Themes 1–4, all 45 items.** In short:

- **LOOP** — one definition of "received"; portal progress stepper; stage, tasks, activity and
  files on the project page; unified money ledger (with "Add payment" + receipt upload); board
  search/filter/sort; archive instead of delete.
- **MON** — real margin; budget burn; payment schedules; auto-invoice on delivery; deposit gate;
  retainers; commission accrual; receipt OCR; expense categories; profitability report;
  balance-chase ladder; cash-stuck tile.
- **PLAN** — templates; milestones; project members; workload; time logging; timeline; blocked
  state; health score; website-progress link; launch checklist; task dependencies; aftercare.
- **CX** — portal passcode + expiry + revoke with send-to-client; review requests; approvals with
  typed sign-off; change requests that bill; comments; satisfaction pulse; Sinhala/Tamil portal.

Plus **deposit confirmation**: one button raises a DEPOSIT PAID invoice and texts the client a
link to it on its own public page.

**Theme 6 (AUTO), all 7 items.** The automation engine now understands the whole project
lifecycle:

- **AUTO-1** — ten triggers: `project_created` · `project_due_soon` · `project_overdue` ·
  `balance_overdue` · `expense_added` · `expenses_over_budget` · `milestone_completed` ·
  `client_approved` · `project_completed` · `project_stalled`. The four timers scan in
  `scanTimeBasedTriggers`; the six events fire through **`src/lib/project-events.ts`**, the one
  place a project is resolved into a trigger (client, portal link, pause check).
- **AUTO-2** — ten steps: raise project invoice · send portal link · apply plan template · assign
  teammate · request an asset · add expense · set project status · create payment plan · schedule
  meeting · draft client update (AI, files an internal note and never messages the client).
- **AUTO-3…6** — four recipes: `project-deposit-kickoff`, `project-assets-to-build`,
  `project-delivered-to-retained`, `project-stalled-escalation`. All opt-in, all in the Delivery
  hub's Automations tab.
- **AUTO-7** — an **Automations** card on the project's History tab: what's queued, what's
  running, what fired (expandable step log), and a per-project pause switch.

Two things worth knowing before building on it:

1. **`renderTokens` leaves an unknown `{{token}}` standing in the text.** A step whose output is
   optional must therefore write its tokens on BOTH paths — see `create_project_invoice`, which
   sets a whole-clause `{{invoice_line}}` (blank when there was nothing to bill) rather than a
   bare `{{invoice_number}}` that would go out to the client verbatim. `{{money_line}}` on
   `project_stalled` does the same.
2. **`project_created` is deliberately NOT fired by the `create_project` step** — only by
   `saveProject`, the assistant and the retainer generator. A flow that both listens for it and
   creates a project would otherwise hatch a new one every tick, forever.

Template seeding moved to **`src/lib/project-templates.ts`** so the Apply-template button and the
`seed_task_template` step produce an identical project; `applyTemplate` in `plan-actions.ts` is
now a thin auth + revalidate wrapper.

**Theme 7 (VIEW), all 6 items.**

- **VIEW-1** — four board layouts (month · kanban by stage · table · calendar by due date),
  remembered per user in `localStorage`. The **timeline links to `/projects/reports?tab=timeline`**
  rather than being drawn twice — PLAN-6 already draws it.
- **VIEW-2** — saved filter sets (`project_views`), shared by default, private optional. The
  active view is **derived** from the live filters, not tracked in state, so nudging a dropdown
  deselects the pill on its own.
- **VIEW-3** — a Cycle-time tab on Reports over `delivery_events`: days per stage (median AND
  mean, because one holiday skews the mean), on-time rate, and a six-month trend.
- **VIEW-4** — a close strip on **every** month group: booked, delivered, collected, owed,
  carried forward, margin.
- **VIEW-5** — CSV (client-side, formula-injection guarded, BOM for Excel) and a branded
  landscape PDF via `/api/projects/pdf`. Margin is re-checked server-side, never trusted from
  the body.
- **VIEW-6** — the dashboard's active-project count is gone; a Delivery row replaces it with at
  risk · awaiting client · delivering this week · cash outstanding.

**Theme 5 (AI), all 9 items.** New home: **`/projects/insights`** (Ask · At risk · Estimates ·
Lessons · Guards), plus an **AI tools** card on each project's History tab.

- **AI-1** — Draft brief from the sale: reads the quote, the proposal and the WhatsApp thread,
  pre-fills the new-project form (never overwrites something already typed) and lists what the
  sale left unsettled.
- **AI-2** — `src/lib/project-history.ts` computes real medians per service type; the model only
  turns them into a sentence, so an estimate can be wrong about advice but never about arithmetic.
- **AI-3** — the scope-creep reader files out-of-scope asks as ordinary change requests with
  `ai_flagged = true`, so CX-3's pricing flow bills them unchanged.
- **AI-4** — the nightly risk radar. **The ranking is arithmetic and works with no API key**;
  the model only writes the one-sentence reason. Rewritten wholesale each pass, so a recovered
  project stops being listed.
- **AI-5** — screenshot → a client update and an internal note, both editable, filed as project
  comments. Never sends.
- **AI-6** — post-mortems into `project_lessons`, approve-first. **Only `status = 'kept'` is ever
  quoted back into an estimate.**
- **AI-7** — seven new assistant tools: create project · record payment · log expense · move
  stage · add task · projects at risk · ask projects. `move_project_stage` goes through the
  server action, so voice cannot bypass the deposit gate a click obeys.
- **AI-8** — Ask your projects. **The model never writes SQL**: every project is flattened
  through the same money helpers and handed over as facts, and any id it invents is dropped
  before rendering.
- **AI-9** — rule-based guards (duplicate expense, double-counted payment, overpayment,
  duplicate project). Fingerprinted and unique, so a dismissal sticks.

Two things worth knowing before extending the AI layer:

1. **Everything drafts; nothing sends, bills or closes.** That is the receipt.ts contract from
   MON-8 and the whole theme keeps it.
2. **The tick's AI passes self-gate** (risk radar ~once a day, scope reader ≤2 projects/tick and
   once a day each). A tick runs every minute — anything that calls a model must gate itself or
   it becomes an API bill.

**Theme 8 (BIG), four of five.** `BIG-4` is untouched on purpose — see §6.

- **BIG-2 — the chain is real.** `projects.lead_id / quote_id / proposal_id` and
  `proposals.lead_id / client_id / quote_id / project_id`. A **Chain card** on the project's
  History tab walks lead → quote → proposal → project → invoices and shows quoted-vs-now-worth.
  The `create_project` automation step and the projects API both record the links, because an
  automated project is exactly the one nobody will ever link by hand. **The migration backfills
  only proposals→clients, and only on an exact single-match name** — a fuzzy match would file one
  client's proposal against another's, which is worse than no link.
- **BIG-1 — client accounts.** `/portal/login` takes a phone number and texts a 6-digit code;
  `/portal` then shows that client every project, invoice and quote they own. Codes are stored
  **hashed** with the service-role key, expire in 10 minutes, are consumed on use, count wrong
  guesses, and are rate-limited per number. **An unknown number gets the identical "we sent a
  code" screen and no SMS** — otherwise the form enumerates the client list. The share token
  stays as the convenience it always was. `/portal` is in `PUBLIC_PREFIXES` because clients are
  not Supabase users; they hold their own signed cookie (`src/lib/client-auth.ts`).
- **BIG-3 — the projects API.** `GET/POST /api/public/v1/projects`, same key infrastructure as
  leads. Deliberately never exposes cost data or `share_token`, and serialises through an
  allow-list so a column added later cannot leak by accident.
- **BIG-5 — phone-first delivery.** `/projects/go`: open projects worst-first, four thumb-sized
  verbs each (advance the stage, log time, photograph, nudge the client). Every one goes through
  the same server action the desktop uses, so the deposit gate still applies. Linked from the
  board on small screens only.

One trap worth writing down, because a type check will not catch it:

- **A `"use client"` module's exports become client references when a Server Component imports
  them.** A plain helper exported from a client component and called on the server throws at
  runtime. `chainDate()` was written that way and had to be moved into the page. Type-only
  imports (`import { X, type Y }`) are erased and are always safe.

**Known open item:** the Sinhala and Tamil portal copy in `src/lib/portal-copy.ts` is
machine-translated. It renders correctly but wants a native speaker's read.

---

## 6. What's left — `BIG-4`, and only `BIG-4`

### `BIG-4` — sell the delivery portal

The client portal plus the WhatsApp asset collector is a product other agencies would pay for.
Turning it into one means multi-workspace, per-tenant branding and per-tenant billing.

**This is not a feature and should not be picked up as one.** Every table in this schema is
single-tenant: there is no `workspace_id` anywhere, `delivery_settings` is a literal singleton
(`id = 1`), `INVOICE_BANK` and `PROPOSAL_COMPANY` are hard-coded ARC AI constants, and the
WhatsApp integration is one Meta app with one phone number. Retrofitting tenancy touches
essentially every query in the codebase and every automation that runs on a timer.

If the business decision is ever made, the honest first step is a spike answering three
questions — how a tenant's WhatsApp number is provisioned, what happens to the existing single
workspace's data, and who pays for the OpenAI usage — not a migration.

---

## 7. Where to go next

The roadmap is done bar `BIG-4`. What is worth doing now is not more features:

1. **Apply `0095`–`0099` and push.** Themes 5–8 are inert until the migrations land.
2. **Watch the tick.** Three new passes run on it (anomaly guards every minute, risk radar and
   scope reader once a day). Check `/api/automation/tick`'s JSON for `anomalies`, `riskRadar` and
   `scopeCreep` counts, and check the OpenAI spend after the first full day.
3. **Sit with the AI output before trusting it.** The lessons queue and the scope-creep flags are
   approve-first precisely so they can be judged for a few weeks before anyone leans on them.
4. **The Sinhala and Tamil portal copy in `src/lib/portal-copy.ts` is still machine-translated**
   and still wants a native speaker's read. It has outlasted four themes.
