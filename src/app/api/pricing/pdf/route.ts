import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { renderPricingPdf } from "@/lib/pricing-pdf";
import type { PricingOverrides } from "@/lib/pricing-catalog";

export const runtime = "nodejs";

/**
 * Render the current pricing to a real PDF and stream it back as a file
 * download. The client posts the on-screen override map so the file always
 * matches what the team currently sees (edited or saved). Mirrors
 * /api/proposals/pdf.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { overrides?: PricingOverrides } = {};
  try {
    body = await request.json();
  } catch {
    // empty body -> render defaults
  }

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const pdf = await renderPricingPdf({
    overrides: body.overrides ?? {},
    dateLabel,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="ARC-AI-Pricing.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
