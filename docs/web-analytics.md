# Web Analytics

Everything `www.arcai.agency` knows about its visitors, mirrored into the CRM
so it can be analysed next to leads, clients and revenue.

This is **not** the `visitor_events` table on the AI & Intelligence page. That
one is the app's own tracking snippet for client sites, and nothing here
touches it. Web Analytics is its own nav item, its own tables (`web_*`), its
own sync and its own reports.

---

## Why it is built this way

The website and the CRM live in **two different Supabase projects**. You
cannot join across two Postgres projects, and the whole point of this feature
is joining — "the £8k prospect read the pricing page twice before they
emailed" is a sentence that needs both databases in one query. So one side has
to come to the other, and the website's data comes here.

That mirror is also the archive. The site prunes its raw events on a rolling
window so its tables stay small; the CRM keeps the history.

---

## Setting it up

### 1. Website project — create the tables

Run **`supabase_web_analytics_migration.sql`** (in the website repo root) in
the **website** project's SQL editor. It creates:

| Table | What it holds |
| --- | --- |
| `analytics_sessions` | One row per visit — source, device, geo, journey endpoints, engagement, conversion |
| `analytics_events` | The ordered event stream inside each visit |

The site's existing `page_visits` table is left alone and still written to, so
the current `/admin` dashboard keeps working unchanged.

### 2. Website project — environment

```
ANALYTICS_IP_SALT=<a long random string>
```

Used to salt the SHA-256 of the visitor's IP. No raw IP is ever stored. Set it
once and leave it — changing it resets returning-visitor detection.

### 3. CRM project — create the tables

Run **`supabase/migrations/0105_web_analytics.sql`** in the **CRM** project's
SQL editor.

### 4. CRM project — environment

```
WEBSITE_SUPABASE_URL=https://<website-project-ref>.supabase.co
WEBSITE_SUPABASE_SERVICE_ROLE_KEY=<the website project's service_role key>
WEBSITE_ANALYTICS_SITE=arcai.agency
```

Both are in the website project's dashboard under **Project Settings → API**.

Leave them unset and the whole feature is a clean no-op: the page loads, says
what is missing, and the automation tick skips the pull entirely.

> **On the service-role key.** It bypasses RLS on the website project — treat
> it as full access to that database. Everything in `@/lib/web-analytics` only
> ever issues `select` against it, and nothing in that module writes back. If
> you want to tighten it later, create a read-only Postgres role on the
> website project and use a key scoped to that instead.

### 5. Confirm

Open **Web Analytics → Setup → Test connection**. Then **Sync now**. The first
run backfills up to 400 days of sessions and 730 days of the legacy
`page_visits` history, so give it a minute.

---

## What gets collected

The tracker (`src/lib/analytics/tracker.ts` in the website repo) records:

**Identity & session** — persistent visitor id, 30-minute session window,
new vs returning.

**Acquisition** — referrer and referring domain, channel classification
(direct, organic, paid search, paid social, social, email, referral,
affiliate, **AI assistant**, internal), full UTM set, `gclid` / `fbclid` /
`msclkid`, and **first-touch attribution** carried forward on every later
session so a campaign that introduced someone still gets credit months on.

**Journey** — every page view in order, entry page, exit page, page count,
and the page-to-page transitions that build the journey map.

**Engagement** — wall-clock duration *and* engaged time (the clock only runs
while the tab is visible and the visitor has done something in the last 30
seconds), scroll-depth milestones at 25/50/75/90/100%, time on each page.

**Interaction** — clicks, CTA clicks, outbound links, downloads, `tel:` and
`mailto:` clicks, WhatsApp clicks, copy events, video plays, exit intent,
**rage clicks** (three hits in a second) and **dead clicks** (a click on
nothing interactive).

**Forms** — start, which fields were touched, abandon with seconds spent, and
submit. Any email typed into any form identifies the session.

**Conversions** — confirmed outcomes only, each with a lead id. See *The lead
ledger* below: enquiries count, contact clicks are intent, spam and tests are
set aside, and nothing is inferred from the page a form happened to be on.

**The AI agent** — chat opened, every message with its length, and the full
transcripts pulled from `chat_messages` and `chat_logs`.

**Environment** — device type, browser and version, OS and version, screen and
viewport size, pixel ratio, language, timezone, connection type.

