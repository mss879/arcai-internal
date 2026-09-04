import { notFound } from "next/navigation";

import { INVOICE_COMPANY } from "@/lib/invoice";
import {
  buildPricing,
  defaultContent,
  defaultSelection,
  type ProposalBody,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";
import { createAdminClient } from "@/lib/supabase/admin";

import { PublicProposal, type PublicProposalView } from "./public-proposal";

export const metadata = { title: "Proposal — ARC AI" };

/** Flatten a section's typed body blocks into readable paragraphs. */
function sectionText(body: ProposalBody[]): string {
  const parts: string[] = [];
  for (const block of body ?? []) {
    if (block.kind === "prose") parts.push(...block.paragraphs);
    else if (block.kind === "bullets") parts.push(...block.items.map((i) => `· ${i}`));
    else if (block.kind === "groups") {
      for (const g of block.groups) {
        parts.push(g.heading);
        if (g.intro) parts.push(g.intro);
        parts.push(...g.items.map((i) => `· ${i}`));
      }
    } else if (block.kind === "steps") {
      parts.push(
        ...block.steps.map((s) =>
          s.description ? `${s.title} — ${s.description}` : s.title,
        ),
      );
    }
  }
  return parts.join("\n").trim();
}

/**
 * Public proposal page (0117). No auth — the unguessable token is the whole
 * credential, the same model as /q and the client portal.
 *
 * The row is read with hand-picked columns and turned into a client-safe view:
 * a proposal carries the internal selection it was priced from and, once
 * signed, the signature image and the signer's IP. None of that belongs on a
 * page anyone with the link can open.
 *
 * Marks the proposal viewed on first open, so "they have read it" is
 * something the team knows rather than guesses.
 */
export default async function ProposalPublicPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: proposal } = await supabase
    .from("proposals")
    .select(
      "id, client_name, project_name, proposal_date, selection, content, grand_total, currency, status, viewed_at, declined_reason, signed_name, lead_id",
    )
    .eq("share_token", token)
    .maybeSingle();
  if (!proposal) notFound();

  let status = proposal.status;

  // First open by the client: draft/sent → viewed.
  if (status === "sent" || status === "draft") {
    await supabase
      .from("proposals")
      .update({
        status: "viewed",
        viewed_at: proposal.viewed_at ?? new Date().toISOString(),
      })
      .eq("id", proposal.id);
    status = "viewed";
  }

  // Priced from the saved selection, never from grand_total alone — the same
  // function the PDF and the generator use, so the client sees the same
  // breakdown the document shows.
  const selection = {
    ...defaultSelection(),
    ...(proposal.selection as ProposalSelection),
  };
  const content = {
    ...defaultContent(),
    ...(proposal.content as ProposalContent),
  };

  // A section's body is a list of typed blocks (prose, bullets, groups…).
  // The PDF renders each kind properly; this page only needs the words, so
  // the blocks are flattened to text rather than half-rendered.
  const sections = (content.sections ?? [])
    .map((s) => ({ title: s.heading, body: sectionText(s.body) }))
    .filter((s) => s.title && s.body);

  const view: PublicProposalView = {
    token,
    projectName: proposal.project_name,
    clientName: proposal.client_name,
    proposalDate: proposal.proposal_date,
    currency: proposal.currency || "LKR",
    status,
    declinedReason: proposal.declined_reason,
    signedName: proposal.signed_name,
    pricing: buildPricing(selection),
    sections: sections.length
      ? sections
      : content.overview
        ? [{ title: "Overview", body: content.overview }]
        : [],
  };

  return <PublicProposal view={view} company={INVOICE_COMPANY} />;
}
