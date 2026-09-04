import { NextResponse } from "next/server";

import {
  defaultContent,
  defaultSelection,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";
import { renderProposalPdf } from "@/lib/proposal-pdf";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The client's own copy of their proposal, as a PDF (0117).
 *
 * Mirrors the public invoice route: a token and nothing else, rendering
 * strictly what is stored against it. The signed-in route at
 * /api/proposals/pdf takes a proposal in the request body, which is fine for
 * an authenticated teammate and wrong here — a client must only ever be able
 * to download the document they were sent, never one they describe.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const supabase = createAdminClient();

  // Rendering a PDF is the most expensive thing an anonymous caller can ask
  // for, and it is billed per invocation.
  const limit = await enforceRateLimit(
    supabase,
    `proposal-pdf:${clientIp(request.headers)}`,
    { limit: 30, windowSec: 300 },
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("client_name, project_name, proposal_date, selection, content")
    .eq("share_token", token)
    .maybeSingle();
  if (!proposal) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Defaults merged in, so a proposal saved before a section existed still
  // renders instead of throwing.
  const pdf = await renderProposalPdf({
    client_name: proposal.client_name,
    project_name: proposal.project_name,
    proposal_date: proposal.proposal_date,
    selection: {
      ...defaultSelection(),
      ...(proposal.selection as ProposalSelection),
    },
    content: { ...defaultContent(), ...(proposal.content as ProposalContent) },
  });

  const safe =
    (proposal.client_name || "proposal").replace(/[^a-zA-Z0-9._-]/g, "") || "proposal";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Proposal-${safe}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