**Geography** — country, region and city from the CDN edge headers (Netlify's
`x-nf-geo`, with Vercel and Cloudflare fallbacks).

**Performance** — Core Web Vitals (LCP, CLS, INP, FCP, TTFB) as field data,
plus JavaScript errors and unhandled rejections.

**Google Analytics** — the commercially interesting events are mirrored into
GA4 via the existing `gtag` (`G-0447V2XK5V`), so conversions still reach the
ad platforms that read from GA.

---

## How it runs

The pipeline is a **job that advances in bounded steps**, not a single
call. The CRM's serverless functions are killed at roughly 26 seconds, and a
pull plus its rollups can need far longer than that — so every step does a
few seconds of work, records exactly where it got to, and returns; the next
caller carries on. Job state lives in `app_settings` (`web_analytics_job`),
taken under a 90-second lease so two callers can never run a step at once.

| When | What |
| --- | --- |
| 06:15 and 18:15 UTC | `web-analytics-sync.mts` starts a job and does its first step. The morning run also asks for the daily report and for new chat conversations to be labelled. |
| Every 5 minutes | The automation tick does one more step of whatever job is running (≈6s of work), and starts a job on its own if `WEB_ANALYTICS_SYNC_INTERVAL_HOURS` (default 12) have passed since the last one finished. |
| On demand | **Sync now** on the page starts a job and keeps stepping it while the page is open; `GET /api/web-analytics/sync?budget=18000` does one step per call. |

A job runs `sync → ledger → rollup → chats → report → done`. The sync phase
pulls all five streams a page at a time, writing each stream's watermark after
every page; the ledger phase turns every new conversion event into a
reconciled `web_leads` row (see below) — it sits before the rollup because the
rollup reads its conversion figures from it; the rollup phase recomputes one
day per iteration, newest first, from the days the sync actually touched (`synced_at` on the mirror
rows, read back — nothing is kept in memory between steps). A step the
platform kills loses one page or one day of work; three killed steps in a
row and the phase is abandoned with a recorded error rather than retried
forever.

Every stream is incremental (a watermark in `web_sync_state`) and idempotent
(every write is an upsert on a natural key from the source), so a step that
dies halfway is safe to retry and nothing is ever double-counted.

