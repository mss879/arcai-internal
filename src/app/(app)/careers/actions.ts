"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import type { ActionResult, ApplicationStage } from "@/lib/types";
import {
  publishVacancy,
  pushApplicationStatus,
  syncCareers,
  unpublishVacancy,
} from "@/lib/careers/sync";

/**
 * Everything the Careers page can do.
 *
 * Admin-only throughout: a vacancy write reaches the public website, and an
 * application holds a named person's contact details, CV and salary
 * expectations. Neither belongs behind a members-only check.
 *
 * Publishing goes through the service-role client because it writes to the
 * WEBSITE's project, which the signed-in user's token has no rights on at
 * all. `requireAdmin` bounds it by who is asking.
 */

const VACANCY_FIELDS = [
  "title",
  "department",
  "location",
  "employment_type",
  "description",
  "requirements",
  "salary_range",
  "headcount",
  "internal_notes",
  "closes_on",
] as const;

type VacancyInput = Partial<Record<(typeof VACANCY_FIELDS)[number], string | number | null>>;

type VacancyPatch = Database["public"]["Tables"]["careers_vacancies"]["Update"];

function cleanVacancyInput(input: VacancyInput): VacancyPatch {
  const out: VacancyPatch = {};
  for (const key of VACANCY_FIELDS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === "headcount") {
      const n = Number(value);
      out.headcount = Number.isFinite(n) && n > 0 ? Math.min(99, Math.round(n)) : 1;
    } else if (key === "closes_on") {
      // An empty date input posts "" — a date column will not take it.
      out.closes_on = value ? String(value) : null;
    } else if (key === "salary_range" || key === "internal_notes") {
      // Nullable text: an empty box means "not set", not an empty string.
      const text = value === null || value === undefined ? "" : String(value).trim();
      out[key] = text || null;
    } else {
      // The rest are `not null default ''` — never write null into them.
      out[key] = value === null || value === undefined ? "" : String(value).trim();
    }
  }
  return out;
}

export async function createVacancy(
  input: VacancyInput,
): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const fields = cleanVacancyInput(input);
  if (!String(fields.title ?? "").trim()) {
    return { ok: false, error: "Give the role a title." };
  }

  const { data, error } = await supabase
    .from("careers_vacancies")
    .insert({ ...fields, created_by: user?.id ?? null, status: "draft" })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/careers");
  return { ok: true, id: data.id };
}

export async function updateVacancy(
  id: string,
  input: VacancyInput,
): Promise<ActionResult<{ republished: boolean }>> {
  await requireAdmin();
  const supabase = await createClient();

  const { error } = await supabase
    .from("careers_vacancies")
    .update(cleanVacancyInput(input))
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // A live role that is edited has to be pushed again, or the CRM and the
  // careers page quietly disagree about what the job says.
  const { data: row } = await supabase
    .from("careers_vacancies")
    .select("status")
    .eq("id", id)
    .maybeSingle();

  let republished = false;
  if (row?.status === "published") {
    const result = await publishVacancy(createAdminClient(), id, { active: true });
    if (!result.ok) return { ok: false, error: `Saved, but the site was not updated: ${result.error}` };
    republished = true;
  }

  revalidatePath("/careers");
  return { ok: true, republished };
}

/** Put the role on the website's careers page. */
export async function publish(id: string): Promise<ActionResult> {
  await requireAdmin();
  const result = await publishVacancy(createAdminClient(), id, { active: true });
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/careers");
  return { ok: true };
}

/** Take it down. Sets is_active=false on the site; never deletes. */
export async function unpublish(id: string): Promise<ActionResult> {
  await requireAdmin();
  const result = await unpublishVacancy(createAdminClient(), id);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/careers");
  return { ok: true };
}

/**
 * Delete a vacancy from the CRM.
 *
 * Refused while the role is live: the website copy would be orphaned and stay
 * on the careers page with nothing here to take it down again. Unpublish
 * first, which is one click and reversible.
 */
export async function deleteVacancy(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("careers_vacancies")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (row?.status === "published") {
    return {
      ok: false,
      error: "Take the role off the website first — deleting it here would leave it live there.",
    };
  }

  const { error } = await supabase.from("careers_vacancies").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/careers");
  return { ok: true };
}

/** Where a stage sits in the website's much simpler vocabulary. */
const WEBSITE_STATUS: Record<ApplicationStage, string> = {
  new: "pending",
  screening: "reviewing",
  interview: "reviewing",
  offer: "reviewing",
  hired: "accepted",
  rejected: "rejected",
  withdrawn: "rejected",
};

export async function setApplicationStage(
  id: string,
  stage: ApplicationStage,
  rejectedReason?: string,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();

  const { error } = await supabase
    .from("careers_applications")
    .update({
      stage,
      reviewed_at: new Date().toISOString(),
      rejected_reason: stage === "rejected" ? (rejectedReason ?? null) : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // Best-effort mirror to the website's own status column.
  await pushApplicationStatus(createAdminClient(), id, WEBSITE_STATUS[stage]);

  revalidatePath("/careers");
  return { ok: true };
}

export async function rateApplication(
  id: string,
  rating: number | null,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const clean =
    rating === null ? null : Math.min(5, Math.max(1, Math.round(Number(rating) || 0)));

  const { error } = await supabase
    .from("careers_applications")
    .update({ rating: clean })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/careers");
  return { ok: true };
}

export async function saveApplicationNotes(
  id: string,
  notes: string,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("careers_applications")
    .update({ notes: notes.slice(0, 10_000) })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/careers");
  return { ok: true };
}

/** Pull vacancies and applications from the website right now. */
export async function syncNow(): Promise<
  ActionResult<{ vacancies: number; applications: number; errors: string[] }>
> {
  await requireAdmin();
  const result = await syncCareers(createAdminClient());
  if (result.skipped) return { ok: false, error: result.skipped };
  revalidatePath("/careers");
  return {
    ok: true,
    vacancies: result.vacanciesPulled,
    applications: result.applicationsPulled,
    errors: result.errors,
  };
}
