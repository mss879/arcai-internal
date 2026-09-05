import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { AgreementsView, type AgreementRow } from "./agreements-view";

export const metadata = { title: "Agreements" };

/**
 * `?new=1&project=…&client=…&proposal=…&title=…` opens the editor with those
 * links already made — how a project's Client tab and a proposal row raise
 * one without anybody re-finding the client in a picker.
 */
export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    new?: string;
    client?: string;
    project?: string;
    proposal?: string;
    title?: string;
  }>;
}) {
  await requireProfile();
  const supabase = await createClient();
  const params = await searchParams;
  const prefill =
    params.new === "1"
      ? {
          clientId: params.client || null,
          projectId: params.project || null,
          proposalId: params.proposal || null,
          title: params.title?.slice(0, 160) || null,
        }
      : null;

  const [agreementsRes, templatesRes, clientsRes] = await Promise.all([
    supabase
      .from("agreements")
      .select(
        "id, kind, title, body_md, status, share_token, client_id, project_id, proposal_id, signer_email, signed_name, signed_at, sent_at, pdf_path, created_at",
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
    projectId: a.project_id,
    proposalId: a.proposal_id,
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
      prefill={prefill}
    />
  );
}
