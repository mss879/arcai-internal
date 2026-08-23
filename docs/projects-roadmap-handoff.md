# Projects module — handoff for themes 5–8

**Read this first, then `AGENTS.md`.** It is the complete brief for continuing the Projects
roadmap in a fresh session. Written 2026-08-23, at commit `0d008fd`.

Paste this into a new chat, or just say: *"Read `docs/projects-roadmap-handoff.md` and build
theme 5."*

---

## 1. What this is

`arc-ai-management` is ARC AI's internal workspace (Next.js 16 + React 19 + Tailwind v4,
Supabase, Netlify). A 72-idea roadmap for the **Projects** module was written and grouped into
eight themes. **Themes 1–4 are built and live. Themes 5–8 are not started.**

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

8. **Don't call `Date.now()` / `new Date()` during render** — `react-hooks/purity` forbids it. Use
   `date-fns` (`startOfToday()`, `isBefore`, `differenceInCalendarDays`).

9. **Margin is admin-only**, matching commissions. `profiles.hourly_cost` is never shown to the
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

**Migrations `0090`–`0095`.** All applied to production **except `0095`**, which re-adds
`invoices.stamp` — apply it, or the DEPOSIT PAID stamp won't print.

| | |
|---|---|
| `0090` | archive (`projects.deleted_at`) |
| `0091` | money: budget cap, deposit gate, retainers, balance-chase, `payment_plans.project_id`, `invoices.project_id`, commission basis |
| `0092` | planning: templates, milestones, members, time entries, blocked, task dependencies, aftercare |
| `0093` | deposit confirmation + `invoices.share_token` + client SMS |
| `0094` | CX: portal passcode/expiry/revoke/language, reviews, approvals, change requests, comments, pulses |
| `0095` | re-applies `invoices.stamp` (0024, never run) |

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

**Known open item:** the Sinhala and Tamil portal copy in `src/lib/portal-copy.ts` is
machine-translated. It renders correctly but wants a native speaker's read.

---

## 6. What's left — themes 5 to 8 (27 items)

Each has a stable ID. The user refers to them by ID ("build AUTO-3").

### Theme 5 — AI (`AI-1` … `AI-9`)

The sales side is heavily AI-driven (research, drafting, coaching, lessons). Delivery has one AI
feature. These close that gap. Helpers already exist: `src/lib/ai/openai.ts`
(`openaiChat`, `openaiChatJSON`, `openaiVisionJSON`), and `src/lib/ai/receipt.ts` is a worked
example of the drafts-never-saves pattern.

- **AI-1 Project brief from the sale** — feed the accepted quote, the proposal and the WhatsApp
  thread in; get scope, deliverables, a task list, an asset checklist and a realistic timeline
  out. One click at project creation, editable before it's saved.
- **AI-2 Estimate from your own history** — "Business websites like this one took 24 days and cost
  LKR 41,000 in extras; you quoted 150,000 and kept 62%." Pricing grounded in actuals, improving
  every project.
- **AI-3 Scope-creep detector** — watch the client's messages against the agreed scope; when a
  request falls outside it, flag it and draft the "happy to do that — it's an extra LKR X" reply.
- **AI-4 Nightly risk radar** — a pass over every open project producing a ranked "these three
  need you today, and here's why". Feeds the existing weekly digest and morning WhatsApp digest.
- **AI-5 Screenshot to progress note** — drop a screenshot; get a client-friendly update and an
  internal note, both filed to the project.
- **AI-6 Post-mortem when a project closes** — where the time went, where the margin leaked, which
  stage dragged, what to quote differently. Stored as lessons, like the WA agent already does.
- **AI-7 Voice control for delivery** — the assistant can already list projects. Add: create a
  project, log an expense, record a payment, move a stage, add a task, "what's at risk this week".
- **AI-8 Ask your projects anything** — natural language over the project tables, answered with a
  table you can act on.
- **AI-9 Duplicate and anomaly guards** — the same expense twice, a payment on the wrong project,
  an automation creating a second project for one deposit. (`buildLedger()` already flags
  cross-table duplicates — extend that idea.)

