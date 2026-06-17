# ARC AI — High-End Feature & AI Roadmap

> A menu of premium modules and AI automations you can add to the ARC AI workspace.
> Written to be skimmed top-to-bottom, then cherry-picked. Each item says **what it is**,
> **why it matters for your agency**, and **the AI angle** where one exists.
>
> _Prepared: June 2026 • For: ARC AI (digital agency workspace — web / e‑commerce / social‑media services)_

---

## 1. Where the app is today

You already have a genuinely solid agency operating system. Current menu:

| Module | What it does today |
| --- | --- |
| Dashboard | Greeting, stats, calendar of to‑do due dates |
| Clients | Shared client directory |
| To‑Dos | Priority, assignment, due dates, `@mentions` |
| Projects | Planner + payments (receipts) + commissions + public client portal |
| CRM Pipeline | Drag‑and‑drop stages, leads |
| Meetings | Public booking links (share on WhatsApp), bookings saved |
| Payments | Company payments + status |
| Invoices | Invoice generator with print‑to‑PDF |
| Resources | Shared files (PDF/images) and links |
| Team & Access | Invites, roles, member count (admin) |

**The big gap: the app is called "ARC _AI_" but ships zero AI today.** That's the single
highest‑leverage opportunity in this document — the brand promise is already made, you just
need to deliver on it. Everything below is designed to (a) look high‑end to a client/teammate
and (b) save your team real hours.

---

## 2. The AI engine (read this once, applies to everything)

Every AI feature below runs the same way: a **server‑side call to the Claude API** from a
Next.js Server Action or route handler (never from the browser — the key stays server‑side,
exactly like your `SUPABASE_SERVICE_ROLE_KEY` today).

**Setup is small:**
- `npm install @anthropic-ai/sdk`
- Add `ANTHROPIC_API_KEY` to `.env.local`
- One helper in `src/lib/ai.ts`, then call it from server actions

**Which model to use (pick per task, not one for everything):**

| Model | Model ID | Input / Output per 1M tokens | Use it for |
| --- | --- | --- | --- |
| **Claude Haiku 4.5** | `claude-haiku-4-5` | $1 / $5 | High‑volume, cheap, fast: lead scoring, receipt extraction, classification, short summaries |
| **Claude Sonnet 4.6** | `claude-sonnet-4-6` | $3 / $15 | The everyday workhorse: email drafts, meeting summaries, search answers |
| **Claude Opus 4.8** | `claude-opus-4-8` | $5 / $25 | The hard stuff: proposals, the workspace copilot, multi‑step automations, forecasting narratives |

**Cost reality check:** a typical AI action here (draft an email, summarise a meeting, score a
lead) is a few thousand tokens. On Haiku/Sonnet that's a fraction of a US cent each. Even
hundreds of AI actions a day is a few dollars a month — trivial next to the time saved. Use
**prompt caching** for anything that re‑sends the same big context (your service catalogue,
brand voice) to cut cost ~90% on the repeated part.

**Two extra Claude capabilities worth knowing about**, because several features below lean on them:
- **Vision** — Claude can read an uploaded image/PDF. This is what powers receipt & invoice
  data extraction (no separate OCR service needed).
- **Tool use / structured outputs** — Claude can return strict JSON or call your functions.
  This is what lets the "copilot" actually _do_ things (create a to‑do, move a lead) instead of
  just chatting.

---

## 3. Tier 1 — AI features inside what you already have (fastest wins)

These need **no new menu item** — they make existing modules feel magic. Start here.

### 3.1 Receipt & invoice auto‑capture 📸 → 💳
**Where:** Projects → Payments (you already let users upload receipts to a private bucket).
**What:** When a receipt image/PDF is uploaded, Claude (vision) reads it and pre‑fills the
amount, vendor, date, and currency. The user just confirms.
**Why:** Removes the most tedious manual step in money tracking; near‑zero data‑entry errors.
**AI:** Haiku 4.5 with vision. ~1 call per upload.

### 3.2 Smart email drafting & reminders ✉️
**Where:** Clients, Projects, Invoices, CRM — anywhere you'd email someone (you already have Resend wired up).
**What:** One‑click "Draft follow‑up", "Draft payment reminder", "Draft proposal email". Claude
writes it in your agency's tone, pulling the client name, project, outstanding balance, etc.
You review → send.
**Why:** Consistent, professional client comms without the blank‑page tax. Overdue‑invoice
reminders practically write (and schedule) themselves.
**AI:** Sonnet 4.6. Store a short "brand voice" snippet and cache it.

### 3.3 CRM lead scoring & next‑best‑action 🎯
**Where:** CRM Pipeline.
**What:** Each lead gets an AI score (hot/warm/cold) and a one‑line "what to do next"
("No contact in 9 days — send a check‑in"). Optionally auto‑suggest which stage it belongs in.
**Why:** Your team focuses on the leads most likely to close; nothing falls through the cracks.
This is repeatedly cited as one of the highest‑ROI AI features for small sales teams.
**AI:** Haiku 4.5, run on a schedule (nightly) or on lead update.

