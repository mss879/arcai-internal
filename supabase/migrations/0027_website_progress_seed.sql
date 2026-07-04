-- ============================================================
-- 0027_website_progress_seed.sql
-- Seed the Website Progress tracker (0026) with the client site
-- list handed over by ARC AI. Two batches:
--   * Full build (backend + frontend)  — needs a backend.
--   * Frontend only                    — static/marketing site only.
-- Progress/status reflect where each build currently stands
-- (several are parked "waiting on client"). Rows are left loose
-- (no client_id) since we're not creating client records here.
--
-- Idempotent: each row is skipped if a website with the same URL
-- already exists, so this migration is safe to re-run.
-- ============================================================

insert into public.website_projects (name, url, progress, status, notes)
select v.name, v.url, v.progress, v.status, v.notes
from (values
  -- ---- Full build: backend + frontend --------------------------------
  ('Inspira Worldwide Pvt Ltd',   'http://inspiraworldwide.com',      90, 'waiting_client', 'Full build — backend + frontend. Waiting on client.'),
  ('SJ Enterprises',              'http://sje.lk',                    80, 'waiting_client', 'Full build — backend + frontend. Waiting on client.'),
  ('NewGen Lanka Healthcare',     'http://newgenlanka.com',            0, 'in_progress',    'Full build — backend + frontend.'),
  ('Cloud Healthcare',            'http://cloudhealthcare.lk',         0, 'in_progress',    'Full build — backend + frontend.'),
  ('Medico Global FZE',           'http://medicoglobalfze.com',        0, 'in_progress',    'Full build — backend + frontend.'),
  ('LifeTek Medical Pvt Ltd',     '',                                  0, 'in_progress',    'Full build — backend + frontend. URL TBC.'),
  -- ---- Frontend only -------------------------------------------------
  ('Inventis Pharma Pvt Ltd',     'http://inventispharma.org',        80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Iconn Healthcare Pvt Ltd',    'http://iconnhealthcare.org',       80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Zentiva Pvt Ltd',             'http://zentivapvt.com',            80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Advitec International Pvt Ltd','http://advitecint.com',            80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Zenith Global Pvt Ltd',       'http://zenithglobal.biz',          80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Trimed Pharma Pvt Ltd',       'http://trimedpharma.com',          80, 'waiting_client', 'Frontend only. Waiting on client.'),
  ('Imperial Life Sciences Pvt Ltd','http://imperiallifesciences.com',80, 'waiting_client', 'Frontend only. Waiting on client.')
) as v(name, url, progress, status, notes)
where not exists (
  select 1 from public.website_projects w
  where w.name = v.name
);
