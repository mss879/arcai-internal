import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { createWebsiteClient, isWebsiteSourceConfigured } from "@/lib/web-analytics/source";

type DB = SupabaseClient<Database>;

/**
 * Careers: the CRM as the control surface for the website's careers page.
 *
 * This module shares the website connection with `@/lib/web-analytics` but
 * NOT its read-only discipline — publishing a vacancy means writing to the
 * site's `career_vacancies` table. That is the whole point of the feature,
 * and it is kept in its own module precisely so the analytics one can keep
 * saying, truthfully, that it never writes.
 *
 * Everything it writes is scoped to two tables and one column:
 *
 *   career_vacancies    insert / update / archive — the published copy of a
 *                       role the CRM owns
 *   career_applications `status` only, when a stage change here should be
 *                       visible there. Never the candidate's own answers.
 *
 * A vacancy is NEVER hard-deleted on the website. The site's schema declares
 * `career_applications.vacancy_id ... on delete cascade`, so deleting a role
 * would silently destroy every application anyone ever submitted for it.
 * Taking a role down sets `is_active = false` and nothing else.
 */

const PAGE = 500;

export type CareersSyncResult = {
  ok: boolean;
  skipped?: string;
  vacanciesPulled: number;
  applicationsPulled: number;
  errors: string[];
};

const s = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const str = String(v).trim();
  return str ? str.slice(0, max) : null;
};

/** The CRM's vacancy shape, as the website's `career_vacancies` wants it. */
function toWebsiteVacancy(
  row: Database["public"]["Tables"]["careers_vacancies"]["Row"],
  isActive: boolean,
): Record<string, unknown> {
  return {
    title: row.title,
    department: row.department,
    location: row.location,
    // The website column is `type`; ours is `employment_type`. This is the
    // only place the two names meet.
    type: row.employment_type,
    description: row.description,
    requirements: row.requirements,
    is_active: isActive,
  };
}

// -- publishing --------------------------------------------------------------

/**
 * Push one vacancy to the website and record what happened.
 *
 * Insert on first publish, update by `source_id` afterwards, so republishing
 * an edited role changes the live row rather than adding a second copy of it.
 * A failure is written to the row as `status = 'failed'` with the reason,
 * because a publish that silently did nothing is the worst outcome here — the
 * role looks live in the CRM and is nowhere on the site.
 */
export async function publishVacancy(
  crm: DB,
  vacancyId: string,
  opts: { active?: boolean } = {},
): Promise<{ ok: true; sourceId: string } | { ok: false; error: string }> {
  if (!isWebsiteSourceConfigured()) {
    return {
      ok: false,
      error:
        "The website connection is not configured — set WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY.",
    };
  }

  const { data: row, error: readErr } = await crm
    .from("careers_vacancies")
    .select("*")
    .eq("id", vacancyId)
    .maybeSingle();
  if (readErr || !row) {
    return { ok: false, error: readErr?.message ?? "That vacancy no longer exists." };
  }
  if (!row.title.trim()) {
    return { ok: false, error: "A vacancy needs a title before it can go live." };
  }

  const isActive = opts.active ?? true;
  const site = createWebsiteClient();
  const payload = toWebsiteVacancy(row, isActive);

  try {
    let sourceId = row.source_id;

    if (sourceId) {
      const { error } = await site
        .from("career_vacancies")
        .update(payload)
        .eq("id", sourceId);
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await site
        .from("career_vacancies")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      sourceId = data.id as string;
    }

    const now = new Date().toISOString();
    await crm
      .from("careers_vacancies")
      .update({
        source_id: sourceId,
        status: isActive ? "published" : "archived",
        published_at: isActive ? (row.published_at ?? now) : row.published_at,
        unpublished_at: isActive ? null : now,
        sync_error: null,
        synced_at: now,
      })
      .eq("id", vacancyId);

    return { ok: true, sourceId: sourceId as string };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await crm
      .from("careers_vacancies")
      .update({ status: "failed", sync_error: message.slice(0, 1000) })
      .eq("id", vacancyId);
    return { ok: false, error: message };
  }
}

/**
 * Take a role off the site.
 *
 * `is_active = false`, never a delete — see the note at the top of this file
 * about the cascade that would take every application with it.
 */
export async function unpublishVacancy(
  crm: DB,
  vacancyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await publishVacancy(crm, vacancyId, { active: false });
  return result.ok ? { ok: true } : result;
}