### 3.4 Meeting notes → action items 🗒️
**Where:** Meetings.
**What:** After a booked call, paste/upload notes or a transcript; Claude produces a clean
summary, decisions, and a list of action items — and offers to create them as To‑Dos assigned
to the right people.
**Why:** The meeting → follow‑up gap is where agencies lose momentum. This closes it
automatically. (Real‑time transcription can come later via an integration; the summary+actions
layer is the valuable part and is easy now.)
**AI:** Sonnet 4.6.

### 3.5 Project brief → task plan 🧩
**Where:** Projects (new project, or a "Generate tasks" button).
**What:** Type a short brief ("E‑commerce site for a clothing brand, 6 pages, payment gateway")
and Claude drafts a structured task list with suggested owners and due dates, scoped to the
**service type** you already track (business website / e‑commerce / social media).
**Why:** Spin up a project plan in seconds instead of an hour; standardises delivery.
**AI:** Opus 4.8 (this benefits from the smartest model) or Sonnet 4.6.

### 3.6 Semantic search + "ask your workspace" 🔍
**Where:** Upgrade your existing global search.
**What:** Today search is keyword. Add natural‑language: "unpaid invoices over LKR 100k",
"projects on hold", "clients I haven't contacted this month" — and get a direct answer, not
just links.
**Why:** Turns the whole workspace into something you can interrogate in plain English. Feels
like the future; demos incredibly well.
**AI:** Sonnet 4.6 + tool use (queries your Supabase data). See also §4.1.

---

## 4. Tier 2 — New high‑end menu items (the "premium" expansion)

These are net‑new modules. Each is a real product surface a client or teammate would notice.

### 4.1 ⭐ Arc Copilot (AI assistant) — **the flagship**
**New menu item:** a persistent assistant (sidebar or `/copilot`).
**What:** A chat that knows your workspace. Ask it anything and let it act:
- "Summarise the Acme project and what's blocking it."
- "Who hasn't been paid their commission this month?"
- "Create a to‑do for Sara to follow up the Nimbus lead tomorrow." ✅ _(it actually creates it)_
- "Draft this week's update for the Beta Corp client."
**Why:** This is what makes the name "ARC AI" true. It's the single most impressive thing you
can add, and it ties every other module together.
**AI:** Opus 4.8 with **tool use** (read/write your existing data via safe, permissioned
functions) and **prompt caching** for the workspace context. Gate write‑actions behind a
confirm step.

### 4.2 Proposals & Quotes 📄
**New menu item:** `Proposals`.
**What:** Generate a branded proposal/quote from a brief or straight from a won CRM lead.
Line items, pricing in LKR, scope, timeline. Client views via a public link (you already have
the token‑based public‑page pattern from the project portal) and accepts online. On accept →
auto‑create the Project + first invoice.
**Why:** Closes the loop CRM → Proposal → Project → Invoice that you've half‑built already.
Huge perceived value; directly drives revenue.
**AI:** Opus 4.8 drafts the proposal scoped to the service type; you edit before sending.

### 4.3 Analytics & Insights 📊
**New menu item:** `Insights` (or upgrade Dashboard).
**What:** Revenue trends, pipeline value & win‑rate, commission payouts, client profitability,
overdue exposure. Plus an **AI narrative**: a plain‑English "here's what changed this month and
why, and here's what to watch" written on top of the charts. Optional **forecasting**
("projected revenue next 30 days based on pipeline").
**Why:** Turns raw data into decisions. The AI commentary is what separates this from a generic
dashboard.
**AI:** Sonnet/Opus generates the narrative from aggregated numbers (cheap — you send summary
stats, not raw rows).

### 4.4 Time Tracking & Timesheets ⏱️
**New menu item:** `Time`.
**What:** Track hours against projects/tasks, billable vs non‑billable, per team member. Feeds
straight into Invoices and commission logic. AI can suggest time entries from activity and write
the weekly timesheet summary.
**Why:** Agencies live or die on billable hours; this plugs a real gap between Projects and
Invoices.

### 4.5 Communications Hub (Inbox) 💬
**New menu item:** `Inbox`.
**What:** Client conversations in one threaded place — email (via Resend inbound) and WhatsApp
(you already share booking links there). AI drafts replies, summarises long threads, flags
sentiment ("this client sounds unhappy").
**Why:** Conversations are scattered today. Centralising them — with AI triage — is a premium,
sticky feature.
**AI:** Sonnet 4.6 for drafts/summaries/sentiment.

### 4.6 Automations / Workflow builder ⚙️
**New menu item:** `Automations`.
**What:** "When X, do Y" rules. _When a lead moves to Won → create a project, send a welcome
email, add onboarding to‑dos._ _When an invoice goes overdue → send a reminder + notify the
owner._ Start with a few presets; the AI can _suggest_ automations by watching repetitive
patterns.
**Why:** This is the "save time / automate tasks quicker" you asked for, made systematic. Every
hour of manual coordination it removes is recurring savings.

