# The public surface

Every URL the CRM answers to without a team login, what it takes, and how
hard it is rate-limited. Everything else under `/api` and every page under
`/(app)` needs a signed-in team member. The list of public paths is
`PUBLIC_PREFIXES` in `src/lib/supabase/middleware.ts`; a new public route
must be added there (and, for a machine route, to `MACHINE_PREFIXES` and the
matcher in `src/proxy.ts`).

Rate limits are per bucket and fail **open**: if the shared counter is
unreachable the request is allowed (`src/lib/rate-limit.ts`). A refused
request is `429` with `Retry-After`.

## Open API — `/api/public/v1/*`

Authenticate with an API key made on **Automation → Connect** (`arc_…`),
sent as `x-api-key: arc_…` or `Authorization: Bearer arc_…`. Limit: 120
requests a minute per key; unauthenticated calls are bucketed per IP.

| Route | What it does |
| --- | --- |
| `GET /api/public/v1/leads` | The most recent leads. |
| `POST /api/public/v1/leads` | Create a lead — `title` (or `name`), `contact_name`, `email`, `phone`, `value`, `notes`, `source` (default `api`), `tags[]`, optional `pipeline_id` / `stage_id`. Fires the `lead_created` automations. |
| `GET /api/public/v1/projects` | Projects — `?id=` for one with its money broken out (received, balance); `?limit=` (≤200), `?status=`, `?stage=`, `?client_id=`. Never cost data, never the portal token. |
| `POST /api/public/v1/projects` | Create a project — `name` (required), `status`, `delivery_stage`, `client_id`, and the public columns. Fires automations. |

## Inbound hooks — `POST /api/public/hooks/<token>`

Created on **Automation → Connect** with an action: `create_lead` maps the
payload to a lead (name / first + last, email, phone, website, and any
`utm_*` fields, keys matched case- and punctuation-insensitively) or
`fire_automation` enrols the payload straight into an automation. JSON or
form-encoded. 300 a minute per token. `OPTIONS` answers CORS.

## Forms and tracking

| Route | What it takes | Limit |
| --- | --- | --- |
| `POST /api/public/forms/lead` | `name`, `phone`, `email`, `message`, `service`, `source`, `company`; attribution flat (`utm_source` …) or nested `utm: {}`, `referrer`, `landing_url`, and `ref` (a client's referral code, 0117). Creates the lead through `createInboundLead()`. | 20 / 5 min per IP |
| `GET /api/public/track` | The embeddable snippet: `<script src="…/api/public/track" data-site="client-x" async>`. | — |
| `POST /api/public/track` | One visitor event — `kind` (pageview, form_start, form_abandon, form_submit), `site`, `session_id`, `path`, `referrer`, `meta`. | 120 / min per IP |
| `GET /api/health` | The uptime check: database, tick freshness, WhatsApp tick, integration flags, open faults → `200` / `503`. See `docs/ops.md`. | 60 / min per IP |

## Webhooks the CRM receives

| Route | Guard |
| --- | --- |
| `POST /api/webhooks/resend` | Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) keyed by `RESEND_WEBHOOK_SECRET`. Handles `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained` against `email_messages`. |
| `GET /api/whatsapp/webhook` | Meta's subscription handshake (`hub.verify_token` = `WHATSAPP_VERIFY_TOKEN`). |
| `POST /api/whatsapp/webhook` | `X-Hub-Signature-256` over the raw body, keyed by `WHATSAPP_APP_SECRET`. |
| `GET /api/outreach/unsubscribe?e=&t=` | Per-address HMAC token; adds the address to `outreach_suppressions`. |

Outgoing HTTP calls are an automation **step** (`webhook` in a flow), not a
subscription: a flow posts its payload to the URL it names.

## Cron endpoints (machine-only)

`GET /api/automation/tick`, `/api/whatsapp/agent-tick`,
`/api/assistant/tick`, `/api/web-analytics/sync`, `/api/intelligence/digest`
— each requires `Authorization: Bearer <SMS_CRON_SECRET>` and refuses (503)
when the secret is unset. Invoked by the scheduled functions in
`netlify/functions/`.

## Token pages — the link is the credential

Each of these is worthless without its unguessable token, renders a
hand-picked client-safe view, and its server actions re-resolve the token
and rate-limit before writing anything.

