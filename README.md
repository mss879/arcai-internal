# ARC AI — Workspace

A modern, shared project-management workspace built with **Next.js 16**, **React 19**,
**Tailwind CSS v4**, **Supabase** and **Resend**.

## Features

- **Auth & invites** — login only (no public signup). The admin signs in at **`/admin`**;
  the admin sends an email invite link (Resend); the invited person opens it and sets their
  **own name + password**, then logs in. Accounts can only be created via an invite.
- **Dashboard** — greeting, stats, and a **calendar** that always shows to-do due dates.
- **Clients** — shared client directory.
- **To-Dos** — priority, assignment, due dates (calendar), and `@mentions` of teammates.
- **Projects** — planner with **payments** (upload receipts) and **commissions**
  (only an admin can allocate; each member sees their own on their profile).
- **Resources** — shared files (PDF / images) and links.
- **Meetings** — generate a public booking link (share on WhatsApp). Clients book a
  slot up to 2 weeks ahead, 9am–9pm by default. All links and bookings are saved.
- **CRM** — drag-and-drop pipelines, stages and leads (dnd-kit + Motion).
- **Team & Access** (admin only) — invite people, manage roles, see the member count.

## 1. Environment

Copy `.env.example` to `.env.local` and fill in the values:

```bash
cp .env.example .env.local
```

| Variable | What it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server only) |
| `RESEND_API_KEY` | Resend API key (for invite + credential emails) |
| `RESEND_FROM_EMAIL` | Verified sender, e.g. `ARC AI <noreply@yourdomain.com>` |
| `NEXT_PUBLIC_APP_URL` | Base URL used for invite + booking links |
| `NEXT_PUBLIC_ADMIN_EMAIL` | Pre-fills the first-run owner setup form |

The app boots without keys (you'll see a "configure me" screen) so you can run it before
Supabase is wired up.

## 2. Database

SQL migrations live in [`supabase/migrations`](./supabase/migrations), one file per
feature. Apply them to your Supabase project (in order) using whichever you prefer:

```bash
# Supabase CLI (linked project)
supabase db push

# or paste each file into the Supabase SQL editor, in numerical order
```

They create all tables, Row-Level-Security policies, the auth→profile trigger, and the
storage buckets (`avatars`, `resources` public; `receipts` private).

## 3. Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
```

## First-time setup

1. Apply the migrations and add your keys to `.env.local`.
2. **Create the admin** in **Supabase → Authentication → Users → Add user** using the
   email in `NEXT_PUBLIC_ADMIN_EMAIL` (set "Auto Confirm"). That email is granted the
   `admin` role automatically; a matching profile row is created on first login.
3. Go to **`/admin`**, log in, and you'll land on **Team & Access** (`/team`).
4. Invite people from there. Each gets an email link; they open it, enter their **name and
   a password**, and can then log in at **`/login`**.

> Members log in at `/login`; the admin logs in at `/admin`. There is no public signup —
> accounts are created only through invite links.

## Tech

Next.js 16 (App Router, Server Actions) · React 19 · Tailwind CSS v4 ·
Supabase (SSR auth + Storage) · Resend · Motion (Framer Motion) · dnd-kit · date-fns.
