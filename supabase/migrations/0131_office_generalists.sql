-- ============================================================
-- 0131 — Content Office: two generalist agents
--
-- Nova and Atlas take one-off jobs handed to them directly — research a
-- company or topic, pull a brand from a website, find a client and draft
-- them a message — on the second-best model (gpt-5.6-sol), independent of
-- the Director's plans. The roster lives in code (src/lib/agents/roster.ts);
-- this only seeds their override rows so admins see them under Agents.
--
-- A drafted message is parked in `assistant_approvals` (0103/0115) for a
-- person to send from the Arcus tray — no new table, no new send path.
-- Additive and idempotent.
-- ============================================================

insert into public.office_agents (key, name, title, sort) values
  ('ops_a', 'Nova',  'Generalist', 8),
  ('ops_b', 'Atlas', 'Generalist', 9)
on conflict (key) do nothing;

insert into public.schema_migrations (version, note)
values ('0131_office_generalists', 'Content Office: Nova and Atlas, the two generalists')
on conflict (version) do nothing;
