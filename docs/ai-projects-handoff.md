# AI Projects — handoff (third edition — 0126 and 0127 built, nothing committed)

**Read this first, then `docs/ai-projects.md` (architecture) and
`docs/ai-projects-client-kit.md` (the contract with a client's site).** Two
waves are built and pass the four-command gate: **0126** (the hosted agent)
and **0127** (the client backend link). **Nothing is committed, and neither
migration is applied.** Paste this into a new chat, or say:
*"Read `docs/ai-projects-handoff.md` — apply 0126, verify end to end, commit."*

## 1. What this is

A hosted, multi-tenant website chat agent run from the CRM. Each client gets
an **AI project** (`/ai-projects`): its own knowledge base (text, files, PDFs,
images, scheduled Firecrawl crawls), its own agent (name, prompt, OpenAI
model, avatar, colours), exact token metering priced from an editable model
catalog, per-project analytics, and a monthly invoice raised through the
existing invoice system. The client's site gets one `<script>` snippet; the
widget it loads is served by the CRM and talks to `/api/ai/*`.

Owner decisions (fixed): billing = monthly fee + usage × markup (+ minimum);
currency per project USD or LKR with a manual `fx_lkr_per_usd`; the agency's
own website is NOT migrated in this build; tools = lead capture, booking
hand-off, human hand-off; no voice.

## 1b. Verification pass, 2026-09-07 — two bugs found and fixed

Both migrations are now **applied** to the live database (all 15 tables, every
column including 0127's ALTERs, 18 price rows, `match_ai_chunks` and
`ai_usage_rollup_day` present). The whole module was then exercised against
the live API and database. Two real defects turned up; both are fixed and
re-verified end to end.

**1. Every chat turn failed on the default model.** `openai.ts` and
`openai-stream.ts` sent `reasoning_effort` alongside function tools, and from
**gpt-5.4 onward OpenAI refuses that combination** on `/v1/chat/completions`
("Function tools with reasoning_effort are not supported… set reasoning_effort
to 'none'"). Because the widget always advertises tools (lead capture, booking,
hand-off) and the schema default effort is `low`, **every visitor turn on
gpt-5.6-luna / -sol / -terra 400'd**. Omitting the parameter does not help on
5.6 — only the literal `none` works, while classic `gpt-5*` rejects `none`.
The rule now lives in one tested place, `src/lib/ai/reasoning-core.ts`
(`reasoningEffortFor`), with the measured matrix in its header comment.

**2. A request OpenAI rejected was billed to the client.** The "no usage
frame" path estimated prompt tokens from the message text and wrote them as a
`partial` row — right for a call that ran and was cut off, wrong for one the
API refused before generating anything. The daily rollup sums every billable
row regardless of status, so those phantom tokens reached the invoice. With
bug 1 live, a client on a 5.6 model would have been billed for a 100% failure
rate. `openaiChat*` now throws a typed `OpenAIRequestError` on any non-429
`!res.ok`, and `chat.ts` records that case at zero tokens and zero cost —
still visible on Analytics, absent from the bill. Confirmed live: a forced
404 wrote `input_tokens 0, output_tokens 0, cost_usd 0.000000`.

Verified working after the fixes: origin allow-list (wildcards, ports,
schemes, two subdomain-forgery attempts), per-session rate limit and its
isolation, the Colombo daily cap (and that a forged `preview: true` cannot
bypass it), request validation, knowledge ingest → retrieval → streamed
reply, `capture_lead` + `request_human` tool calls, the lead route and its
caps, the daily rollup, the monthly invoice in USD and LKR (including the
refusal when an LKR project has no FX rate), the read API's 401 + no-CORS
model, and the widget itself rendering and answering on a page.

## 2. Where things stand

| # | Step | Status | Commit |
| --- | --- | --- | --- |
| 0 | Handoff + architecture docs | done | — |
| 1 | Migration `0126_ai_projects.sql` + `database.types.ts` + `types.ts` + `STORAGE_BUCKETS` | done | — |
| 2 | `openaiEmbed`, usage callback on `openaiChatStream` / `openaiVisionJSON` | done | — |
| 3 | Pure cores + tests (`time`, `pricing`, `origin`, `kb`, `crawl`, `billing`, `chat`, `stream`) | done | — |
| 4 | Server libs `src/lib/ai-projects/{projects,usage,retrieval}.ts` | done | — |
| 5 | Nav + `/ai-projects` list | done | — |
| 6 | Detail shell + Overview | done | — |
| 7 | `/ai-projects/models` catalog page | done | — |
| 8 | Agent tab | done | — |
| 9 | Knowledge tab (text/file/url) + `aiIngest` pass | done | — |
| 10 | Public surface skeleton (`/api/ai/config`, registration, widget placeholder) | done | — |
| 11 | Chat pipeline + `/api/ai/chat` + `/api/ai/lead` | done | — |
| 12 | Widget `public/ai-widget.js` + Deploy tab + `/ai-preview/[id]` | done | — |
| 13 | Firecrawl crawl job + `aiCrawl` pass | done | — |
| 14 | Analytics tab + `aiRollup` pass | done | — |
| 15 | Conversations + Leads tabs | done | — |
| 16 | Billing (`createAiUsageInvoice`, `aiBilling` pass, Invoices tab) | done | — |
| 17 | Docs + four-command gate | done | — |

**The gate passes as of the last edit:** `npx tsc --noEmit` clean, `npx vitest
run` 337 tests across 26 files, `node scripts/lint-baseline.mjs` at baseline
(24 pre-existing errors, none new), `npm run build` succeeds with
`/ai-projects`, `/ai-projects/[id]`, `/ai-projects/models`, `/ai-preview/[id]`,
`/api/ai/chat`, `/api/ai/config` and `/api/ai/lead` all compiled.

## 3. Wave two — the client backend link (0127)

The owner's point: a lead sitting in this CRM is no use, because he will not
be working it and the client never signs in here. So each project can now be
wired to the client's own site, in both directions.

| # | Step | Status |
| --- | --- | --- |
| 1 | Migration `0127_ai_client_backend.sql` + types | done |
| 2 | `outbound-core` / `outbound` / `signature` — the SSRF guard and the signing scheme | done |
| 3 | `tool-core` — a tool definition to a JSON Schema, and the model's arguments back | done |
| 4 | `delivery-core` — the retry schedule | done |
| 5 | Custom tools: `custom-tools.ts`, the four `chat-core`/`tools.ts` seams, the Tools card | done |
| 6 | Lead delivery: the queue, the inline attempt, the `aiDeliver` pass | done |
| 7 | The read API — five routes under `/api/ai/v1/*` | done |
| 8 | The Supabase destination — anon key, one insert policy, service keys refused | done |
| 9 | The calendar — the client's own endpoint, or Cal.com | done |
| 10 | The Backend tab (six cards) and the client kit | done |
| 11 | Docs: the kit contract, `ai-projects.md`, `api.md` | done |

**What it does.** One origin per project, one shared secret, signed both ways.
The CRM posts a captured lead to the client's site (or inserts it into their
Supabase), the agent calls tools the agency defined against their API, and
their own server reads the leads back to render a dashboard on their site.
Six cards on the new **Backend** tab: connection, lead delivery, tools, their
Supabase, calendar, read API and kit.

