import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { renderAgreementPdf, type AgreementPdfData } from "@/lib/agreement-pdf";

export const runtime = "nodejs";

/**
 * Render an agreement to a real PDF. Mirrors /api/proposals/pdf exactly, and
 * for the same reason: the editor's preview IS this endpoint, so what the
 * writer sees is the file the client receives — page breaks and all — rather
 * than an HTML replica that drifts from it.
 *
 * `?preview=1` serves it inline for the <iframe>; the default is a download.
 * Unsigned by definition: the signature block prints as ruled lines until the
 * client signs on /a/[token], which is the only place a signature is made.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<AgreementPdfData>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const data: AgreementPdfData = {
    kind: String(body.kind ?? "contract"),
    title: String(body.title ?? "Agreement"),
    bodyMd: String(body.bodyMd ?? ""),
    clientName: body.clientName ? String(body.clientName) : null,
    date: String(body.date ?? new Date().toISOString().slice(0, 10)),
    // Never taken from the request: a draft is unsigned, and the only place a
    // signature is recorded is the client signing on /a/[token].
    signedName: null,
    signatureData: null,
    signedAt: null,
    signedIp: null,
  };

  const pdf = await renderAgreementPdf(data);

  const safeName =
    (data.title || "agreement").replace(/[^a-zA-Z0-9._-]/g, "") || "agreement";

  const inline = new URL(request.url).searchParams.get("preview") === "1";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
