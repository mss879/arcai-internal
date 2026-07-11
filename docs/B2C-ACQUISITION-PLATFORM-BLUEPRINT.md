# Demand Engine — B2C Customer Acquisition Platform (Blueprint)

> Working name: **Demand Engine** (rename freely). Standalone multi-tenant SaaS, sold to B2C
> businesses (local services + e-commerce). Built on the proven ARC architecture, powered by
> Firecrawl. This doc is the build spec — hand it to Claude Code and start at Phase 1.

---

## 1. The core idea (why this isn't ARC with a new skin)

ARC's B2B system works because **the prospect is a business**: publicly listed (Google Places),
has a website you can scrape, score, and pitch. B2C breaks that model — you cannot crawl a list
of consumers, and privacy law (GDPR/CCPA) prohibits profiling individuals.

So the product flips the question:

| | ARC (B2B) | Demand Engine (B2C) |
|---|---|---|
| Unit you crawl | The prospect's website | The **demand around the client** |
| Question | "Which businesses need my service?" | "Where are my client's customers right now, what do they want, and what's the fastest way to show up there?" |
| Output | Lead list + cold outreach | **Signals** → ready-to-run acquisition actions (replies, pages, campaigns, partnerships, offers) |

The atomic unit of the whole platform is a **Signal**: one crawled piece of evidence of demand
(an intent post, a competitor complaint cluster, a keyword gap, a channel, a competitor price
change), scored and paired with a drafted action. Everything below produces Signals; the product
UI is a prioritized Signal feed per client.

---

## 2. Product shape

- **Multi-tenant SaaS.** `workspaces` (your paying customers) → each workspace has one or more
  `businesses` (the B2C brand being grown). Agencies can hold many businesses in one workspace —
  that's your white-label channel.
- **Configurable per business type.** Onboarding sets `business.kind` (`local_service` |
  `ecommerce` | `hybrid`) and toggles which engines run. Local: Intent Radar + Review Miner +
  Channel Scout + citations. E-commerce: Demand Capture + Review Miner + Market Watch weigh
  heavier. Same schema, different source packs.
- **The product loop:** engines run continuously in the background → Signal feed updates daily →
  each Signal ships with a drafted action in the client's brand voice → user approves/edits/
  dismisses → weekly white-label digest report (PDF + email) proves value and drives retention.

---

## 3. The six engines

Every engine is a lease-fenced state machine (ARC pattern, reused verbatim) that ends by writing
rows into the shared `signals` table.

### Engine 0 — Brand Brain (onboarding, runs once + on demand)

Everything else depends on knowing the client. On business creation:

1. Firecrawl `/scrape` the client's own site with `branding` + `rawHtml` formats → logo, colors,
   fonts, tone, products/services, service area (ARC already does this — port `ai/firecrawl.ts`).
2. `/map` their site → offer/product inventory.
3. `/search` their brand name (web + news) + scrape their Google/Yelp/Trustpilot reviews → what
   customers already praise/complain about, in customers' own words.
4. OpenAI synthesis → `business.profile` jsonb: voice, offers, differentiators, target customer,
   geo, competitor seed list (user can edit all of it).

This profile is injected into **every** downstream drafting prompt, so replies/pages/campaigns
sound like the client, not like AI.

- **Firecrawl:** `/scrape` (branding, rawHtml), `/map`, `/search`.
- **State machine:** `pending → scraping → reviews → synthesizing → done`.

### Engine 1 — Intent Radar (the flagship; direct analog of ARC prospecting)

Continuously finds **public posts where a consumer is actively asking to buy** what the client
sells: "anyone know a good emergency plumber in Leeds?", "best budget standing desk?",
"recommendations for wedding photographer Colombo?".

1. **Query fan-out.** From the business profile, generate a query pack: {service/product synonyms}
   × {intent phrases: "recommend", "looking for", "anyone know", "best", "vs", "worth it"} ×
   {geo terms for local}. Store in `source_queries`, user-editable.
2. **Scan.** Firecrawl `/search` per query with `tbs` time filter (past day/week) and
   `location`/`country` bias — exactly how ARC does no-website verification, but hunting
   `site:reddit.com`, Quora, niche forums (weddings, home improvement, parenting…), public
   Facebook group pages, X posts surfaced in search. `sources:[web,news]`.
3. **Qualify.** Dedupe by URL hash (the `place_id` trick). Cheap pass with `withoutContent` first;
   scrape survivors. LLM classifier scores each post: intent strength (browsing→ready-to-buy),
   recency, geo match, answerability, thread liveness → `signal.score` 0–100 with reasons
   (mirror `quickSiteVerdict`'s "issues[]" pattern → here it's "why this is hot").
