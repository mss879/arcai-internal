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

**Conversions** — form submits, call clicks and WhatsApp clicks, with the
conversion kind inferred from the page.

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

| When | What |
| --- | --- |
| Every 5 minutes | The automation tick calls the pipeline, which self-gates to once an hour |
| Hourly | Pull all five streams → roll up the days that changed (data only — no reports, no chat labelling) |
| 06:15 UTC | The Netlify scheduled function pulls a settled full day, writes the daily report and labels new chat conversations |
| On demand | **Sync now** on the page, or `GET /api/web-analytics/sync` |

Every stream is incremental (a watermark in `web_sync_state`) and idempotent
(every write is an upsert on a natural key from the source), so a run that
dies halfway is safe to retry and nothing is ever double-counted.

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
| `web_sync_state` | The incremental cursor per stream |
| `web_sync_runs` | Audit trail of every pull |

---

## Identity stitching

When a visitor types an email into a form or gives it to the chat agent, the
sync matches it against `leads.contact_email` and `clients.email` and stamps
the session. Every page that visitor read — including the ones before they
identified themselves — becomes attributable to a named person with a deal
value attached.

---

## Asking Arcus

The assistant has six tools over this data:

- `website_traffic_report` — visits, sources, devices, geography, conversions,
  always against the previous period
- `website_page_performance` — per-page views, reading time, scroll, form
  abandons, rage clicks
- `website_journeys` — common routes, next steps, where visits end
- `website_chat_review` — what visitors are asking the bot, with buying signals
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