/** Write a stage decision back to the website's own `status` column. */
export async function pushApplicationStatus(
  crm: DB,
  applicationId: string,
  websiteStatus: string,
): Promise<void> {
  if (!isWebsiteSourceConfigured()) return;

  const { data: row } = await crm
    .from("careers_applications")
    .select("source_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (!row?.source_id) return;

  try {
    const site = createWebsiteClient();
    await site
      .from("career_applications")
      .update({ status: websiteStatus })
      .eq("id", row.source_id);
    await crm
      .from("careers_applications")
      .update({ website_status: websiteStatus, synced_at: new Date().toISOString() })
      .eq("id", applicationId);
  } catch {
    // The CRM stage is the one the team works from; failing to mirror it to
    // the website is not worth failing the stage change over.
  }
}

// -- pulling -----------------------------------------------------------------

/**
 * Adopt vacancies that exist on the website but not here.
 *
 * Only ever runs once per role. After a vacancy is known to the CRM the CRM
 * is the original and the website copy is downstream, so pulling again would
 * overwrite an edit in progress with the older published text.
 */
async function pullVacancies(crm: DB, site: SupabaseClient): Promise<number> {
  const { data, error } = await site
    .from("career_vacancies")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(PAGE);
  if (error) {
    if (/does not exist|schema cache|PGRST205/i.test(error.message)) return 0;
    throw new Error(`career_vacancies: ${error.message}`);
  }
  if (!data?.length) return 0;

  const { data: known } = await crm
    .from("careers_vacancies")
    .select("source_id")
    .not("source_id", "is", null);
  const seen = new Set((known ?? []).map((r) => r.source_id));

  const fresh = (data as Record<string, unknown>[]).filter((r) => !seen.has(String(r.id)));
  if (!fresh.length) return 0;

  const { error: insErr } = await crm.from("careers_vacancies").insert(
    fresh.map((r) => ({
      source_id: String(r.id),
      title: s(r.title, 300) ?? "",
      department: s(r.department, 200) ?? "",
      location: s(r.location, 200) ?? "",
      employment_type: s(r.type, 80) ?? "Full-time",
      description: s(r.description, 20_000) ?? "",
      requirements: s(r.requirements, 20_000) ?? "",
      status: r.is_active ? "published" : "archived",
      published_at: s(r.created_at, 40),
      synced_at: new Date().toISOString(),
    })),
  );
  if (insErr) throw new Error(`career_vacancies insert: ${insErr.message}`);
  return fresh.length;
}

/**
 * Mirror every application in.
 *
 * Upsert on `source_id`, and deliberately NOT a blind overwrite: the CRM-side
 * workflow columns (stage, rating, notes, who is reviewing) are not in the
 * payload at all, so a re-pull refreshes what the candidate submitted without
 * resetting a review someone is halfway through.
 */
async function pullApplications(crm: DB, site: SupabaseClient): Promise<number> {
  const { data, error } = await site
    .from("career_applications")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) {
    if (/does not exist|schema cache|PGRST205/i.test(error.message)) return 0;
    throw new Error(`career_applications: ${error.message}`);
  }
  if (!data?.length) return 0;

  // Resolve each application's vacancy to the local row, so the board can
  // group by role without reaching across to the website on every render.
  const { data: vacancies } = await crm
    .from("careers_vacancies")
    .select("id, source_id, title");
  const bySource = new Map(
    (vacancies ?? [])
      .filter((v) => v.source_id)
      .map((v) => [v.source_id as string, { id: v.id, title: v.title }]),
  );

  const rows = (data as Record<string, unknown>[]).map((r) => {
    const vacancy = r.vacancy_id ? bySource.get(String(r.vacancy_id)) : undefined;
    return {
      source_id: String(r.id),
      vacancy_source_id: r.vacancy_id ? String(r.vacancy_id) : null,
      vacancy_id: vacancy?.id ?? null,
      vacancy_title: vacancy?.title ?? "(role no longer listed)",
      name: s(r.name, 200) ?? "",
      email: (s(r.email, 200) ?? "").toLowerCase(),
      phone: s(r.phone, 60) ?? "",
      personal_statement: s(r.personal_statement, 20_000) ?? "",
      earliest_start_date: s(r.earliest_start_date, 10),
      currently_employed: Boolean(r.currently_employed),
      cv_url: s(r.cv_url, 1000) ?? "",
      applied_at: s(r.created_at, 40) ?? new Date().toISOString(),
      website_status: s(r.status, 40) ?? "pending",
      synced_at: new Date().toISOString(),
    };
  });

  const { error: upErr } = await crm
    .from("careers_applications")
    .upsert(rows, { onConflict: "source_id" });
  if (upErr) throw new Error(`career_applications upsert: ${upErr.message}`);

  return rows.length;
}

/**
 * Pull both, vacancies first.
 *
 * Order matters: applications resolve their vacancy against what is already
 * in `careers_vacancies`, so a role adopted in the same run has to land
 * before the applications that point at it, or they all come out labelled
 * "role no longer listed".
 */
export async function syncCareers(crm: DB): Promise<CareersSyncResult> {
  if (!isWebsiteSourceConfigured()) {
    return {
      ok: false,
      skipped:
        "The website connection is not configured — set WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY.",
      vacanciesPulled: 0,
      applicationsPulled: 0,
      errors: [],
    };
  }

  const site = createWebsiteClient();
  const errors: string[] = [];
  let vacanciesPulled = 0;
  let applicationsPulled = 0;

  try {
    vacanciesPulled = await pullVacancies(crm, site);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    applicationsPulled = await pullApplications(crm, site);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const now = new Date().toISOString();
  await crm.from("web_sync_state").upsert(
    {
      stream: "careers",
      last_run_at: now,
      last_ok_at: errors.length ? undefined : now,
      last_error: errors.length ? errors.join(" · ").slice(0, 1000) : null,
      updated_at: now,
    },
    { onConflict: "stream" },
  );

  return {
    ok: errors.length === 0,
    vacanciesPulled,
    applicationsPulled,
    errors,
  };
}

/** How often the automation tick pulls applications. */
const MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The tick's entry point — self-gating and silent.
 *
 * Fifteen minutes rather than the hour the analytics pull uses: an
 * application is somebody waiting for a reply, and the difference between
 * hearing about it in fifteen minutes and in an hour is worth four times the
 * queries against a table that gets a handful of rows a week.
 */
export async function processCareers(crm: DB): Promise<CareersSyncResult | null> {
  if (!isWebsiteSourceConfigured()) return null;

  const { data } = await crm
    .from("web_sync_state")
    .select("last_run_at")
    .eq("stream", "careers")
    .maybeSingle();
  if (
    data?.last_run_at &&
    Date.now() - new Date(data.last_run_at).getTime() < MIN_INTERVAL_MS
  ) {
    return null;
  }

  return syncCareers(crm);
}
