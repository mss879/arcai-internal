-- ============================================================
-- 0114_search_dashboard_rollups.sql
--
-- SPEED — the reads the busiest pages make, done once in SQL.
--
--   1. SEARCH INDEXES. Global search runs leading-wildcard ILIKE
--      over nine tables; without trigram indexes every one is a
--      sequential scan. pg_trgm + GIN on exactly the columns the
--      search route filters.
--
--   2. DASHBOARD SUMMARY. The dashboard pulled every invoice,
--      every quote, every open lead and every project (with two
--      nested payment ledgers) to render a dozen numbers, on the
--      most-visited page in the app. dashboard_summary() returns
--      those numbers in one round-trip. The project balance uses
--      the SAME rule as settledAmount() in src/lib/projects.ts —
--      max(deposit_paid, own paid rows) + paid board payments —
--      and that is the one deliberate duplication of the money
--      maths; keep them in step.
--
--   3. PROJECT ROLLUPS. The projects board read six whole tables
--      (expenses, tasks, assets, milestones, members, commissions)
--      to derive per-card counts. project_rollups computes them
--      per project in one view. Cost totals are exposed SEPARATELY
--      (project ledger vs finance ledger) so the merge stays in
--      src/lib/project-costs.ts.
--
-- Everything is security invoker: callers see exactly what RLS
-- lets them see. Additive and idempotent.
-- ============================================================

-- 1. Search indexes ---------------------------------------------
create extension if not exists pg_trgm with schema extensions;

create index if not exists clients_name_trgm_idx     on public.clients   using gin (name extensions.gin_trgm_ops);
create index if not exists clients_company_trgm_idx  on public.clients   using gin (company extensions.gin_trgm_ops);
create index if not exists clients_email_trgm_idx    on public.clients   using gin (email extensions.gin_trgm_ops);
create index if not exists projects_name_trgm_idx    on public.projects  using gin (name extensions.gin_trgm_ops);
create index if not exists leads_title_trgm_idx      on public.leads     using gin (title extensions.gin_trgm_ops);
create index if not exists leads_company_trgm_idx    on public.leads     using gin (company extensions.gin_trgm_ops);
create index if not exists leads_contact_trgm_idx    on public.leads     using gin (contact_name extensions.gin_trgm_ops);
create index if not exists quotes_number_trgm_idx    on public.quotes    using gin (quote_number extensions.gin_trgm_ops);
create index if not exists quotes_customer_trgm_idx  on public.quotes    using gin (customer_name extensions.gin_trgm_ops);
create index if not exists quotes_title_trgm_idx     on public.quotes    using gin (title extensions.gin_trgm_ops);
create index if not exists invoices_number_trgm_idx  on public.invoices  using gin (invoice_number extensions.gin_trgm_ops);
create index if not exists invoices_billto_trgm_idx  on public.invoices  using gin (bill_to_name extensions.gin_trgm_ops);
create index if not exists proposals_client_trgm_idx on public.proposals using gin (client_name extensions.gin_trgm_ops);
create index if not exists proposals_project_trgm_idx on public.proposals using gin (project_name extensions.gin_trgm_ops);
create index if not exists todos_title_trgm_idx      on public.todos     using gin (title extensions.gin_trgm_ops);

-- 2. Dashboard summary ------------------------------------------
create or replace function public.dashboard_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with
  bounds as (
    select
      date_trunc('month', now())::date                       as this_month,
      (date_trunc('month', now()) - interval '1 month')::date as last_month,
      (date_trunc('month', now()) - interval '5 months')::date as trend_start
  ),
  inv as (
    select
      coalesce(sum(grand_total) filter (where invoice_date >= b.this_month), 0)                                   as revenue_this_month,
      coalesce(sum(grand_total) filter (where invoice_date >= b.last_month and invoice_date < b.this_month), 0)   as revenue_last_month,
      count(*)            filter (where stamp is distinct from 'payment_received')                                 as unpaid_count,
      coalesce(sum(grand_total) filter (where stamp is distinct from 'payment_received'), 0)                       as unpaid_total
    from public.invoices, bounds b
  ),
  trend as (
    select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'value', coalesce(t.value, 0)) order by m.month), '[]'::jsonb) as months
    from (
      select generate_series(b.trend_start, b.this_month, interval '1 month')::date as month from bounds b
    ) m
    left join (
      select date_trunc('month', invoice_date)::date as month, sum(grand_total) as value
      from public.invoices, bounds b
      where invoice_date >= b.trend_start
      group by 1
    ) t on t.month = m.month
  ),
  q as (
    select
      count(*)                     filter (where status in ('sent', 'viewed'))             as awaiting_count,
      coalesce(sum(grand_total)    filter (where status in ('sent', 'viewed')), 0)         as awaiting_total,
      count(*)                     filter (where status = 'accepted' and invoice_id is null) as accepted_uninvoiced_count
    from public.quotes
  ),
  l as (
    select
      coalesce(sum(value), 0) as pipeline_value,
      count(*) as open_count,
      count(*) filter (where expected_close_date is not null and expected_close_date < current_date) as overdue_count
    from public.leads
    where deleted_at is null and status = 'open'
  ),
  c as (
    select count(*) as clients_count from public.clients
  ),
  money as (
    select
      p.id,
      -- settledAmount(): max(deposit, own paid rows) + paid board payments.
      greatest(coalesce(p.deposit_paid, 0), coalesce(own.paid, 0)) + coalesce(linked.paid, 0) as received
    from public.projects p
    left join lateral (
      select sum(amount) as paid from public.payments where project_id = p.id and status = 'paid'
    ) own on true
    left join lateral (
      select sum(price_lkr) as paid from public.company_payments where project_id = p.id and is_paid
    ) linked on true
    where p.deleted_at is null
  ),
  projects as (
    select
      coalesce(sum(greatest(0, coalesce(p.total_value, 0) - m.received)), 0) as cash_outstanding,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'status', p.status,
        'delivery_stage', p.delivery_stage,
        'delivery_stage_changed_at', p.delivery_stage_changed_at,
        'updated_at', p.updated_at,
        'due_date', p.due_date,
        'blocked_since', p.blocked_since,
        'blocked_reason', p.blocked_reason,
        'balance', greatest(0, coalesce(p.total_value, 0) - m.received)
      )) filter (where p.status in ('planning', 'active', 'on_hold')), '[]'::jsonb) as open_projects
    from public.projects p
    join money m on m.id = p.id
    where p.deleted_at is null
  )