4. **Draft.** For each qualified post: a **public, helpful, disclosure-friendly reply** in brand
   voice + optional variant. Never scraped emails/DMs — engagement happens on-platform by the
   human (compliance section, §7).

- **Firecrawl:** `/search` (heavy), `/scrape`.
- **State machine:** `pending → searching → qualifying → drafting → done`, batches of 4 —
  `prospect_scans` shape minus the `importing` step (output is `signals`, not `leads`).
- **Cadence:** rolling — scheduler re-enqueues per business every N hours (tier-dependent).

### Engine 2 — Review Miner (competitor win-back)

Unhappy customers of competitors are the cheapest customers to win.

1. From the competitor list (Brand Brain seeds it; user curates), locate review surfaces:
   Google Maps, Yelp, Trustpilot, app stores, Amazon listings (e-com).
2. Firecrawl `/scrape` (or `/agent` for stubborn, paginated review UIs — see §4) → raw reviews.
3. LLM clustering → complaint themes with frequency, severity, verbatim quotes ("waited 3 weeks
   for delivery", "rude front desk").
4. Signals produced: **campaign angles** ("competitor X's customers hate Y — lead with Y
   guarantee"), **comparison landing page briefs** ("Us vs X") with draft copy, and **ad hooks**.

- **Firecrawl:** `/scrape`, `/search` (finding review pages), `/agent` fallback.
- **State machine:** `pending → locating → scraping → clustering → drafting → done`.
- **Cadence:** weekly per competitor; incremental (only reviews newer than last scan).

### Engine 3 — Demand Capture (SEO / content gap)

Owns the "customers who search" channel.

1. From profile, build buyer-query list ("emergency plumber leeds price", "best ergonomic chair
   under $300").
2. Firecrawl `/search` each → who ranks, what content shape wins (listicle/guide/product page).
3. `/map` + selective `/crawl` of top competitors → their content inventory vs the client's own
   `/map` → the **gap list**.
4. Signals: content briefs (target query, angle, outline, draft) ranked by intent value ×
   difficulty proxy. For `local_service`: **citation/presence audit** — search the business across
   directories, flag missing/inconsistent listings (port ARC's audit scorecard style; PageSpeed
   client optional here for their own site's health).

- **Firecrawl:** `/search`, `/map`, `/crawl` (bounded, top-2 competitors), `/scrape`.
- **Cadence:** monthly full, weekly delta.

### Engine 4 — Channel Scout (where the audience already gathers)

The B2C twist that **reuses your B2B machinery wholesale**: influencers, community groups, local
bloggers, event calendars, complementary businesses (gym ↔ physio, bridal shop ↔ photographer)
are *businesses/entities with websites* — crawlable, scoreable, pitchable.

1. `/search` fan-out: "{city} {niche} blog", "{niche} instagram influencers {city}", community
   calendars, "{complementary category} near {city}" via Places (port `ai/places.ts`).
2. Qualify: scrape each candidate — audience relevance, activity/freshness (copyright-year trick),
   contact path, follower proxies.
3. Signals: ranked channel/partner list, each with a drafted collab pitch (cross-promo, guest
   post, sponsorship, referral swap) — this is literally ARC's qualify→draft→import loop pointed
   at partners instead of prospects.

- **Firecrawl:** `/search`, `/scrape`, `/map`; Google Places for complementary locals.
- **Cadence:** monthly refresh + on-demand.

### Engine 5 — Market Watch (monitoring & offers)

The retention engine — reasons to open the app every week.

1. **Watch targets:** competitor pricing/offer/menu pages, their promo pages, key SERPs.
   Firecrawl `/scrape` with **`changeTracking` format** → structured diffs with timestamps
   ("Competitor X dropped delivery fee", "launched 20%-off bundle").
2. **Ad intel:** scrape public ad libraries (Meta Ad Library) per competitor → creative/offer
   patterns.
3. **Seasonal/news:** `/search` `sources:[news]` + local event calendars → demand spikes
   ("heatwave next week" → AC-repair client should push emergency slots).
4. Signals: alerts with a recommended counter-offer + drafted promo copy/SMS/email.

- **Firecrawl:** `/scrape` + changeTracking, `/search` (news), `/agent` for ad libraries.
- **State machine:** simple per-target `watch → diff → draft` on schedule.
- **Cadence:** daily (tier-dependent).

---

## 4. Firecrawl usage strategy (2026 API)

ARC uses `/scrape`, `/map`, `/search` (v2 REST, plain fetch). Keep that client and extend it:

| Endpoint | Use | Notes |
|---|---|---|
| `/search` | Intent Radar, Demand Capture, Channel Scout, news | The workhorse. One call = results **with** full-page markdown. `tbs` recency, `location` geo-bias, `withoutContent` for cheap first passes (ARC pattern). |
| `/scrape` | Everything | Formats: `markdown`, `rawHtml` (SEO parsing), `branding` (Brand Brain), `changeTracking` (Market Watch diffs), `deterministicJson`/`json` for structured pulls (reviews → {author, rating, date, text}) without a second LLM hop. |
| `/map` | Site inventories | Client + competitor content lists, cheap. |
| `/crawl` | Demand Capture only | Bounded (depth/page caps) on top competitors. Most expensive — never unbounded. |
| `/agent` (Spark 1) | Hard, multi-step gathering | "Collect all reviews of X across Google/Yelp/Trustpilot", paginated review UIs, ad libraries, "find pricing for every {niche} in {city}". Spark 1 Mini default (60% cheaper), Pro for weekly deep jobs, webhooks → your tick endpoint. Use as **fallback/deep mode**, not the default — deterministic chains are cheaper and predictable. |

**Cost control (this is a product now, margins matter):**
- Cache scrapes by URL hash with per-engine TTLs; dedupe across tenants (two pizza clients in the
  same city share competitor scrapes).
- Meter Firecrawl credits per workspace (`usage_events` table) → enforce tier quotas → your
  pricing maps to your Firecrawl bill.
- Keep ARC's never-throw client contract: every call degrades to `[]`/`null`; a failed source
  never kills a scan.

---

## 5. Architecture (port ARC, add tenancy)

Stack: **Next.js + Supabase + Resend + Netlify** — identical to ARC. New repo.

**Reuse verbatim (proven in production):**
- The **lease-fenced state machine**: DB row = queue, compare-and-swap claim on
  `status + locked_at` with 45s lease, every commit fenced on the exact lock token. One shared
  `advanceScan()` helper this time (ARC repeats the pattern 3×; extract it once).
- **`/api/automation/tick`** cron advancing all machines one step/minute + inline drain after
  launch + page-open driver.
- **OpenAI background jobs** (`background:true`, poll on later ticks, 22-min ceiling) for slow
  synthesis (Brand Brain, review clustering).
- **`ai/` leaf clients**: one file per service, `server-only`, plain fetch, `isXConfigured()`
  guards, `AbortSignal.timeout`, env-overridable models. Port `firecrawl.ts`, `openai.ts`,
  `places.ts`, `site-probe.ts` nearly as-is; add `adlibrary.ts`, extend firecrawl with
  `agent()`, `crawl()`, `changeTracking` + `json` formats.
- **`lib/` orchestration / thin `api/`** split; deterministic scorers separated from IO so
  they're unit-testable (like `site-audit.ts`).

**New for a multi-tenant product:**
- `workspace_id` on every table + Supabase RLS per workspace; roles: owner/admin/member
  (ARC's invite-only auth flow ports directly).
- **Scheduler**: a `scan_schedule` table (business × engine × cadence × next_run_at); tick
  enqueues due scans. ARC launches scans manually — here recurrence is the product.
- **Usage metering + billing**: `usage_events` (engine, credits, tenant) → Stripe subscriptions
  by tier.
- **White-label**: workspace-level logo/colors/domain for the weekly PDF digest (port ARC's
  `proposal-pdf.tsx` machinery for the report).

---

## 6. Data model (core tables)

```
workspaces        id, name, plan, branding jsonb, stripe_customer_id
members           workspace_id, user_id, role
businesses        id, workspace_id, name, kind(local_service|ecommerce|hybrid),
                  website, geo jsonb, profile jsonb (Brand Brain output),
                  competitors jsonb[], engines_enabled text[]
source_queries    id, workspace_id, business_id, engine, query, geo, enabled
scans             id, workspace_id, business_id, engine, status, step, analysis jsonb,
                  counters (found/qualified/drafted), locked_at, error
                  -- one generic table replaces ARC's per-feature scan tables
scan_schedule     workspace_id, business_id, engine, cadence, next_run_at
signals           id, workspace_id, business_id, engine, type(intent_post|complaint_cluster|
                  content_gap|channel|price_change|trend|citation_issue), score,
                  score_reasons text[], title, summary, url, source_domain, evidence jsonb,
                  dedupe_hash unique-per-business, status(new|approved|dismissed|done),
                  first_seen, last_seen
signal_actions    id, workspace_id, signal_id, kind(reply|landing_page|ad_angle|outreach|
                  offer|content_brief), draft jsonb (variants), approved_by, used_at
watch_targets     id, workspace_id, business_id, url, label, last_hash, last_diff jsonb,
                  checked_at
source_cursors    workspace_id, business_id, source_key, cursor jsonb, updated_at
                  -- incremental scans: Review Miner "newest review seen", Intent Radar
                  -- last-seen post per query, etc.
digests           id, workspace_id, business_id, period, stats jsonb, pdf_path, sent_at
usage_events      workspace_id, engine, provider(firecrawl|openai), credits, at
scrape_cache      url_hash, content_path, fetched_at   -- cross-tenant, global (no tenant data);
                  -- callers pass their own max-age per engine instead of a stored TTL
```

All business-scoped tables carry a denormalized `workspace_id` so RLS policies are single-column
checks (no joins in policies — cheap and Supabase-friendly).

Key differences from ARC: **one generic `scans` table** (engine column) instead of
per-feature tables; **`signals` is the universal output** (ARC writes into `leads` — here
leads are just one downstream of a signal); `dedupe_hash` generalizes the `place_id` trick
(URL hash for posts, competitor+theme for clusters, query for gaps).

---

## 7. Compliance guardrails (bake in, don't bolt on)

- **Public data only.** Crawl what's publicly served. Never scrape private/authed consumer
  spaces or collect consumers' personal contact info (emails/phones of individuals). Signals
  point to *public posts*, not people.
- **Engage in-platform.** Intent Radar drafts public replies the human posts from the client's
  own account, following each community's self-promo rules (drafts include a disclosure line).
  No auto-posting, no DM automation in v1 — that's account-ban + spam-law territory.
- **No individual profiling.** Store post URL + content, not author dossiers. Honor deletions
  (re-scrape 404 → drop signal).
- **Competitor data = public pages** (prices, reviews, ads in public ad libraries). Fine.
- Add a per-source `robots/ToS` note field so you can switch sources off per jurisdiction.

This is also the sales pitch: "acquisition intelligence without buying sketchy consumer data."

---

## 8. Packaging (sketch)

| Tier | For | Includes |
|---|---|---|
| Starter | 1 business | Intent Radar (daily) + Review Miner (2 competitors) + weekly digest |
| Growth | 1–3 businesses | + Demand Capture, Channel Scout, 5 competitors, Market Watch weekly |
| Agency (white-label) | many businesses | All engines, daily Market Watch, branded reports, per-client seats |

Price to margin: track Firecrawl+OpenAI cost per business per month via `usage_events` first
(run 2–3 pilot clients), then set tiers at ~5–8× cost. The **Agency tier is your wedge** — you
already sell to agencies/SMBs, and one agency = many businesses.

---

## 9. Build roadmap

**Phase 1 — prove the loop (2–3 weeks of focused build):**
Auth/workspaces/RLS (port ARC) → Brand Brain → Intent Radar → Signal feed UI with approve/
dismiss + drafted replies → manual scan launch. *Sellable as a pilot immediately.*

**Phase 2 — retention:** Scheduler + Review Miner + weekly email digest (Resend) + usage
metering. Pilot with 2–3 of your existing clients; tune signal scoring on real feedback.

**Phase 3 — moat:** Demand Capture + Channel Scout + white-label PDF reports + Stripe billing.

**Phase 4 — scale:** Market Watch (changeTracking + ad intel), `/agent` deep-research jobs,
cross-tenant scrape cache, public API/Zapier.

**Port-from-ARC checklist:** `ai/firecrawl.ts`, `ai/openai.ts`, `ai/places.ts`,
`ai/site-probe.ts`, `ai/pagespeed.ts` (optional, Engine 3 site-health), the lease/claim
helpers from `prospecting.ts`, tick route, invite auth, `proposal-pdf.tsx` (→ digest PDF),
Supabase migration conventions.

---

## 10. Risks & open questions

- **Signal quality is the product.** If Intent Radar surfaces stale/low-intent posts, churn is
  instant. Budget real tuning time in Phase 2; keep score thresholds per-business editable.
- **Source volatility:** Reddit/Yelp/Meta change markup and block patterns; Firecrawl absorbs
  most of this (that's what you pay them for), `/agent` is the fallback — but design sources as
  pluggable configs, not hardcoded logic.
- **Firecrawl dependency:** single vendor for the core capability. Acceptable at this stage;
  the `ai/` leaf-client pattern means a swap is contained to one file.
- Decide later: auto-posting integrations (risky), review-response automation for the client's
  *own* reviews (safe, easy add-on), lightweight CRM for converted signals vs. pushing to the
  client's existing tools.

