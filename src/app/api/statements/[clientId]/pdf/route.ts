import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { buildClientStatement } from "@/lib/statement";
import { renderStatementPdf, statementFilename } from "@/lib/statement-pdf";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * A client's statement of account as a PDF, for the signed-in team (T4.6).
 *
 * GET, so the client page's "Download" is a plain link. The period comes
 * from the query (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, both optional) and the
 * figures are read fresh — a statement is never cached, because the money
 * moves under it. `?preview=1` serves it inline for an iframe.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { clientId } = await params;
  if (!isUuid(clientId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const from = isoDay(url.searchParams.get("from"));
  const to = isoDay(url.searchParams.get("to"));

  const supabase = await createClient();
  const statement = await buildClientStatement(supabase, clientId, { from, to });
  if (!statement) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const pdf = await renderStatementPdf(statement);
  const inline = url.searchParams.get("preview") === "1";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${statementFilename(statement)}"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}

function isoDay(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
