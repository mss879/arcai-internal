# Flooring Company System — Build & Automation Roadmap

> How to turn the ARC AI workspace into a high-end operating system for a flooring
> company. The short version: **you don't rebuild it — you reconfigure it.** Your CRM,
> automation engine, quoting, invoicing, booking, SMS and job-progress modules already
> cover ~90% of what a flooring business needs. This doc maps the flooring workflow onto
> what you already have, then lists the flooring-specific additions worth building.
>
> _Prepared: July 2026 • Based on the current ARC AI codebase (Next.js 16 / Supabase / Resend)_

---

## 1. The insight: this is a configuration job, not a rebuild

Your app was built generic on purpose. The pieces a flooring company runs on already exist:

| Flooring need | Already in ARC as… | New build or config? |
| --- | --- | --- |
| Track jobs from inquiry → install | CRM pipeline + Projects | **Config** (rename stages) |
| Custom data per lead (sq ft, floor type) | `crm_fields` (custom jsonb on leads) | **Config** (add fields) |
| Book a free in-home measure | Meetings (public booking links) | **Config** (rename, set hours) |
| Send a price estimate | Quotes / Proposals | **Config** + small quoting math |
| Deposit + final invoices | Invoices / Payments | Already works |
| Payment plans / post-dated cheques | `installment_due`, `cheque_due` triggers | Already works |
| Text the customer & crew | SMS module + automations | Already works |
| Track install progress for the client | Website-progress module | **Config** (relabel → Job Progress) |
| "When X happens, do Y" | Automations engine | **Config** (write the rules) |

So the plan below is mostly: set up fields, rename stages, and write ~8 automations. The
only real *code* additions are a **material rate card + quote calculator** and (optionally)
**photo-based estimating**.

---

## 2. Step 1 — Set up the flooring CRM (half a day, no code)

### 2.1 Pipeline stages
Replace the current agency stages with a flooring sales pipeline:

```
New Inquiry → Measure Scheduled → Measured & Quoted →
Quote Sent → Won (Job Booked) → Scheduled for Install →
Installed → Closed  (+ Lost / On Hold)
```

### 2.2 Custom lead fields (`crm_fields`)
Add these so every lead carries the data a flooring quote needs:

| Field | Kind | Options |
| --- | --- | --- |
| Flooring type | select | Hardwood, Engineered, Laminate, Vinyl / LVP, Tile, Carpet, Epoxy |
| Square footage | number | — |
| Rooms / areas | text | e.g. "Living + 2 bed + hallway" |
| Property type | select | Residential, Commercial |
| Subfloor condition | select | Good, Needs prep, Unknown |
| Measure date | date | — |
| Preferred install date | date | — |
| Address | text | — |
| Referral source | select | Google, Facebook, WhatsApp, Referral, Walk-in |

### 2.3 Tags & segments
Useful saved segments (`crm_segments`): *"Quoted, no reply in 5 days"*, *"Measure booked this
week"*, *"Commercial leads"*, *"Won — install not yet scheduled"*.

---

## 3. Step 2 — The flooring automations (the part you actually asked for)

Each of these is a `trigger → conditions → steps` rule in your existing engine. Start with
these eight; they cover the whole customer journey and remove the most manual follow-up.

### 3.1 Instant new-lead response ⚡
- **Trigger:** `lead_created` (or `form_submitted` from your website form).
- **Steps:** `send_sms` → *"Hi {{name}}, thanks for reaching out to [Company]! We'd love to
  book your free flooring measure. What day suits you?"* → `create_task` "Call to book measure"
  (due in 1 day, assigned to sales).
- **Why:** Speed-to-lead is the #1 predictor of who wins the job. Replying in seconds beats
  the competitor who calls back tomorrow.

### 3.2 Measure reminder (customer + crew) 📏
- **Trigger:** `date_reached` on **Measure date** (offset −1 day).
- **Steps:** `send_sms` to customer confirming tomorrow's appointment; `notify` the assigned
  estimator.
- **Why:** Cuts no-shows on site visits.

### 3.3 Quote follow-up 💬
- **Trigger:** `lead_inactive` (no activity 3 days) **AND** stage = *Quote Sent*.
- **Steps:** `send_sms` gentle nudge → `ai_agent` draft a tailored follow-up email → `create_task`
  "Personal follow-up call".
- **Why:** Most quotes are lost to silence, not to price. A structured nudge recovers them.

### 3.4 Quote accepted → spin up the job 🎉
- **Trigger:** `quote_accepted` (or stage moved to *Won*).
- **Steps:** `move_stage` → Won; create the **Project (job)**; `send_email` deposit invoice;
  `create_task`s: "Order materials", "Book install crew", "Confirm subfloor prep".
- **Why:** Closes the loop **Lead → Quote → Job → Invoice** automatically the moment they say yes.

