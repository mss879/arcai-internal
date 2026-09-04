-- ============================================================
-- 0113_merge_website_projects.sql
--
-- WEBSITE PROGRESS folds into PROJECTS.
--
-- 0026 gave the workspace a second tracker for the same job:
-- `website_projects` held a build's URL, a 0-100 progress number,
-- a waiting-on-client flag and a launch stamp, while `projects`
-- held everything else. 0092 let a row point at its project; the
-- two were never merged, so a website build could be updated in
-- one place and read in the other with neither noticing.
--
-- 0112 gave `projects` the columns that were only ever here
-- (preview_url, live_url, launched_at, progress_override,
-- blocked_reason for "waiting on client"). This migration moves
-- the data across and retires the tracker:
--
--   1. LINKED rows (project_id set) copy their url / progress /
--      launch stamp / notes onto the project — only into columns
--      that are still empty, so nothing the team wrote on the
--      project since is overwritten. Re-runnable.
--
--   2. UNLINKED rows each become a project of their own, so no
--      build disappears from the board. Guarded on
--      `project_id is null`, so a second run creates nothing.
--
--   3. The table is kept (deprecated) for rollback. Nothing in
--      the app writes to it after the code that ships with this
--      migration; /website-progress redirects to the projects
--      board filtered to website builds.
--
-- DRY RUN — how many projects step 2 will create:
--   select count(*) from public.website_projects where project_id is null;
--
-- Apply AFTER 0112 (it needs those columns) and BEFORE pushing the
-- code that removes the Website Progress page.
-- ============================================================

-- 1. Linked builds ----------------------------------------------
update public.projects p
set
  live_url = case
    when w.status = 'launched' then coalesce(p.live_url, nullif(trim(w.url), ''))
    else p.live_url
  end,
  preview_url = case
    when w.status <> 'launched' then coalesce(p.preview_url, nullif(trim(w.url), ''))
    else p.preview_url
  end,
  launched_at = case
    when w.status = 'launched' then coalesce(p.launched_at, w.launched_at, w.updated_at)
    else p.launched_at
  end,
  -- The only numeric progress the schema ever had; a launched build is 100
  -- by the stage anyway, so it is only carried for builds still in flight.
  progress_override = case
    when w.status <> 'launched' then coalesce(p.progress_override, nullif(w.progress, 0))
    else p.progress_override
  end,
  description = coalesce(nullif(trim(p.description), ''), nullif(trim(w.notes), '')),
  blocked_reason = case
    when w.status = 'waiting_client' and p.blocked_reason is null
      then 'Waiting on the client (from Website Progress)'
    else p.blocked_reason
  end,
  blocked_since = case
    when w.status = 'waiting_client' and p.blocked_reason is null
      then coalesce(p.blocked_since, w.updated_at)
    else p.blocked_since
  end
from public.website_projects w
where w.project_id = p.id;

-- 2. Unlinked builds become projects -----------------------------
do $$
declare
  r record;
  pid uuid;
begin
  for r in
    select * from public.website_projects where project_id is null
  loop
    insert into public.projects (
      name, client_id, status, delivery_stage, delivery_stage_changed_at,
      service_type, description, preview_url, live_url, launched_at,
      progress_override, blocked_reason, blocked_since, currency,
      created_by, created_at, start_date
    ) values (
      coalesce(nullif(trim(r.name), ''), 'Website build'),
      r.client_id,
      case when r.status = 'launched' then 'completed' else 'active' end,
      case when r.status = 'launched' then 'delivered' else 'build' end,
      coalesce(r.launched_at, r.updated_at, now()),
      'business_website',
      nullif(trim(r.notes), ''),
      case when r.status <> 'launched' then nullif(trim(r.url), '') end,
      case when r.status = 'launched' then nullif(trim(r.url), '') end,
      case when r.status = 'launched' then coalesce(r.launched_at, r.updated_at) end,
      case when r.status <> 'launched' then nullif(r.progress, 0) end,
      case when r.status = 'waiting_client' then 'Waiting on the client (from Website Progress)' end,
      case when r.status = 'waiting_client' then r.updated_at end,
      'LKR',
      r.created_by,
      r.created_at,
      r.created_at::date
    )
    returning id into pid;

    update public.website_projects set project_id = pid where id = r.id;
  end loop;
end $$;

-- 3. Retire the tracker ------------------------------------------
comment on table public.website_projects is
  'DEPRECATED (0113) — merged into projects (preview_url, live_url, launched_at, progress_override, blocked_reason). Kept for rollback; nothing writes here. /website-progress redirects to /projects?service=website.';