### Theme 6 — AUTO (`AUTO-1` … `AUTO-7`)

The engine already understands projects: 0085 added four triggers and three steps. Extending it is
a CHECK-constraint update plus a `case` in the executor (`src/lib/automation.ts`), and metadata in
`src/lib/automation-meta.ts`. Recipes live in `src/lib/automation-recipes.ts`.

- **AUTO-1 Nine new triggers** — project created · due in X days · overdue · balance overdue ·
  expense added · expenses over budget · milestone completed · client approved · project
  completed. (Stalled is detected today but only alerts — make it a trigger.)
- **AUTO-2 Ten new steps** — create invoice (for real, not a session handoff) · send portal link ·
  seed task template · assign member · request an asset · add expense · set project status ·
  create payment plan · schedule a meeting · draft the client update.
- **AUTO-3 Recipe — deposit to kickoff** — project created, checklist seeded, tasks seeded, team
  assigned, WhatsApp onboarding started, portal link sent, kickoff call booked. Most pieces exist;
  bundle them.
- **AUTO-4 Recipe — assets complete to build** — stage moves, team notified, countdown starts,
  client told work has begun.
- **AUTO-5 Recipe — delivered to paid, reviewed, retained** — balance invoice, handover pack,
  review at day 3, aftercare offer at day 30, upsell at day 90.
- **AUTO-6 Recipe — stalled escalation** — day 5 nudge the client, day 8 notify the owner, day 12
  alert with the money at stake.
- **AUTO-7 Per-project automation view** — what's running, what fired, what's queued, and a pause
  switch. `automation_runs.project_id` already exists; it just isn't surfaced.

### Theme 7 — VIEW (`VIEW-1` … `VIEW-6`)

- **VIEW-1 Switchable views** — month board (today) · kanban by delivery stage · sortable table ·
  calendar by due date · timeline. Remembered per user.
- **VIEW-2 Saved filters** — "My active builds", "Unpaid deliveries", "Everything at risk", pinned
  to the board. The CRM's segments idea applied to projects.
- **VIEW-3 Cycle-time analytics** — average days per stage, on-time rate, trend. `delivery_events`
  has recorded every stage change since 0084, so the history already exists.
- **VIEW-4 Monthly close card** — booked, delivered, collected, still owed, carried forward,
  margin.
- **VIEW-5 Export** — CSV and a branded PDF report. (PDF stack: `src/lib/invoice-pdf.tsx` and
  friends.)
- **VIEW-6 Dashboard tiles that earn their place** — replace the active-project count with: at
  risk, awaiting client, delivering this week, cash outstanding.

### Theme 8 — BIG (`BIG-1` … `BIG-5`)

Longer and riskier; each changes what the product *is*. Confirm scope before starting one.

- **BIG-1 Client accounts instead of share links** — magic-link login; one client sees all their
  projects, invoices, quotes and files. The share token becomes a convenience, not the security
  model.
- **BIG-2 Link the whole chain in the database** — lead → quote → proposal → project → invoice →
  payment. The proposal and invoice on a project are currently uploaded *files*, so nothing is
  traceable end to end. Real foreign keys make the reporting above possible. **Probably the
  highest-value item left.**
- **BIG-3 Projects API** — the API key infrastructure exists and already serves leads.
- **BIG-4 Sell the delivery portal** — multi-workspace, per-tenant branding and billing. A fork in
  the road, not a feature.
- **BIG-5 Phone-first delivery** — the app is already installable; a phone-shaped project view for
  approve / log / photograph / nudge.

---

## 7. Suggested order

1. **`AUTO-1` + `AUTO-2`**, then the recipes. Cheapest work with the widest reach — everything
   else becomes automatable, and most of the actions already exist as functions.
2. **`VIEW-3` + `VIEW-6`**. Pure reads over data already recorded; no schema.
3. **`AI-4`, then `AI-1` and `AI-3`.** Risk radar is the one that changes behaviour daily;
   scope-creep detection is the one that earns money.
4. **`BIG-2`** before any more reporting — without the foreign keys, later analytics will be built
   on file uploads.

Leave `BIG-4` alone unless the business decision has actually been made.
