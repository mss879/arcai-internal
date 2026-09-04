import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { AgreementsView, type AgreementRow } from "./agreements-view";

export const metadata = { title: "Agreements" };

export default async function AgreementsPage() {
  await requireProfile();
  const supabase = await createClient();

  const [agreementsRes, templatesRes, clientsRes] = await Promise.all([
    supabase
      .from("agreements")
      .select(
        "id, kind, title, body_md, status, share_token, client_id, project_id, signer_email, signed_name, signed_at, sent_at, pdf_path, created_at",
      )
      .neq("status", "void")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("agreement_templates")
      .select("id, name, kind, body_md")
      .order("name"),
    supabase.from("clients").select("id, name").order("name").limit(500),
  ]);

  const clientNames = new Map(
    (clientsRes.data ?? []).map((c) => [c.id, c.name] as const),
  );

  const rows: AgreementRow[] = (agreementsRes.data ?? []).map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    bodyMd: a.body_md,
    status: a.status,
    shareToken: a.share_token,
    clientId: a.client_id,
    clientName: a.client_id ? (clientNames.get(a.client_id) ?? null) : null,
    signerEmail: a.signer_email,
    signedName: a.signed_name,
    signedAt: a.signed_at,
    sentAt: a.sent_at,
    hasPdf: Boolean(a.pdf_path),
    createdAt: a.created_at,
  }));

  return (
    <AgreementsView
      agreements={rows}
      templates={templatesRes.data ?? []}
      clients={clientsRes.data ?? []}
    />
  );
}
