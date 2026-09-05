import { redirect } from "next/navigation";

import { appLink } from "@/lib/app-url";
import { currentClientId } from "@/lib/client-auth";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { balanceDue, settledAmount } from "@/lib/projects";
import { referralCodeFor, referralLink } from "@/lib/referrals";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  PortalHome,
  type PortalAgreement,
  type PortalFile,
  type PortalInvoice,
  type PortalMeeting,
  type PortalProject,
} from "./portal-home";

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
    .select("id, name, company, statement_token")
    .eq("id", clientId)
    .maybeSingle();
  // The client record was deleted while they held a session.
  if (!client) redirect("/portal/login");

  const [projectsRes, invoicesRes, quotesRes] = await Promise.all([
    supabase
      .from("projects")
      // Hand-picked. Nothing internal crosses this line.
      .select(
        "id, name, description, status, delivery_stage, delivery_stage_changed_at, start_date, due_date, currency, total_value, deposit_paid, share_token, portal_revoked_at, blocked_reason, payments(amount, status), company_payments(price_lkr, is_paid)",
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

  // 0117 — what they can download, sign and book, across every project.
  // Each read tolerates its table being absent (migration not yet applied)
  // by degrading to an empty section rather than a failed page.
  const projectRows = projectsRes.data ?? [];
  const projectIds = projectRows.map((p) => p.id);
  const [deliverablesRes, agreementsRes, meetingsRes, bookingRes, referralCode] =
    await Promise.all([
      projectIds.length
        ? supabase
            .from("project_deliverables")
            .select("id, project_id, title, file_path, version, created_at")
            .in("project_id", projectIds)
            .eq("visible_to_client", true)
            .order("created_at", { ascending: false })
            .limit(50)
            .then((r) => r, () => ({ data: null }))
        : Promise.resolve({ data: null }),
      supabase
        .from("agreements")
        .select("id, kind, title, status, share_token, signed_at")
        .eq("client_id", clientId)
        .in("status", ["sent", "viewed", "signed", "declined"])
        .order("created_at", { ascending: false })
        .limit(20)
        .then((r) => r, () => ({ data: null })),
      supabase
        .from("meetings")
        .select("id, title, meeting_at, duration_minutes, location, meeting_url")
        .eq("client_id", clientId)
        .gte("meeting_at", new Date().toISOString())
        .order("meeting_at", { ascending: true })
        .limit(10)
        .then((r) => r, () => ({ data: null })),
      supabase
        .from("meeting_links")
        .select("slug")
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
        .then((r) => r, () => ({ data: null })),
      referralCodeFor(supabase, clientId).catch(() => null),
    ]);

  // One Storage call for every file, not one each. Signed for an hour.
  const deliverableRows = deliverablesRes.data ?? [];
  const signedByPath = new Map<string, string>();
  if (deliverableRows.length) {
    const { data: signed } = await supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .createSignedUrls(
        deliverableRows.map((d) => d.file_path),
        3600,
      );
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) signedByPath.set(row.path, row.signedUrl);
    }
  }
  const projectNameById = new Map(projectRows.map((p) => [p.id, p.name] as const));

  // The calendar file is served by the share-token route, scoped to a project
  // this client owns — any live portal of theirs will do.
  const icsToken =
    projectRows.find((p) => p.share_token && !p.portal_revoked_at)?.share_token ?? null;

  const files: PortalFile[] = deliverableRows
    .filter((d) => signedByPath.has(d.file_path))
    .map((d) => ({
      id: d.id,
      title: d.title,
      url: signedByPath.get(d.file_path)!,
      version: d.version,
      project: projectNameById.get(d.project_id) ?? "Your project",
      createdAt: d.created_at,
    }));

  const agreements: PortalAgreement[] = (agreementsRes.data ?? []).map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    status: a.status,
    url: `/a/${a.share_token}`,
    signedAt: a.signed_at,
  }));

  const meetings: PortalMeeting[] = (meetingsRes.data ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    at: m.meeting_at,
    durationMinutes: m.duration_minutes,
    location: m.location,
    joinUrl: m.meeting_url,
    icsUrl: icsToken ? `/api/public/meeting/${icsToken}/ics?meeting=${m.id}` : null,
  }));

  const bookingUrl = bookingRes.data?.slug ? `/book/${bookingRes.data.slug}` : null;
  const referralUrl = referralCode ? referralLink(referralCode) : null;

  const projects: PortalProject[] = projectRows.map((row) => {
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
      files={files}
      agreements={agreements}
      meetings={meetings}
      bookingUrl={bookingUrl}
      referral={referralCode && referralUrl ? { code: referralCode, link: referralUrl } : null}
      // T4.6 — their statement of account, on the token that is theirs alone.
      statementUrl={client.statement_token ? `/public/statement/${client.statement_token}` : null}
      appUrl={appLink("") ?? ""}
    />
  );
}