| Page | Actions and limits |
| --- | --- |
| `/q/<token>` quote | accept / decline — 20 / 10 min per token |
| `/p/<token>` proposal | sign — 20 / 10 min per token; `GET /api/public/proposal/<token>/pdf` 30 / 5 min per IP |
| `/a/<token>` agreement | sign / decline — 20 / 10 min per token |
| `/public/invoice/<token>` invoice | `GET /api/public/invoice/<token>/pdf` 30 / 5 min per IP; **`uploadPaymentSlip`** (a bank-transfer slip, ≤10 MB, filed to the Slips queue) 5 / hour per token and 20 / hour per IP |
| `/public/statement/<token>` statement of account | page 60 / 5 min per IP; `GET /api/public/statement/<token>/pdf` 30 / 5 min per IP; `?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| `/public/project/<token>` project portal | unlock (passcode), upload a file, change request, approval, comment, pulse, **`uploadPortalPaymentSlip`** — each its own bucket per token; `GET /api/public/meeting/<token>/ics?meeting=` 30 / 10 min per IP |
| `/public/review/<token>` review | submit — 10 / 10 min per token |
| `/public/content/<token>` content approval | approve / request changes — 20 / 10 min per token |
| `/showcase/<token>` prospect showcase | read-only |
| `/audit` free site audit | 3 / hour per IP |
| `/book/<slug>` meeting booking | 6 / hour per IP |
| `/portal` client account | login code 10 / hour per IP (and per number inside `client-auth`); the client holds their own signed cookie, never a Supabase user |

The two slip uploads are the only public writes that put a file in
storage; both go to the private `payment-slips` bucket through the
service-role client, and nothing is recorded as money until a person
confirms the slip on Finance → Slips.

## The website agent — `/ai-widget.js` and `/api/ai/*` (0126)

A client's site carries one line:

```html
<script src="https://<crm-host>/ai-widget.js" data-project="pk_…" async></script>
```

`/ai-widget.js` is a static file (public, cached five minutes). Everything
else takes the project's public key as `?p=` and is gated on the browser's
`Origin`: the origin must be on the project's allow-list (Deploy tab) or be
the CRM's own (`NEXT_PUBLIC_APP_URL`, which is how the preview works). Only a
matching origin is echoed in `Access-Control-Allow-Origin`.

| Route | What it does | Limit |
| --- | --- | --- |
| `GET /api/ai/config?p=` | The widget's branding, welcome message, chips and which abilities are on. Never the prompt or the model. | 60 / min per IP |
| `POST /api/ai/chat?p=` | One visitor turn, streamed as SSE frames (`meta`, `delta`, `tool`, `action`, `done`, `error`). | 30 / min per IP · the project's per-visitor limit · 600 / hour per project · the project's daily message cap |
| `POST /api/ai/lead?p=` | The fallback lead form the widget shows when the model is unavailable. | 5 / 10 min per session · 20 / hour per IP |

A paused or draft project answers `enabled: false` on config (the widget
hides itself) and refuses chat, except from the CRM origin, where usage is
recorded as preview and never billed.

### The client read API — `/api/ai/v1/*` (0127)

How a client's own website reads its own leads back, to render their dashboard
on their site rather than on ours. Authenticate with the project's read key:

```
Authorization: Bearer arck_…
```

| Route | What it does |
| --- | --- |
| `GET /api/ai/v1/leads` | That project's leads. `?since=`, `?status=`, `?limit=` (≤200). |
| `GET /api/ai/v1/conversations` | Conversation summaries, previews excluded. |
| `GET /api/ai/v1/conversations/:id` | One transcript; tool calls appear as a name only. |
| `GET /api/ai/v1/summary?days=` | Counts for a dashboard header. |
| `PATCH /api/ai/v1/leads/:id` | `{ status }` — the only write a client gets. |

120 requests a minute per key. **These routes send no CORS headers and have no
`OPTIONS` handler**, which is the security model, not an omission: the key
belongs on a server, and a browser therefore cannot use it even if it leaks
into a page. Responses carry `Cache-Control: no-store` and an allow-list of
fields — never cost, tokens, prompts, models or billing.

Outbound in the other direction (a captured lead, a tool the agent reaches
for) is signed with the project's shared secret and documented in
`docs/ai-projects-client-kit.md`.
