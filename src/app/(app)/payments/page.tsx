import { createClient } from "@/lib/supabase/server";

import { PaymentsView } from "./payments-view";

export const metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const supabase = await createClient();

  // Projects come along so a payment can be tied to the real project it
  // settles — that link is what makes a project's balance exact.
  const [paymentsRes, projectsRes] = await Promise.all([
    supabase
      .from("company_payments")
      .select(
        "*, creator:profiles!company_payments_created_by_fkey(full_name, username, avatar_url), project:projects(id, name, total_value, deposit_paid, currency)",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("id, name, total_value, deposit_paid, currency")
      .order("created_at", { ascending: false }),
  ]);

  return (
    <PaymentsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payments={(paymentsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any}
    />
  );
}
