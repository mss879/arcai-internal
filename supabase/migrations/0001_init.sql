-- ============================================================
-- 0001_init.sql
-- Extensions + generic helper functions
-- ============================================================

create extension if not exists "pgcrypto";

-- Generic trigger to maintain an updated_at column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
