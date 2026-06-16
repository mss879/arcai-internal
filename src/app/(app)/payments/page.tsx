import { createClient } from "@/lib/supabase/server";

import { PaymentsView } from "./payments-view";

export const metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("company_payments")
    .select(
      "*, creator:profiles!company_payments_created_by_fkey(full_name, username, avatar_url)",
    )
    .order("created_at", { ascending: false });

  return <PaymentsView payments={(data ?? []) as any} />;
}
