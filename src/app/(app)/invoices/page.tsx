import { createClient } from "@/lib/supabase/server";

import { InvoicesView } from "./invoices-view";

export const metadata = { title: "Invoices" };

export default async function InvoicesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("*")
    .order("created_at", { ascending: false });

  return <InvoicesView pastInvoices={data ?? []} />;
}
