import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { renderNoticePdf, type NoticePdfData } from "@/lib/notice-pdf";

export const runtime = "nodejs";

/**
 * Render a notice to a real PDF and stream it back as a file download
 * (Content-Disposition: attachment) — the notice twin of /api/invoices/pdf,
 * and what every "Download PDF" button on the notices page calls.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<NoticePdfData>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  if (!String(body.body ?? "").trim()) {
    return NextResponse.json(
      { error: "The notice has no message yet." },
      { status: 400 },
    );
  }

  const notice: NoticePdfData = {
    notice_number: String(body.notice_number ?? ""),
    notice_date: String(body.notice_date ?? ""),
    to_name: String(body.to_name ?? ""),
    to_details: String(body.to_details ?? ""),
    subject: String(body.subject ?? ""),
    body: String(body.body ?? ""),
  };

  const pdf = await renderNoticePdf(notice);

  // Strip characters that can't safely sit in a filename (e.g. the "#" prefix).
  const safeNumber =
    notice.notice_number.replace(/[^a-zA-Z0-9._-]/g, "") || "notice";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Notice-${safeNumber}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
