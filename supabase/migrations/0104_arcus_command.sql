-- ============================================================
-- 0104_arcus_command.sql
--
-- THE COMMAND CENTER — Arcus stops being a chat box.
--
-- Four separate ideas land together because they are one
-- product change, and splitting them would leave the app in a
-- state where half of it compiles:
--
--   • PERSONA. `honorific` is the small word that changes the
--     whole register — "sir", "boss", "Dr. Silva", or empty for
--     the plain assistant it is today. `wake_ack` is what it
--     says the instant it hears its name, precached as audio so
--     the reply is immediate rather than a round trip. Default
--     'Yes, sir?' because that is the point of the exercise.
--
--   • AMBIENT. `ambient_stage` turns the idle screen into a
--     dashboard instead of a void — opt-in, because a screen
--     full of unrequested numbers reads as clutter. `ambient_voice` lets Arcus
--     SPEAK an event it thinks is urgent — off by default,
--     because an assistant that talks unprompted at the wrong
--     moment gets muted forever. `ambient_spoken_on/_count` are
--     its daily budget, deliberately separate from the push
--     `nudges_per_day`: a spoken word in the room and a
--     notification on a phone are not the same interruption and
--     must not share a quota.
--
--   • THE TERMINAL. `trusted_devices.is_terminal` marks ONE
--     machine as the workstation Arcus lives on: the one that
--     never idles out and always listens. This rides on
--     trusted_devices because that table already has a stable
--     server-side device identity (the sha256 of a 400-day
--     httpOnly cookie) and needs no new RLS — every write there
--     is service-role only by design (0079), so a member cannot
--     promote their own laptop.
--
--   • COORDINATES. Find Leads has always known WHERE a business
--     is and thrown it away — the Places field mask never asked
--     for `location`. Two columns so a scan can be seen on a map
--     instead of read as a list. Nullable forever: Firecrawl-
--     found candidates and every pre-0104 row have none.
--
-- Plus one constraint widening: the approvals tray was pinned
-- to the two things that could reach a client in 0103 (an email
-- and an SMS). Arcus can now start ENGINES — a campaign, a
-- research run, a recipe that arms a live sender — and those
-- need the same "stop and ask a human" lane rather than a new
-- one nobody watches.
-- ============================================================

-- 1. Persona + ambient preferences ---------------------------
-- assistant_config is the per-member singleton from 0101; its
-- own-rows RLS and updated_at trigger already cover these.
alter table public.assistant_config
  add column if not exists honorific     text not null default '',
  add column if not exists wake_ack      text not null default 'Yes, sir?',
  add column if not exists voice_engine  text not null default 'classic',
  add column if not exists ambient_stage boolean not null default false,
  add column if not exists ambient_voice boolean not null default false,
  -- The spoken budget, same CAS-stamp shape as nudges_sent_on/nudge_count.
  add column if not exists ambient_spoken_on    date,
  add column if not exists ambient_spoken_count int not null default 0;

-- 'classic' = whisper -> chat -> TTS (today). 'realtime' = the
-- WebRTC speech-to-speech session. Added separately so a re-run
-- against a database that already has the column does not fail
-- on a duplicate constraint name.
do $$
begin
  alter table public.assistant_config
    add constraint assistant_config_voice_engine_check
    check (voice_engine in ('classic', 'realtime'));
exception
  when duplicate_object then null;
end $$;

-- 2. The primary terminal ------------------------------------
-- No policy work: trusted_devices deliberately has no insert/
-- update/delete policies (0079), so this is service-role only.
alter table public.trusted_devices
  add column if not exists is_terminal boolean not null default false;

-- Partial index: the only question ever asked is "which of this
-- user's devices is the terminal", and it is at most one row.
create index if not exists trusted_devices_terminal_idx
  on public.trusted_devices (user_id) where is_terminal;

-- 3. Candidate coordinates -----------------------------------
-- double precision, not numeric: these are map pins, not money.
alter table public.prospect_candidates
  add column if not exists lat double precision,
  add column if not exists lng double precision;
-- The scan's own centre point rides in prospect_scans.analysis
-- (jsonb) alongside `funnel` — no DDL needed for it.

-- 4. The approvals tray learns engine kinds ------------------
-- 0103 pinned this to ('invoice_email','sms'). Widening rather
-- than replacing: both existing kinds keep working, and the
-- tray component renders whatever card it is handed.
alter table public.assistant_approvals
  drop constraint if exists assistant_approvals_kind_check;
alter table public.assistant_approvals
  add constraint assistant_approvals_kind_check
  check (kind in ('invoice_email', 'sms', 'campaign_launch', 'engine_start'));
