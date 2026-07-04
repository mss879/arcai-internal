import { createClient } from "@/lib/supabase/server";
import type { Quote } from "@/lib/types";

import { InvoicesView } from "./invoices-view";
import type { ClientLite, LeadLite } from "./quotes-section";

export const metadata = { title: "Invoices & Quotes" };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [supabase, { tab }] = await Promise.all([createClient(), searchParams]);

  const [invoicesRes, quotesRes, clientsRes, leadsRes] = await Promise.all([
    supabase.from("invoices").select("*").order("created_at", { ascending: false }),
    supabase.from("quotes").select("*").order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company, email, phone").order("name"),
    supabase
      .from("leads")
      .select("id, title, contact_name, contact_email, contact_phone")
      .is("deleted_at", null)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const initialTab =
    tab === "quotes" || tab === "past" || tab === "create" ? tab : "create";

  return (
    <InvoicesView
      pastInvoices={invoicesRes.data ?? []}
      quotes={(quotesRes.data ?? []) as Quote[]}
      clients={(clientsRes.data ?? []) as ClientLite[]}
      leads={(leadsRes.data ?? []) as LeadLite[]}
      initialTab={initialTab}
    />
  );
}
