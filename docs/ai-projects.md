# AI Projects

A hosted, multi-tenant website chat agent, run from the CRM (migration
**0126**). Each client gets a project: its own knowledge base, its own agent,
exact token metering, per-project analytics and a monthly invoice. The
client's site carries one `<script>` line; nothing of the agent — prompt,
retrieval, tools — ever lives in their repo.

The agency's own website (arcai.agency) keeps its separate chat backend in
the website repo. Migrating it onto this system is a later, small job:
create a project, load the knowledge base, swap the widget.

---

## How it is built

```
client site  ──<script src=CRM/ai-widget.js data-project=pk_…>──►  public/ai-widget.js (static, CDN)
   widget (Shadow DOM, vanilla JS)
     GET  CRM/api/ai/config?p=pk_…        → branding, welcome, chips, toggles
     POST CRM/api/ai/chat?p=pk_…  (SSE)   → origin gate → limits → retrieve → stream → tools → persist usage
     POST CRM/api/ai/lead?p=pk_…          → fallback lead form when the model is unavailable

CRM /ai-projects (admin)   Overview · Knowledge · Agent · Deploy · Analytics · Invoices · Conversations · Leads
CRM /ai-projects/models    the price catalog (USD per 1M tokens, effective-dated)
tick passes                aiIngest · aiCrawl · aiRollup · aiBilling
```

| Piece | Where |
| --- | --- |
| Tables, RPCs, bucket, seed prices | `supabase/migrations/0126_ai_projects.sql` |
| Pure decisions, all unit-tested | `src/lib/ai-projects/*-core.ts` (pricing, billing, origin, time, kb, crawl, chat, stream) |
| Server libraries | `src/lib/ai-projects/{projects,usage,retrieval,kb,extract,crawl,chat,tools,rollup,billing,cors}.ts` |
| The monthly invoice | `createAiUsageInvoice()` in `src/lib/invoices.ts` (the invoice owner) |
| Public routes | `src/app/api/ai/{config,chat,lead}/route.ts`; the widget is `public/ai-widget.js` |
| CRM pages | `src/app/(app)/ai-projects/**`, preview at `src/app/ai-preview/[id]` |
| OpenAI helpers gained | `openaiEmbed()`, `readUsage()`, `onUsage` on the stream and vision calls (`src/lib/ai/openai*.ts`) |
| Firecrawl helpers gained | `firecrawlCrawlStart()` / `firecrawlCrawlStatus()` (`src/lib/ai/firecrawl.ts`) |

### The tables

- `ai_model_prices` — what each model costs, USD per million tokens, with
  `effective_from`/`effective_to`. Seeded from OpenAI's price page on
  2026-09-07. A price change is a **new dated row**; the previous open row is
  closed the day before. Every usage row records the unit prices it was
  costed with, so an edit never rewrites history.
- `ai_projects` — one per client: status, the public key, the origin
  allow-list, the agent (name, prompt, model, temperature / reasoning
  effort, welcome, chips, avatar, colours, position), the three abilities,
  the limits, the crawl schedule, the billing terms.
- `ai_kb_sources` + `ai_kb_chunks` — the knowledge base and its pgvector
  embeddings (`text-embedding-3-small`, 1536 dims, HNSW). A source keeps its
  extracted text and a content hash; `match_ai_chunks()` retrieves per project.
- `ai_crawl_jobs` — one row per Firecrawl run; the row is the lease.
- `ai_conversations` + `ai_messages` — transcripts, tool calls included.
- `ai_usage_events` — **the ledger**: one row per model call (chat,
  embedding, vision) with tokens, unit prices, `cost_usd`, `billable`, and
  the Colombo `day` and `period` it belongs to.
- `ai_project_daily` + `ai_model_daily` — rollups recomputed whole by
  `ai_usage_rollup_day()` after every turn and by the `aiRollup` pass.
- `ai_leads` — what the agent captured for the client.
- `ai_invoices` — one link row per project + month, with the snapshot of the
  terms; the invoice itself is a normal `invoices` row.

### A visitor's turn

1. The widget POSTs `{session, visitor, message, page, preview}` with the
   project key in `?p=`.
2. `gateRequest()` (`cors.ts`) finds the project and checks the browser's
   `Origin` against the allow-list — the CRM's own origin is always allowed,
   which is how the Deploy-tab preview works. Only a matching origin is ever
   echoed in `Access-Control-Allow-Origin`.
3. Limits, before any token is spent: 30/min per IP, the project's
   per-visitor per-minute limit, 600/hour per project, and the project's
   **daily message cap** (the cost circuit breaker).
4. `runChatTurn()` (`chat.ts`): upsert the conversation, write the user
   message, embed the question (metered as `retrieval`), fetch the nearest
   ready chunks, compose the system prompt (static parts first so OpenAI's
   prompt caching applies), stream the reply with tools, run any tool,
   stream the follow-up, write the assistant message and one usage row per
   model call, roll the day up.
5. Usage is never lost: token counts arrive through `onUsage`; a call our
   own timeout cuts short is written as `partial` with an estimate. The
   model call is not tied to the request's abort signal — closing the tab
   stops the frames, not the metering.

### Money

