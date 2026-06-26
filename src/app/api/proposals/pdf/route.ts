import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { renderProposalPdf, type ProposalPdfData } from "@/lib/proposal-pdf";
import { defaultContent, defaultSelection } from "@/lib/proposal";

export const runtime = "nodejs";

/**
 * Render a proposal to a real PDF and stream it back as a file download
 * (Content-Disposition: attachment). Mirrors /api/invoices/pdf. Pricing is
 * recomputed inside the renderer from the selection, so the file always
 * matches the in-app preview.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<ProposalPdfData>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const data: ProposalPdfData = {
    client_name: String(body.client_name ?? ""),
    project_name: String(body.project_name ?? ""),
    proposal_date: String(body.proposal_date ?? ""),
    selection: { ...defaultSelection(), ...(body.selection ?? {}) },
    content: { ...defaultContent(), ...(body.content ?? {}) },
  };

  const pdf = await renderProposalPdf(data);

  const safeName =
    (data.client_name || "proposal").replace(/[^a-zA-Z0-9._-]/g, "") ||
    "proposal";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Proposal-${safeName}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
