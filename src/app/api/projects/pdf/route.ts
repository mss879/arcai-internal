import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import type { ExportRow } from "@/lib/project-export";
import { renderProjectsReportPdf } from "@/lib/projects-report-pdf";

export const runtime = "nodejs";

/** A board can hold a lot of rows; a PDF request shouldn't be able to hold more. */
const MAX_ROWS = 500;

/**
 * Render the board to a branded PDF and stream it back (VIEW-5).
 *
 * The client posts the rows it currently has on screen, exactly like
 * /api/pricing/pdf does, so the file always matches the filters the person
 * pressing the button can see. Margin is re-checked here rather than trusted
 * from the body: it is admin-only (invariant 9), and a POST body is something
 * a member can edit.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { rows?: ExportRow[]; filterSummary?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  const isAdmin = profile.role === "admin";

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const pdf = await renderProjectsReportPdf({
    // A member's export must not carry margin even if the body says it should.
    rows: isAdmin
      ? rows
      : rows.map((r) => ({ ...r, marginPercent: null })),
    dateLabel,
    filterSummary:
      typeof body.filterSummary === "string" && body.filterSummary.trim()
        ? body.filterSummary.trim().slice(0, 200)
        : "All projects",
    includeMargin: isAdmin,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="ARC-AI-Projects-${new Date().toISOString().slice(0, 10)}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