`total = fee + (Σ cost_usd × markup)[→ LKR at the project's rate] , topped up
to the minimum on months the agent was live`. Composed by `composeAiInvoice()`
(`billing-core.ts`, tested). The client's invoice line says conversations and
tokens — never the provider cost or the markup; the per-model USD breakdown
sits on the `ai_invoices` row for the agency.

The `aiBilling` pass runs every morning from 06:00 Colombo and raises last
month for every billable project without one. `draft` mode leaves the
invoice `issued` and unsent (review it on the Invoices page); `auto_send`
emails it through `sendAndLogEmail()`. Preview traffic is metered with
`billable = false` and never billed.

---

## The client backend link (0127)

Leads that only reach the agency's CRM have not really been captured — the
person who wants them never signs into it. And an agent that can only talk is
a fancy FAQ. So each project can be wired to the client's own site:

| Piece | What it does |
| --- | --- |
| `outbound.ts` + `outbound-core.ts` | The only way this codebase calls a client's server: https only, the host resolved and every address checked against private ranges, redirects never followed, 64 KB cap, never throws. |
| `signature.ts` | `X-Arc-Timestamp` + `X-Arc-Signature` on everything, verified with a ±5-minute window. The same scheme is printed into the client kit. |
| `custom-tools.ts` + `tool-core.ts` | Tools the agency defines per project. The model's arguments are validated against the agency's own field list before anything is sent. |
| `calendar.ts` | Two synthetic tools — `check_availability`, `book_appointment` — served either by the client's own endpoint or by Cal.com. |
| `delivery.ts` + `delivery-core.ts` | The lead queue: one row per destination, tried inline after the reply, retried over ~9 hours, given up on visibly. |
| `supabase-destination.ts` | Inserting a lead straight into the client's own Supabase, with their **anon** key and one RLS insert policy. |
| `read-api.ts` + `src/app/api/ai/v1/*` | Their server reading their leads back, to render their own dashboard. No CORS, by design. |
| `kit.ts` | The five (or six) files the agency pastes into the client's repo. |

Everything is on one tab: **Backend**, on the project page. The contract is
`docs/ai-projects-client-kit.md`.

**Security, in one place:**

- Every outbound URL is SSRF-guarded, admin-entered, and never followed
  through a redirect.
- Secrets (`backend_secret_enc`, `read_key_enc`, `supabase_anon_key_enc`,
  `calendar_api_key_enc`) are AES-256-GCM at rest under `SOCIAL_TOKEN_KEY`,
  revealed only to an admin who clicks, never logged.
- The Supabase link refuses a service-role key outright — it inspects the
  JWT's `role` claim — and only ever INSERTs into one named table.
- The read API sends no CORS headers and answers no preflight, so its key
  cannot be used from a browser.
- A write tool needs the visitor's confirmation, carries an idempotency key,
  and is capped at three calls per conversation.
- Preview traffic never delivers a lead, never emails, and never books.

## Setting it up

1. Apply `supabase/migrations/0126_ai_projects.sql` in the Supabase SQL
   editor. It enables the `vector` extension, creates everything, seeds the
   price catalog and the private `ai-knowledge` bucket.
2. Env: `OPENAI_API_KEY` and `FIRECRAWL_API_KEY` (already set), and
   `NEXT_PUBLIC_APP_URL` must be the CRM's public origin — it is the host in
   the snippet and the origin the preview is allowed from. Optional:
   `OPENAI_EMBED_MODEL` (default `text-embedding-3-small`; a model with a
   different width needs a new column, not just a new name),
   `AI_CHAT_BUDGET_MS` (default 30000).
3. Nothing to schedule: the four passes ride the existing five-minute tick.

## Onboarding a client

1. **AI Projects → New project**: name, client, website. It starts as a draft.
2. **Knowledge**: paste their key facts, upload the price list PDF, add
   pages, or set a weekly/fortnightly crawl and press *Crawl now*. Use *Test
   what the agent finds* until the right passages come back.
3. **Agent**: name, avatar, welcome, chips, model (prices shown), the
   instructions, colours, abilities and the notification email that receives
   leads and hand-offs.
4. **Deploy**: add the client's domain to allowed origins; try the preview.
5. **Invoices**: currency, fee, markup, minimum, draft vs auto-send.
6. **Overview → Live**. Give the client the snippet from the Deploy tab.

## When something looks wrong

- *The widget does not appear on the client's site* — the config call
  answered `enabled: false` (project not live), or the origin is not on the
  allow-list (403 in the browser's network tab), or the site's CSP blocks the
  CRM host. The Deploy tab lists what the CSP must allow.
- *Replies say "I don't have that information"* — nothing retrieved. Check
  the Knowledge tab's source statuses and *Test what the agent finds*.
- *A source is stuck in Indexing* — the `aiIngest` pass frees anything
  stuck for ten minutes and carries on from where it stopped.
- *Usage recorded at $0* — the model is missing from the price catalog for
  that day; `error_events` has one row per missing model. Add the price; the
  next call prices correctly (past rows stay at $0 by design — fix them by
  hand if they matter).
- *An LKR invoice failed* — the project has no rate. Set it on the Invoices
  tab; the pass retries the next morning, or raise the month by hand.
- Days and months here are **Asia/Colombo**; Web Analytics uses UTC days.