### 4.7 Knowledge Base / SOPs 📚
**New menu item:** `Knowledge` (or fold into Resources).
**What:** Internal docs, processes, brand guidelines, onboarding. AI Q&A over all of it
("what's our refund policy?", "how do we hand off a finished site?").
**Why:** Onboards new teammates fast and keeps delivery consistent. Reuses the search/RAG work
from §3.6 / §4.1.

### 4.8 Content Studio (for your social‑media clients) 🎨
**New menu item:** `Content`.
**What:** Since you sell social‑media marketing: an AI content calendar, caption/copy generation
per client brand voice, and image generation for posts. Schedule and track per client.
**Why:** Turns a service you _sell_ into a tool you _operate in_ — and a feature you could even
resell to clients.
**AI:** Claude for copy/captions/calendar; image generation via an image model.

### 4.9 Client Portal 2.0 🤝
**Upgrade** the existing public project page into a full branded portal: progress %, approvals,
file requests (you already have document requests!), messaging, and invoice viewing/payment.
**Why:** A polished client‑facing surface is the most visible "high‑end" upgrade — it's what your
clients see.

---

## 5. Suggested sequencing

A pragmatic order that front‑loads "wow" and quick wins:

1. **Wire up the AI engine** (§2) — one‑time, ~half a day.
2. **Receipt auto‑capture (§3.1)** + **Email drafting (§3.2)** — small, visible, instantly useful.
3. **Arc Copilot v1 (§4.1)** read‑only ("ask your workspace") — the flagship, even before it can _act_.
4. **CRM scoring (§3.3)** + **Meeting → actions (§3.4)** — daily‑driver automations.
5. **Proposals (§4.2)** + **Insights (§4.3)** — revenue + decision‑making.
6. **Automations (§4.6)** + **Copilot write‑actions** — the compounding time savers.
7. Time tracking, Inbox, Knowledge, Content, Portal 2.0 as you grow.

---

## 6. Quick‑reference matrix

| # | Feature | Type | AI? | Model | Rough effort | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 | Receipt auto‑capture | In‑module | ✅ vision | Haiku | S | High |
| 3.2 | Email drafting & reminders | In‑module | ✅ | Sonnet | S | High |
| 3.3 | CRM lead scoring | In‑module | ✅ | Haiku | S | High |
| 3.4 | Meeting → action items | In‑module | ✅ | Sonnet | S–M | High |
| 3.5 | Brief → task plan | In‑module | ✅ | Opus/Sonnet | M | Med |
| 3.6 | Semantic "ask your workspace" search | Upgrade | ✅ | Sonnet | M | High |
| 4.1 | **Arc Copilot** | New | ✅ tools | Opus | L | ⭐ Very high |
| 4.2 | Proposals & Quotes | New | ✅ | Opus | M–L | High |
| 4.3 | Analytics & Insights | New | ✅ narrative | Sonnet/Opus | M | High |
| 4.4 | Time Tracking | New | ◑ | Sonnet | M | Med–High |
| 4.5 | Communications Hub | New | ✅ | Sonnet | L | Med–High |
| 4.6 | Automations / Workflows | New | ◑ suggestions | Sonnet | M–L | High |
| 4.7 | Knowledge Base / SOPs | New | ✅ Q&A | Sonnet | M | Med |
| 4.8 | Content Studio | New | ✅ + images | Opus + image | L | Med (resellable) |
| 4.9 | Client Portal 2.0 | Upgrade | ◑ | — | M | High (visible) |

_Effort: S = small (≈1 day), M = medium (≈few days), L = large (≈1–2 weeks). AI: ✅ core, ◑ optional/assistive._

---

## 7. Notes & guardrails

- **Keep AI server‑side.** All Claude calls go through Server Actions / route handlers, like your
  existing service‑role usage. Never expose `ANTHROPIC_API_KEY` to the browser.
- **Confirm before acting.** Anything the Copilot or Automations do that writes data, sends email,
  or moves money should show a confirm step — it's a one‑way action.
- **Respect roles & RLS.** AI features must run under the same Supabase Row‑Level‑Security as the
  user — the Copilot should only see/do what that member is allowed to. Don't bypass RLS with the
  service‑role key for read queries on a user's behalf.
- **Start cheap, upgrade selectively.** Default new features to Haiku/Sonnet; reserve Opus 4.8 for
  the Copilot, Proposals, and forecasting where the extra intelligence pays off.

---

### Sources / research
- [CRM Software with AI Features 2026 — Capterra](https://www.capterra.com/resources/crm-software-with-ai-features-guide/)
- [Best AI CRM Software 2026 — TechnologyAdvice](https://technologyadvice.com/blog/crm/ai-crm/)
- [AI‑Powered CRM benefits & use cases — monday.com](https://monday.com/blog/crm-and-sales/crm-with-ai/)
- [AI project management tools 2026 — Productive.io](https://productive.io/blog/ai-project-management-tools/)
- [Best AI meeting note takers for sales 2026 — monday.com](https://monday.com/blog/crm-and-sales/crm-meeting-notes/)
- [AI meeting notetakers — Slack](https://slack.com/blog/productivity/ai-meeting-note-taker-how-it-works-and-features-to-look-for)