### 3.5 Install reminder (customer + crew) 🔨
- **Trigger:** `date_reached` on **Preferred install date** (offset −1 day).
- **Steps:** `send_sms` customer ("Our crew arrives tomorrow 8–9am, please clear the rooms");
  `notify` the crew; optional `send_sms` to crew with address + job notes.
- **Why:** Fewer access problems and delays on install day.

### 3.6 Job done → get paid + get the review ⭐
- **Trigger:** stage moved to *Installed*.
- **Steps:** `send_email` final invoice; wait 2 days; `send_sms` review request with your Google
  review link; `add_tag` "Ask for referral".
- **Why:** Reviews are the lifeblood of home-services lead-gen; automating the ask multiplies them.

### 3.7 Payment plan / cheque reminders 💳
- **Trigger:** `installment_due` / `cheque_due` (X days before).
- **Steps:** `send_sms` reminder; `notify` the owner.
- **Why:** These triggers already exist in your engine — flooring jobs are big-ticket and often
  paid in stages, so this is a natural fit.

### 3.8 Maintenance / reactivation win-back 🔁
- **Trigger:** `date_reached` (e.g. 6–12 months after install, stored as a custom date).
- **Steps:** `send_sms`/`send_email`: *"Time for a refinish check on your hardwood?"* or a seasonal
  offer.
- **Why:** Turns a one-off customer into repeat + referral revenue at near-zero cost.

---

## 4. Step 3 — Flooring-specific features worth building

These are the few things that *aren't* already in the app. Ranked by payoff.

### 4.1 ⭐ Material rate card + quote calculator — **build this first**
**What:** A small catalog table (`material` name, unit, supply cost/sq ft, labor/sq ft, retail
rate) and a quote screen where the estimator picks a material, enters **square footage** (+ a
waste % and any prep/removal line items), and the total is calculated automatically in LKR.
Feeds straight into your existing Quotes/Proposals → public accept link → job.
**Why:** Flooring quoting is fundamentally *area × rate*; standardising it makes quotes fast,
consistent, and hard to under-price. This is the highest-value flooring-specific addition.
**Effort:** Medium — one table + a calculator UI reusing your quote/proposal pipeline.

### 4.2 Photo-assisted estimating 📸 (AI)
**What:** Customer uploads room photos on the inquiry form. Claude (vision) notes the space,
existing floor type, and visible prep needs, and drafts a rough scope for the estimator to
confirm on the real measure.
**Why:** Warmer, more specific first contact; better-prepared site visits.
**AI:** Haiku/Sonnet with vision, ~1 call per lead. (See the AI engine notes in
`AI-FEATURE-ROADMAP.md` §2 — same setup.)

### 4.3 AI quote & follow-up drafting ✍️
**What:** One-click "Draft quote email" / "Draft follow-up" that pulls the lead's floor type,
sq ft, rooms and price into your brand voice.
**Why:** Professional, consistent customer comms without the blank-page tax.
**AI:** Sonnet 4.6.

### 4.4 Lead scoring for flooring 🎯
**What:** Score leads hot/warm/cold from signals that matter here — large sq ft, commercial,
install date soon, replied fast, referral source.
**Why:** Your team calls the jobs most likely to close first.
**AI:** Haiku 4.5, nightly.

### 4.5 Crew / install scheduling view 🗓️
**What:** A calendar of booked installs by crew, so two jobs don't land on the same day/team.
Can start as a saved CRM segment + calendar before becoming its own module.
**Why:** Install capacity is the real constraint in a flooring business.

---

## 5. Suggested order

1. **Configure the CRM** — pipeline stages + custom fields + segments (§2). *Half a day, no code.*
2. **Write automations 3.1–3.6** — the customer-journey core (§3). *Config, high impact.*
3. **Build the rate card + quote calculator** (§4.1) — the one must-build feature.
4. **Turn on payment/cheque reminders** (§3.7) and **maintenance win-back** (§3.8).
5. **Layer in AI** — quote/follow-up drafting (§4.3), photo estimating (§4.2), lead scoring (§4.4).
6. **Crew scheduling view** (§4.5) as job volume grows.

---

## 6. What stays exactly as-is

Auth & invites, team/roles, Supabase RLS, invoices, payments, meetings/booking, SMS, the
automation engine, notifications/push, the public token-based accept/portal pattern — all
reusable without change. That's why this is a **reconfiguration**, not a new product.

## 7. Guardrails (unchanged from your AI roadmap)
- Keep all AI/API keys **server-side** (Server Actions / route handlers), like `SUPABASE_SERVICE_ROLE_KEY`.
- **Confirm before acting** on anything that sends money, texts, or emails a customer.
- Respect roles & RLS — automations run under the same permissions as the user.
