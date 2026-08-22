-- ============================================================
-- 0089_member_loan_approval.sql
--
-- LOAN APPROVAL — a loan now starts life as a request.
--
-- 0088 treated every loan as money already handed over. In
-- practice a member asks first, and the admin decides. So a loan
-- carries an `approval` of its own, separate from the repayment
-- `status` it already had:
--
--     approval  — pending → approved (or declined). Decides
--                 whether the money counts as gone.
--     status    — outstanding → repaid. Decides how much of it
--                 has come back. Maintained by 0088's trigger.
--
-- Only an APPROVED loan is deducted from commission. A pending
-- request sits on the member's profile as a request and changes
-- none of their numbers, which is what makes it safe to record
-- one the moment it's asked for.
--
-- Approving it texts the member on their profile number ("your
-- loan of Rs. X has been approved"). `approval_notified_at` is
-- what makes that exactly once — the message is stamped when it
-- goes out and cleared if the loan ever leaves the approved
-- state, so a re-approval later texts them again but a second
-- save never does.
--
-- Existing rows are backfilled to `approved`: they were already
-- suppressing commission, and that must not silently change.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

alter table public.member_loans
  add column if not exists approval             text not null default 'approved',
  add column if not exists approved_at          timestamptz,
  add column if not exists approved_by          uuid references public.profiles (id) on delete set null,
  add column if not exists approval_notified_at timestamptz;

alter table public.member_loans
  drop constraint if exists member_loans_approval_check;
alter table public.member_loans
  add constraint member_loans_approval_check
  check (approval in ('pending', 'approved', 'declined'));

comment on column public.member_loans.approval is
  'pending = asked for, decides nothing yet; approved = money handed over, deducted from commission until repaid; declined = on the record, never deducted. Separate from `status`, which tracks repayment.';
comment on column public.member_loans.approval_notified_at is
  'When the "your loan was approved" SMS went out. Set = never text them about this approval again; cleared whenever the loan leaves the approved state so a later re-approval does notify.';

-- Loans that predate this migration were live money — say so explicitly
-- rather than leaving their approval date blank.
update public.member_loans
   set approved_at = coalesce(approved_at, created_at)
 where approval = 'approved'
   and approved_at is null;

-- The lookup a commission balance makes: what has actually been handed over
-- and not yet come back. Replaces 0088's index, which didn't know about
-- approval and so would have pointed at pending requests too.
drop index if exists public.member_loans_open_idx;
create index if not exists member_loans_deducting_idx
  on public.member_loans (user_id)
  where approval = 'approved' and status = 'outstanding';

-- And the admin's "who's waiting on me" lookup.
create index if not exists member_loans_pending_idx
  on public.member_loans (user_id)
  where approval = 'pending';
