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

  const [invoicesRes, quotesRes, clientsRes, leadsRes, projectsRes] = await Promise.all([
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
    // 0112 — which accepted quotes already became a project.
    supabase
      .from("projects")
      .select("id, quote_id")
      .not("quote_id", "is", null)
      .is("deleted_at", null),
  ]);

  const projectsByQuote: Record<string, string> = {};
  for (const p of projectsRes.data ?? []) {
    if (p.quote_id && !projectsByQuote[p.quote_id]) projectsByQuote[p.quote_id] = p.id;
  }

  const initialTab =
    tab === "quotes" || tab === "past" || tab === "create" ? tab : "create";

  return (
    <InvoicesView
      pastInvoices={invoicesRes.data ?? []}
      quotes={(quotesRes.data ?? []) as Quote[]}
      clients={(clientsRes.data ?? []) as ClientLite[]}
      leads={(leadsRes.data ?? []) as LeadLite[]}
      projectsByQuote={projectsByQuote}
      initialTab={initialTab}
    />
  );
}
