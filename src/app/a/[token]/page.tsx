import { notFound } from "next/navigation";

import { AGREEMENT_COMPANY } from "@/lib/agreement-templates";
import { markdownToHtml } from "@/lib/markdown";
import { createAdminClient } from "@/lib/supabase/admin";

import { PublicAgreement } from "./public-agreement";

export const metadata = { title: "Agreement — ARC AI" };

/**
 * Public agreement page (0117). No auth — the unguessable token is the whole
 * credential, the same model as /q and /p.
 *
 * The body is rendered to HTML on the SERVER, through the escaping parser in
 * src/lib/markdown.ts. That is deliberate: the text is written by the team in
 * a textarea and lands on a public page, and a document somebody is about to
 * sign must not be able to contain a script or a link dressed up as
 * something else.
 */
export default async function AgreementPublicPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: agreement } = await supabase
    .from("agreements")
    .select(
      "id, kind, title, body_md, status, viewed_at, signed_name, signed_at, declined_reason, created_at, client_id",
    )
    .eq("share_token", token)
    .maybeSingle();
  if (!agreement) notFound();
  if (agreement.status === "void") notFound();

  let status = agreement.status;
  if (status === "sent" || status === "draft") {
    await supabase
      .from("agreements")
      .update({
        status: "viewed",
        viewed_at: agreement.viewed_at ?? new Date().toISOString(),
      })
      .eq("id", agreement.id);
    status = "viewed";
  }

  const client = agreement.client_id
    ? (
        await supabase
          .from("clients")
          .select("name")
          .eq("id", agreement.client_id)
          .maybeSingle()
      ).data
    : null;

  return (
    <PublicAgreement
      token={token}
      kind={agreement.kind}
      title={agreement.title}
      bodyHtml={markdownToHtml(agreement.body_md)}
      status={status}
      clientName={client?.name ?? ""}
      signedName={agreement.signed_name}
      signedAt={agreement.signed_at}
      declinedReason={agreement.declined_reason}
      date={agreement.created_at.slice(0, 10)}
      company={AGREEMENT_COMPANY}
    />
  );
}
