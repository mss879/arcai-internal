# Careers

Hiring for www.arcai.agency, run from the CRM instead of from a database
console. Admin-only.

## Which way the data flows

**Vacancies: CRM → website.** You write a role in Careers, click Publish, and
it appears on the site's careers page. Edit a live role and it updates there
straight away. The CRM row is the original; `source_id` points at the
published copy.

**Applications: website → CRM.** Every application ever submitted is mirrored
in, every 15 minutes, and lands in a pipeline the website has no concept of —
stage, rating, notes, who is reviewing. Only `status` is ever written back.

## Setup

Run `supabase/migrations/0106_careers.sql` in the **CRM** project. It uses the
same website credentials Web Analytics already needs
(`WEBSITE_SUPABASE_URL`, `WEBSITE_SUPABASE_SERVICE_ROLE_KEY`), so there is
nothing new to configure.

Nothing is needed on the website side. Its `career_vacancies`,
`career_applications` tables and the `career-cvs` storage bucket already
exist and are unchanged — the careers page keeps reading them exactly as it
did.

## Two safety rules in the code

**A vacancy is never hard-deleted on the website.** The site's schema declares
`career_applications.vacancy_id ... on delete cascade`, so deleting a role
would silently destroy every application anyone ever submitted for it. Taking
a role down sets `is_active = false` and nothing else.

**Deleting a vacancy in the CRM is refused while it is live.** Otherwise the
website copy would be orphaned — still on the careers page, with nothing here
able to take it down. Unpublish first; it is one click and reversible.

## Assistant tools

`careers_overview`, `list_job_applications`, `draft_job_vacancy`,
`careers_sync_now`.

There is deliberately **no publish tool**. Putting a role on a public page is
an outward-facing change, and the difference between "draft this" and "post
this" is not one to leave to a model's reading of an ambiguous sentence. The
assistant can write the ad; a person clicks Publish.

The assistant also cannot edit an application. What a candidate submitted is a
record of what they said, not a field to be tidied.

## Stage mapping

The CRM's pipeline is richer than the website's `status` column, so stages
collapse on the way out:

| CRM stage | Website status |
| --- | --- |
| new | pending |
| screening, interview, offer | reviewing |
| hired | accepted |
| rejected, withdrawn | rejected |
