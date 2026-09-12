# Operations

How the CRM is run: what protects the data, what backs it up, and what to
do when something is wrong. Written for whoever is on call, not for the
person who built it.

## Permissions — "RLS-lite"

The database's row-level security is deliberately permissive: every table
that members can see is `USING (true)` for an authenticated user, with a
handful of admin-only tables (`social_accounts`, `app_settings`) and tables
with no policies at all that only `security definer` functions touch
(`document_counters`, `rate_limit_hits`).

**The app enforces; the database records.** Two layers decide what a
person can do:

1. **Role** — `profiles.role` is `admin` or `member`. Admin-only pages
   call `requireAdmin()`; admin-only nav items carry `adminOnly`.
2. **Capabilities** (0121, T5.2) — `profiles.capabilities` names the areas
   a member may work in: `finance`, `delivery`, `sales`, `marketing`. An
   admin has all four by role. Members are ticked on the Team page; the
   backfill gave every existing member all four, so nothing changed the day
   it landed.

Capabilities are applied in two stages, switched on `/settings`:

| `app_settings.capabilities_enforced` | Sidebar | Pages | Money actions |
| --- | --- | --- | --- |
| `{"enabled": false}` (default) | hidden without the tick | open | open |
| `{"enabled": true}` | hidden without the tick | `requireCapability()` → `/dashboard` | `recordPayment()` refuses a member without `finance` |

Where the rule lives:

- `src/lib/capabilities.ts` — `hasCapability()`, pure, read by the sidebar.
- `src/lib/capabilities-server.ts` — the switch, `actorHasCapability()` for
  code that carries an `actorId` (the payment choke point), and
  `capabilityAudienceIds()` for the finance notifications.
- `src/lib/auth.ts` — `requireCapability()` for pages, `assertCapability()`
  for server actions.

Why not real RLS: every screen in the CRM joins across a dozen tables and
is read by both roles; policies per capability would have to be written on
every one of those tables and kept in step with the app's own idea of an
"area". The app already knows the area — the nav is grouped by it — so the
app enforces it, once, and the database stays simple enough to reason about.
The cost is honest: a member with a direct database credential is bounded by
their role, not by their capabilities. Nobody but the service role has one.

## Health and errors

- **`GET /api/health`** (public, machine-only, rate-limited by IP) is the
  uptime check: the database answers, the automation tick has run in the
  last 16 minutes (it runs every 5), the WhatsApp tick in the last 6 (every
  minute, only checked when WhatsApp is configured), which integrations have
  keys (booleans only), and how many faults are open. `200` healthy, `503`
  degraded — the body names the failing check. Point the monitor at it.
- **Errors** are one row per distinct fault in `error_events` (0121),
  counted rather than repeated: `captureError()` in `src/lib/errors.ts` is
  called from the three tick routes and by the page error boundaries through
  `POST /api/errors`. An admin is notified the first time a fingerprint is
  seen and at most every six hours while it recurs; the Errors panel on
  `/settings` lists and resolves them (a resolved fault reopens itself if it
  comes back). With `SENTRY_DSN` set, each capture is also posted to Sentry
  as a raw envelope — Sentry is a mirror, never the record.

## Personal data — export and erasure

- **Export** — `GET /api/clients/<id>/export` (admins) is everything held
  about one client as a zip of JSON files plus their statement; the client
  page's "Export data" button. Produced by `exportClientData()` in
  `src/lib/client-erasure.ts`; hand-picked fields, never internal costs or
  notes about margins. Each export is a `system_events` line.
- **Erasure** — "Erase…" on the client page (admins, the name typed to
  confirm) calls `eraseClient()`, the one way to forget a person:
  **anonymise** scrubs the client row (name, email, phone, company, city,
  notes, referral code; the statement link is re-minted) and every place
  their words or details live — WhatsApp contact names and message bodies,
  SMS numbers (masked to the last three digits) and texts, lead contact
  fields, email addresses and bodies, booking details, agreement signatures,
  bank-slip images (the objects in `payment-slips` are removed) — and stamps
  `clients.anonymised_at`. **delete** does the same and then removes the
  row, and is refused once any invoice or payment exists: the accounts must
  still add up. "Delete" on the clients list is the same erasure with the
  same refusal. Every erasure is a `system_events` line naming who asked.

## Backups and restore

- **Database** — the Supabase project takes a daily backup on every paid
  plan; enable **Point-in-Time Recovery** (Project → Database → Backups) so
  a bad migration or a mistaken erasure can be rewound to the minute rather
  than to last night. A restore is done from that screen; the app needs no
  change afterwards — every migration in `supabase/migrations/` is additive
  and already applied to the restored state.
- **Storage is NOT in `pg_dump`.** A database backup carries the `file_path`
  of every object and none of the bytes. The buckets that matter:
  `project-docs` (deliverables), `receipts`, `resources`, `wa-media`,
  `content-*` and `carousel-slides`, and **`payment-slips`** — private, and
  it holds photographs of clients' bank-transfer slips, which is to say
  images of bank-account details. Back the buckets up separately (Supabase
  Storage → the bucket → download, or a scheduled `supabase storage cp`)
  and treat a copy of `payment-slips` with the care you would give the
  database itself.
- **Secrets** live in Netlify's environment, not in the repo or the
  database. Keep a copy of the variable list somewhere safe; a restore of
  the database alone does not restore a lost `SUPABASE_SERVICE_ROLE_KEY`,
  `SMS_CRON_SECRET`, `SOCIAL_TOKEN_KEY` (without which every stored social
  token is unreadable) or `WHATSAPP_ACCESS_TOKEN`.
