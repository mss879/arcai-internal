import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { CareerApplication, CareerVacancy } from "@/lib/types";
import { isWebsiteSourceConfigured, SITE_URL } from "@/lib/web-analytics/source";

import { CareersView } from "./careers-view";

export const metadata = { title: "Careers" };

/**
 * Hiring, run from the CRM.
 *
 * Admin-only: writing here changes a public web page, and every application
 * row is a named person's contact details, CV and salary expectations.
 */
export default async function CareersPage() {
  await requireAdmin();
  const supabase = await createClient();

  const [vacanciesRes, applicationsRes, syncRes] = await Promise.all([
    supabase
      .from("careers_vacancies")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("careers_applications")
      .select("*")
      .order("applied_at", { ascending: false })
      .limit(500),
    supabase
      .from("web_sync_state")
      .select("last_run_at, last_ok_at, last_error")
      .eq("stream", "careers")
      .maybeSingle(),
  ]);

  return (
    <CareersView
      vacancies={(vacanciesRes.data ?? []) as CareerVacancy[]}
      applications={(applicationsRes.data ?? []) as CareerApplication[]}
      lastSyncAt={syncRes.data?.last_run_at ?? null}
      syncError={syncRes.data?.last_error ?? null}
      careersUrl={`${SITE_URL}/careers`}
      sourceReady={isWebsiteSourceConfigured()}
    />
  );
}
