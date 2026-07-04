import { createClient } from "@/lib/supabase/server";
import type { Company } from "@/lib/types";

import { CompaniesView } from "./companies-view";

export const metadata = { title: "Companies" };

export default async function CompaniesPage() {
  const supabase = await createClient();
  const [companiesRes, leadsRes] = await Promise.all([
    supabase.from("companies").select("*").order("name"),
    supabase
      .from("leads")
      .select("id, title, company_id, value, currency, status")
      .not("company_id", "is", null)
      .is("deleted_at", null),
  ]);

  return (
    <CompaniesView
      companies={(companiesRes.data ?? []) as Company[]}
      leads={
        (leadsRes.data ?? []) as {
          id: string;
          title: string;
          company_id: string | null;
          value: number | null;
          currency: string;
          status: string;
        }[]
      }
    />
  );
}