- **The website** (`arc_ai_website`) is its own Supabase project with its
  own backups; the CRM writes reviews and vacancies into it but never reads
  it back for anything it cannot rebuild.

## AI Projects (0126)

- The private `ai-knowledge` bucket holds clients' uploaded documents. Like
  every bucket it is **not** in `pg_dump`; back it up with the others. The
  extracted text of every file is also on `ai_kb_sources.content`, so an
  index can be rebuilt from the database alone.
- `ai_usage_events` is the billing ledger. Never edit it in place; a wrong
  price is corrected by adding a dated catalog row and, if the past matters,
  by hand.
- Four passes ride the automation tick: `aiIngest`, `aiCrawl`, `aiRollup`,
  `aiBilling`. Stamps: `app_settings.ai_rollup` and `app_settings.ai_billing`.
- Days and months in this module are Asia/Colombo (Web Analytics is UTC).
- Public surface: `/ai-widget.js`, `/api/ai/config`, `/api/ai/chat`,
  `/api/ai/lead` — see `docs/api.md`.

## Content Office (0130)

- The seven `office_*` tables are the agents' own. `office_missions`,
  `office_tasks` and `office_events` are readable by every signed-in member
  and writable by **nobody** through the anon key — every write is a server
  action on the service role behind `assertCapability("marketing")`. Config
  (`office_agents`, `office_brand_profiles`, `office_schedules`) is admin-write.
  `office_task_transcripts` is admin-read: it carries raw web text.
- Every agent call is an OpenAI **Responses API** call in background mode
  (`src/lib/ai/responses.ts`); nothing awaits a model. The response id is
  written before anything else after a create, so a killed step polls the
  same paid response next time instead of buying another. `attempts` counts
  paid starts (cap 3, backoff 1m/5m/15m); `killed` counts leased steps the
  platform cut off (cap 3); a poll bumps neither.
- Spend lands in `ai_usage_events` with `purpose = 'agent'` and
  `project_id IS NULL` (`office_task_id` set). Every existing reader filters
  by an explicit project, so these rows can never reach a client invoice.
  A daily cap (`app_settings.content_office.daily_cap_usd`, default
  `OFFICE_DAILY_BUDGET_USD` = 15) blocks new starts; polling continues.
- One pass rides the automation tick: `contentOffice`. The open page drives
  the same function every 5 s. Housekeeping stamp: `app_settings.office_janitor`
  (events older than 14 days are trimmed every 6 h).
- Publishing: missions end in `review`; a person presses **Approve &
  schedule**, which goes through `queueSocialPost` like the Calendar does. A
  mission or timer with `autoPublish` (admin-only) lets the Publisher agent
  queue posts itself. `SOCIAL_TOKEN_KEY` and `SOCIAL_DRY_RUN` apply unchanged.
- Timers (`office_schedules`) fire on the tick with a compare-and-set on
  `next_run_at`. Unattended runs advance one step per tick and render one
  slide per tick, so a timer should fire hours before the posts are due.

## Meta Ads (0132, 0133)

- **Apply** `supabase/migrations/0132_meta_ads.sql`, then
  `0133_meta_ad_syncs_synced_at.sql`, in the SQL editor. Run
  `node scripts/schema-audit.mjs` before and after, as with any migration.
  0132 adds `meta_ad_entities`, `meta_ad_insights`, `meta_ad_syncs` and four
  nullable `wa_contacts.ad_*` columns; 0133 adds `meta_ad_syncs.synced_at`
  (when the numbers were read from Meta — the stale-payload guard reads it).
  Both are additive, idempotent and safe on a live system. 0133 is separate
  only because 0132 was applied before review added that column.
- **Verify:** `select version from schema_migrations where version in
  ('0132_meta_ads', '0133_meta_ad_syncs_synced_at');` returns two rows. `/ads`
  shows "No ad data yet" instead of the setup screen.
  `node scripts/ads-sync.mjs scripts/fixtures/ads-sync-sample.json --dry-run`
  prints a plan, "credentials … found" and "a real run would be REFUSED".
  The fixture is sample data carrying the live ids, so the script refuses to
  write it for real. It also refuses any argument it does not know, and any
  payload read from Meta before the numbers already stored.
- **Who writes:** nobody through the anon key. The tables are admin-read
  with **no** write policy for `authenticated`. Only `scripts/ads-sync.mjs`
  writes, with the service role from `.env.local`, and only into these three
  tables (upserts plus one sync row; it never deletes). There is no Meta
  token, cron or Netlify function for ads. Claude syncs on demand; the
  procedure is in `docs/meta-ads.md`.
- **Claude Code permission:** the owner allows the script once by adding
  `Bash(node scripts/ads-sync.mjs:*)` to `.claude/settings.local.json` →
  `permissions.allow`.
- **Webhook:** after 0132, the first message after an ad tap stamps
  `wa_contacts.ad_source_id` / `ad_ctwa_clid` / `ad_referral` /
  `ad_entered_at` once. Check with `select ad_source_id, count(*) from
  wa_contacts where ad_source_id is not null group by 1;`. Before 0132, the
  function logs `[whatsapp] ad first-touch stamp skipped (is 0132 applied?)`
  and stores the message as normal. The referral is also kept on
  `wa_messages.meta.referral` either way.
- **Attribution** never uses `wa_contacts.campaign_id`. The Sept 2026
  Smart Websites `wa_campaigns` row reuses the August ad's row id, so
  `campaign_id` mixes the two campaigns.