select jsonb_build_object(
  'revenue_this_month', inv.revenue_this_month,
  'revenue_last_month', inv.revenue_last_month,
  'trend', trend.months,
  'unpaid', jsonb_build_object('count', inv.unpaid_count, 'total', inv.unpaid_total),
  'awaiting_quotes', jsonb_build_object('count', q.awaiting_count, 'total', q.awaiting_total),
  'accepted_uninvoiced_count', q.accepted_uninvoiced_count,
  'pipeline', jsonb_build_object('value', l.pipeline_value, 'open_count', l.open_count, 'overdue_count', l.overdue_count),
  'clients_count', c.clients_count,
  'cash_outstanding', projects.cash_outstanding,
  'open_projects', projects.open_projects
)
from inv, trend, q, l, c, projects;
$$;

comment on function public.dashboard_summary() is
  'One round-trip for the dashboard KPIs. Project balance mirrors settledAmount() in src/lib/projects.ts — keep the two in step.';

-- 3. Project rollups --------------------------------------------
create or replace view public.project_rollups
with (security_invoker = true)
as
select
  p.id as project_id,
  coalesce(pe.billable_total, 0)   as billable_expenses_total,
  coalesce(pe.absorbed_total, 0)   as absorbed_expenses_total,
  coalesce(pe.unbilled_count, 0)   as unbilled_expense_count,
  coalesce(fx.total, 0)            as finance_costs_total,
  coalesce(t.open_count, 0)        as open_tasks,
  coalesce(t.overdue_count, 0)     as overdue_tasks,
  coalesce(a.pending_required, 0)  as pending_assets,
  coalesce(ms.total, 0)            as milestones_total,
  coalesce(ms.done, 0)             as milestones_done,
  coalesce(ms.visible_total, 0)    as visible_milestones_total,
  coalesce(ms.visible_done, 0)     as visible_milestones_done,
  coalesce(ms.overdue, 0)          as overdue_milestones,
  coalesce(mem.member_ids, '{}')   as member_ids,
  coalesce(mem.owner_id, null)     as owner_id
from public.projects p
left join lateral (
  select
    sum(amount) filter (where billable)      as billable_total,
    sum(amount) filter (where not billable)  as absorbed_total,
    count(*)    filter (where billable and invoiced_at is null) as unbilled_count
  from public.project_expenses e where e.project_id = p.id
) pe on true
left join lateral (
  select sum(amount) as total from public.expenses x where x.project_id = p.id
) fx on true
left join lateral (
  select
    count(*) filter (where status <> 'done') as open_count,
    count(*) filter (where status <> 'done' and due_date is not null and due_date < now()) as overdue_count
  from public.todos td where td.project_id = p.id
) t on true
left join lateral (
  select count(*) filter (where status = 'pending' and required) as pending_required
  from public.project_document_requests r where r.project_id = p.id
) a on true
left join lateral (
  select
    count(*) filter (where kind = 'milestone')                                         as total,
    count(*) filter (where kind = 'milestone' and status = 'done')                     as done,
    count(*) filter (where kind = 'milestone' and client_visible)                      as visible_total,
    count(*) filter (where kind = 'milestone' and client_visible and status = 'done')  as visible_done,
    count(*) filter (where status <> 'done' and due_date is not null and due_date < current_date) as overdue
  from public.project_milestones m where m.project_id = p.id
) ms on true
left join lateral (
  select
    array_agg(user_id order by is_owner desc, created_at) as member_ids,
    (array_agg(user_id) filter (where is_owner))[1]      as owner_id
  from public.project_members pm where pm.project_id = p.id
) mem on true
where p.deleted_at is null;

comment on view public.project_rollups is
  'Per-project counts and cost totals for the board (0114). Cost ledgers are separate columns on purpose — merge them in src/lib/project-costs.ts.';