**Security decisions worth not undoing:**

- `outbound.ts` is the only way this codebase calls a client server. https
  only, host resolved and every address checked against the private ranges,
  redirects never followed, 64 KB cap, never throws. Pinned by 25 tests.
- Four secrets encrypted at rest under `SOCIAL_TOKEN_KEY`. **It is still unset
  in production** — the Backend tab refuses to store anything and says so.
- The Supabase link takes the **anon** key and refuses a service-role key by
  inspecting the JWT's `role` claim. It only ever INSERTs, into one named
  table, under one RLS policy printed on the card.
- The read API sends **no CORS headers and answers no preflight**. That is the
  security model: the key belongs on a server.
- A write tool needs the visitor's spoken confirmation, carries an
  idempotency key, and is capped at three calls per conversation.
- Preview traffic never delivers, never emails, never books.

**Known gap:** the Cal.com calls are written against the v2 API
(`cal-api-version: 2024-09-04` for slots, `2024-08-13` for bookings) but have
not been run against a real Cal.com account. `calendar_api_base` is
overridable so a shape change can be corrected without a deploy. Verify with
step 3 of the checklist below before selling it to a client.

---

## 4. What to do next (in this order)

1. Apply **`0126_ai_projects.sql`** then **`0127_ai_client_backend.sql`** in
   the Supabase SQL editor, in that order. Check:
   `select count(*) from ai_model_prices` → 18 (17 models; gpt-5.6-sol has a
   promo row and a list row), and `ai_tools`, `ai_tool_calls`, `ai_deliveries`
   all exist.
1b. **Set `SOCIAL_TOKEN_KEY` on Netlify.** Both the social accounts feature
   and the whole Backend tab need it; without it no secret can be stored.
2. Confirm `NEXT_PUBLIC_APP_URL` on Netlify is the CRM's public origin.
3. Create a test project, paste some text, open Deploy → preview, chat.
   Check `ai_usage_events` rows exist with `billable = false` and a cost.
4. Add a real allowed origin, set the project Live, drop the snippet on a
   staging site, chat from there: rows with `billable = true`.
