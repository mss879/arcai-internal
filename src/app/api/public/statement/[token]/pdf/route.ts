import { NextResponse } from "next/server";

import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { buildClientStatement, clientIdForStatementToken } from "@/lib/statement";
import { renderStatementPdf, statementFilename } from "@/lib/statement-pdf";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The client's own copy of their statement, as a PDF (T4.6).
 *
 * Same model as the public invoice PDF: the token on `clients.statement_token`
 * (0117) is the whole credential, the route renders strictly what is stored
 * against it, and it is GET so it works from a link in a WhatsApp message —
 * which is exactly how it is sent (`sendWhatsAppDocument` fetches it).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const supabase = createAdminClient();

  // 0116 — a statement is several queries and a PDF render, billed per
  // invocation. By IP, so token enumeration is capped as well.
  const limit = await enforceRateLimit(
    supabase,
    `statement-pdf:${clientIp(request.headers)}`,
    { limit: 30, windowSec: 300 },
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const clientId = await clientIdForStatementToken(supabase, token);
  if (!clientId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const statement = await buildClientStatement(supabase, clientId, {
    from: isoDay(url.searchParams.get("from")),
    to: isoDay(url.searchParams.get("to")),
  });
  if (!statement) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const pdf = await renderStatementPdf(statement);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${statementFilename(statement)}"`,
      "Content-Length": String(pdf.length),
      // Unlike an invoice, a statement changes as money arrives.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function isoDay(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
