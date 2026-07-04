-- ============================================================
-- 0035_profile_phone.sql
-- Phone number on member profiles, used to send SMS alerts when
-- a member is assigned a task / lead or @mentioned anywhere.
-- Stored normalized to the Notify.lk format 94XXXXXXXXX.
-- Admins can already update any profile (policy in 0002_profiles.sql).
-- ============================================================

alter table public.profiles add column if not exists phone text;