Tuning: `WEB_ANALYTICS_SYNC_INTERVAL_HOURS` (default 12) and
`WEB_ANALYTICS_STEP_MS` (the tick's per-step budget, default 6000).

**The AI Insights scan** has the same constraint and the same answer. A
high-effort reasoning read of the whole export takes minutes, so the model
call is an OpenAI *background response*: **Re-scan** starts it and returns,
the page polls every few seconds while open, and the automation tick stores
the result if the page was closed. The scan in flight lives in
`app_settings.web_insights_scan`; a reasoning-model failure falls back to
the chat model before a failed row is written.

---

## The tables

| Table | Purpose |
| --- | --- |
| `web_sessions` | Mirrored visits, plus `matched_lead_id` / `matched_client_id` |
| `web_events` | Mirrored event stream, from both the rich tracker and legacy `page_visits` |
| `web_daily` | Per-day rollup — the dashboard's fast path |
| `web_page_daily` | Per-page-per-day metrics |
| `web_journeys` | Page-to-page transitions and whole routes, rolling 30 days |
| `web_chat_sessions` | The website agent's conversations, with AI topic/intent/sentiment/buying signals |
| `web_chat_messages` | Every message in those conversations |
| `web_reports` | Generated reports — markdown, plus the stats they were written from |
| `web_sync_state` | The incremental cursor per stream (the ledger's is the `ledger` row) |
| `web_sync_runs` | Audit trail of every pull |
| `web_leads` | **0125** — the lead ledger: one row per website conversion, reconciled to a CRM lead, a test or spam |

---

## The lead ledger (0125)

The Web Analytics page once reported **17 conversions in a month: 15 footer
newsletter signups from one spam script, 2 WhatsApp clicks, 0 enquiries** —
next to a funnel in which only 2 sessions had shown any intent. A conversion
count that cannot be walked back to a list of people is not a number to decide
with, so now there is the list.

`web_leads` holds one row per conversion the website recorded, keyed by the
**lead id** the site's tracker mints (`lead_…`) — the same id the contact form
posts to the inbound webhook, which stores it on `leads.website_lead_id`. One
key on both sides is what makes "this conversion is this lead" a join rather
than a guess by time and email. Contact clicks are keyed `<kind>:<session>` so
ten clicks on one WhatsApp button are one row with `occurrences = 10`; a
session flagged converted whose event never arrived gets a `session:<id>` row.

Every row carries a **category** and a **verdict**:

| Category | Kinds | Counts as a conversion when |
| --- | --- | --- |
| `enquiry` | contact form, chat lead, project request | verdict is `lead`, or `unreviewed` (believed until someone says otherwise) |
| `contact_click` | WhatsApp, `tel:`, `mailto:` | verdict is `lead` — a person confirmed the conversation happened |
| `other` | newsletter, job application, review | never |

Verdicts are `unreviewed | lead | test | spam`, with a `status_source` of
`rule` (the classifier), `manual` (a person, on the **Leads** tab) or `none`.
**A person's verdict is final** — the classifier never overwrites `manual`.
The rules that set the first verdict live in `src/lib/web-analytics/ledger-core.ts`
and are unit-tested against the real spam signature: a user agent stored with
literal quote characters, a form submitted with zero engaged seconds and no
form interaction, a success reported for a form nobody focused, and
dot-obfuscated Gmail addresses; `?arc_test=1` on the site and test-looking
addresses file as `test`.

**Every conversion figure reads from the ledger once it exists**:
`web_daily.conversions` (distinct sessions with a counting row that day),
`web_page_daily.conversions`, the funnel's *Showed intent* (form start, chat,
or any genuine ledger row — contact clicks included) and *Converted* (a
counting row — a strict subset, by construction), *Visits that converted*, the
journeys' converted routes, and the AI scan's evidence (`lead_ledger`). Two new
daily columns sit beside it: `contact_clicks` (intent, never inside
conversions) and `excluded_conversions` (spam + test set aside that day).

Changing a verdict on the Leads tab recomputes that day's rollup immediately.
Before migration 0125 is applied every reader returns null and the pipeline
falls back to the tracker's session flag, recording `ledger: The lead ledger
table … does not exist yet` on the Setup tab. After applying it, press
**Rebuild history** once so every past conversion is reconciled.

The webhook writes its side of the row the moment the lead exists
(`recordHookConversion`), so an enquiry whose analytics event was lost — a
browser with storage blocked, a beacon that never landed — is still on the
ledger, matched to its lead.

---

## Check progress (0125)

The improvement checklist is written by a scan and then sits there; the only
way to know whether an item was actually finished used to be another full
scan and a comparison by eye. **Check progress** (beside Re-scan) is the
cheap middle step: one request on the chat model reads the *current* numbers
against every open item's metric and target and records a verdict on the item
— `done`, `in_progress`, `not_done` or `cannot_tell` — with a one-sentence
note citing the figures. Items the data shows are done are ticked off
(reversibly); the others show their verdict on the list. Press it before a
re-scan so the list can be trusted first.

---

## Identity stitching

When a visitor types an email into a form or gives it to the chat agent, the
sync matches it against `leads.contact_email` and `clients.email` and stamps
the session. Every page that visitor read — including the ones before they
identified themselves — becomes attributable to a named person with a deal
value attached.

---

## Asking Arcus

The assistant has seven tools over this data:

- `website_traffic_report` — visits, sources, devices, geography, conversions,
  always against the previous period
- `website_page_performance` — per-page views, reading time, scroll, form
  abandons, rage clicks
- `website_journeys` — common routes, next steps, where visits end
- `website_chat_review` — what visitors are asking the bot, with buying signals
- `website_lead_ledger` — the reconciled conversions: real leads, spam, tests,
  unmatched enquiries, qualified and won totals
- `website_generate_report` — write and save a report
- `website_sync_now` — pull immediately

So "why did enquiries drop last week", "which page loses the most people" and
"what are people asking the website bot about" are all answerable in chat.

---

## Privacy

- No raw IP is stored — only a salted SHA-256, truncated to 32 characters.
- Geography is coarse (country / region / city) and comes from the CDN edge.
- `/admin` routes on the website are not tracked at all.
- Known bots and crawlers are flagged and excluded from every rolled-up figure.
- `prune_analytics(keep_days)` on the website project trims the raw tables on a
  rolling window once the CRM holds the history.
