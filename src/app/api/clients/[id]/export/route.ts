import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { exportClientData } from "@/lib/client-erasure";
import { createClient } from "@/lib/supabase/server";
import { logSystemWrite } from "@/lib/system-audit";

export const runtime = "nodejs";

/**
 * Everything held about one client, as a zip (T5.7). Admin-only — this is
 * a person's whole record in one file — and logged, so a subject-access
 * request has a line saying it was answered.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const supabase = await createClient();
  const result = await exportClientData(supabase, id);
  if (!result) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await logSystemWrite(supabase, {
    job: "gdpr",
    actor: `user:${profile.id}`,
    table: "clients",
    rowId: id,
    action: "sent",
    summary: `Data export produced for client ${id}`,
    meta: { bytes: result.buffer.length },
  });

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.buffer.length),
      "Cache-Control": "no-store",
    },
  });
}
