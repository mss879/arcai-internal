import { redirect } from "next/navigation";

import { appLink } from "@/lib/app-url";
import { currentClientId } from "@/lib/client-auth";
import { balanceDue, settledAmount } from "@/lib/projects";
import { createAdminClient } from "@/lib/supabase/admin";

import { PortalHome, type PortalProject, type PortalInvoice } from "./portal-home";

export const metadata = { title: "Your projects · ARC AI" };

/**
 * One client, everything of theirs (BIG-1, 0099).
 *
 * The share-token portal shows ONE project to whoever holds a link. This
 * shows every project, invoice and quote belonging to the signed-in client —
 * and it knows who they are, so it can be a real account page.
 *
 * Invariant 6 applies with full force: this page never `select("*")` on a
 * project. Internal budget, cost expenses, margin, risk notes and the share
 * token all live on that row, and none of them are the client's business.
 */
export default async function PortalHomePage() {
  const clientId = await currentClientId();
  if (!clientId) redirect("/portal/login");

  const supabase = createAdminClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, company")
    .eq("id", clientId)
    .maybeSingle();
  // The client record was deleted while they held a session.
  if (!client) redirect("/portal/login");

  const [projectsRes, invoicesRes, quotesRes] = await Promise.all([
    supabase
      .from("projects")
      // Hand-picked. Nothing internal crosses this line.
      .select(
        "id, name, description, status, delivery_stage, delivery_stage_changed_at, start_date, due_date, currency, total_value, deposit_paid, share_token, blocked_reason, payments(amount, status), company_payments(price_lkr, is_paid)",
      )
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, invoice_number, invoice_date, grand_total, due_today, stamp, share_token")
      .in(
        "project_id",
        (
          await supabase
            .from("projects")
            .select("id")
            .eq("client_id", clientId)
            .is("deleted_at", null)
        ).data?.map((p) => p.id) ?? ["00000000-0000-0000-0000-000000000000"],
      )
      .order("invoice_date", { ascending: false })
      .limit(50),
    supabase
      .from("quotes")
      .select("id, quote_number, title, grand_total, currency, status, share_token, valid_until")
      .eq("client_id", clientId)
      .in("status", ["sent", "viewed", "accepted"])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const projects: PortalProject[] = (projectsRes.data ?? []).map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = row as any;
    const money = {
      total_value: p.total_value,
      deposit_paid: p.deposit_paid,
      payments: p.payments ?? [],
      company_payments: p.company_payments ?? [],
    };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      stage: p.delivery_stage,
      stageChangedAt: p.delivery_stage_changed_at,
      startDate: p.start_date,
      dueDate: p.due_date,
      currency: p.currency || "LKR",
      totalValue: Number(p.total_value) || 0,
      // LOOP-1 — the same definition of "received" the team sees. The portal
      // used to compute total − deposit and disagree with every other screen.
      received: settledAmount(money),
      balance: balanceDue(money),
      blocked: !!p.blocked_reason,
      // The token is the LINK, which the client already has; it is not a
      // secret from them. It is still never used to identify them.
      portalLink: p.share_token ? `/public/project/${p.share_token}` : null,
    };
  });

  const invoices: PortalInvoice[] = (invoicesRes.data ?? []).map((i) => ({
    id: i.id,
    number: i.invoice_number,
    date: i.invoice_date,
    total: Number(i.grand_total) || 0,
    due: Number(i.due_today) || 0,
    paid: i.stamp === "paid" || i.stamp === "deposit_paid",
    link: i.share_token ? `/public/invoice/${i.share_token}` : null,
  }));

  return (
    <PortalHome
      clientName={client.name}
      company={client.company}
      projects={projects}
      invoices={invoices}
      quotes={(quotesRes.data ?? []).map((q) => ({
        id: q.id,
        number: q.quote_number,
        title: q.title,
        total: Number(q.grand_total) || 0,
        currency: q.currency || "LKR",
        status: q.status,
        link: q.share_token ? `/q/${q.share_token}` : null,
        validUntil: q.valid_until,
      }))}
      appUrl={appLink("") ?? ""}
    />
  );
}
