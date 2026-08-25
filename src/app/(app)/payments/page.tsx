import { PROJECT_MONEY_SELECT } from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";

import { PaymentsView } from "./payments-view";
import type { PaymentsProject } from "./project-money";

export const metadata = { title: "Payments" };

/**
 * The Payments page reads project money from the projects themselves.
 *
 * The board (`company_payments`) is a hand-maintained list — it is the only
 * home for money with no project behind it, so it stays. But "who owes us"
 * is a question only the projects can answer, and answering it needs the
 * SAME relations the Projects board selects: `payments` (the project's own
 * ledger) and `company_payments` (rows booked against it). PROJECT_MONEY_SELECT
 * names both, so this query cannot drift away from settledAmount() the way
 * the old `id, name, total_value, deposit_paid` select did.
 */
export default async function PaymentsPage() {
  const supabase = await createClient();

  const [paymentsRes, projectsRes] = await Promise.all([
    supabase
      .from("company_payments")
      // The project join is deliberately thin: it only names the project on a
      // board row (and survives archiving, which the projects query below
      // filters out). Every figure comes from the projects query.
      .select(
        "*, creator:profiles!company_payments_created_by_fkey(full_name, username, avatar_url), project:projects(id, name)",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select(
        `id, name, status, currency, due_date, created_at, total_value, deposit_paid, client:clients(id, name, company), ${PROJECT_MONEY_SELECT}`,
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <PaymentsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payments={(paymentsRes.data ?? []) as any}
      projects={
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (projectsRes.data ?? []) as any as PaymentsProject[]
      }
    />
  );
}