5. On the Invoices tab raise last month (it will say "nothing to bill" until
   a month has usage); check the draft on `/invoices` and its PDF.
6. For the backend link: on the Backend tab set a test site's origin,
   generate the secret, paste the kit's two endpoints into it, press **Send
   test**. Then define a read tool and ask the agent something only that
   endpoint knows. Then point the origin at `http://` and at a private
   address and confirm both are refused with a readable message.
7. Commit with explicit paths — **never `git add -A`**. The working tree also
   carries the older, deliberately-uncommitted hand-tracking feature; the
   lists below are the whole of this build and nothing else.

   New (all of it this build):

   ```
   supabase/migrations/0126_ai_projects.sql
   supabase/migrations/0127_ai_client_backend.sql
   src/lib/ai-projects/          public/ai-widget.js
   src/app/(app)/ai-projects/    src/app/ai-preview/    src/app/api/ai/
   src/lib/ai/reasoning-core.ts  src/lib/ai/reasoning-core.test.ts
   docs/ai-projects.md           docs/ai-projects-handoff.md
   docs/ai-projects-client-kit.md
   ```

   Modified (these twenty, and no others):

   ```
   src/lib/ai/openai.ts            src/lib/ai/openai-stream.ts
   src/lib/ai/firecrawl.ts         src/lib/ai/app-map.ts
   src/lib/invoices.ts             src/lib/types.ts
   src/lib/database.types.ts       src/lib/constants.ts
   src/lib/assistant-artifacts.ts  src/lib/supabase/middleware.ts
   src/proxy.ts                    next.config.ts
   vitest.config.mts               .env.example
   docs/api.md                     docs/ops.md
   src/components/layout/nav.ts
   src/components/assistant/preview/artifact-format.ts
   src/app/(app)/settings/settings-view.tsx
   src/app/(app)/web-analytics/panels.tsx
   src/app/api/automation/tick/route.ts
   ```

   **Do NOT stage** these, which were dirty before this build and belong to
   the hand-tracking feature: `src/components/assistant/interactivity/*`,
   `src/components/assistant/command/*`, `src/components/assistant/studio-*`,
   `src/components/layout/sidebar.tsx`, `src/app/globals.css`,
   `public/arcus/hand/*`, `src/app/public/arcus-preview/*`, `output/`.

### ⚠️ Before deploying

- Apply `supabase/migrations/0126_ai_projects.sql` by hand in the Supabase
  SQL editor (it enables the `vector` extension and seeds the model prices).
  The code degrades to empty screens without it.
- `NEXT_PUBLIC_APP_URL` must be the CRM's public origin — it is the host in
  the snippet and the origin the Deploy-tab preview is allowed from.
- Optional env: `OPENAI_EMBED_MODEL` (default `text-embedding-3-small`),
  `AI_CHAT_BUDGET_MS` (default 30000).

## 3. Rules in force (from the previous waves — still true)

- Never `git add -A`; stage explicit paths (the hand-tracking feature is
  uncommitted on purpose).
- New tables go at the END of `Tables` in `src/lib/database.types.ts`,
  BEFORE `Views:`.
- A new public/machine route goes in `PUBLIC_PREFIXES` + `MACHINE_PREFIXES`
  (`src/lib/supabase/middleware.ts`) AND the matcher in `src/proxy.ts`.
- A new tick pass is registered in `PASSES` and self-gates with an
  `app_settings` stamp claimed BEFORE the work.
- Only `src/lib/invoices.ts` writes invoice state.
- Gate before every commit:
  `find .next/types -name "* [0-9].ts" -delete && npx tsc --noEmit && npx vitest run && node scripts/lint-baseline.mjs && npm run build`

## 4. Single-owner cores this build adds

| Core | File |
| --- | --- |
| `priceFor()` / `costUsd()` — every token → dollars conversion | `src/lib/ai-projects/pricing-core.ts` |
| `recordUsage()` — every `ai_usage_events` row | `src/lib/ai-projects/usage.ts` |
| `composeSystemPrompt()` — the one prompt builder | `src/lib/ai-projects/chat-core.ts` |
| `runChatTurn()` — the one visitor turn | `src/lib/ai-projects/chat.ts` |
| `ingestSource()` — every chunk + embedding write | `src/lib/ai-projects/kb.ts` |
| `stepCrawlJob()` — the crawl state machine | `src/lib/ai-projects/crawl.ts` (+ `crawl-core.ts`) |
| `composeAiInvoice()` + `createAiUsageInvoice()` — the monthly bill | `src/lib/ai-projects/billing-core.ts` + `src/lib/invoices.ts` |
| `originAllowed()` — the only origin decision | `src/lib/ai-projects/origin-core.ts` |
