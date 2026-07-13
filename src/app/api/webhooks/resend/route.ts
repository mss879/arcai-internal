import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Resend webhook — flags a contact when an email we sent bounces or is marked
 * as spam, so the team knows to get a valid address before the next quote.
 *
 * Resend signs webhooks with Svix: headers svix-id / svix-timestamp /
 * svix-signature, HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the
 * base64 secret (RESEND_WEBHOOK_SECRET, "whsec_…" from the Resend dashboard).
 * Verified inline, mirroring verifyWaSignature in src/lib/whatsapp.ts.
 */

const TOLERANCE_MS = 5 * 60 * 1000; // reject stale timestamps (replay guard)

function verifySignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return false; // no secret configured → reject (fail closed)

  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TOLERANCE_MS) {
    return false;
  }

  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key)
      .update(`${id}.${ts}.${rawBody}`)
      .digest("base64");
    const expectedBuf = Buffer.from(expected);
    // Header is space-separated "v1,<sig>" pairs — any match passes.
    for (const part of sigHeader.split(" ")) {
      const sig = part.split(",")[1];
      if (!sig) continue;
      const given = Buffer.from(sig);
      if (given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function recipientsOf(data: Record<string, unknown>): string[] {
  const to = data.to;
  const arr = Array.isArray(to) ? to : to ? [to] : [];
  return arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const type = String(event.type ?? "");
  // Only care about hard-negative signals; ack everything else so Resend stops.
  if (type !== "email.bounced" && type !== "email.complained") {
    return NextResponse.json({ ok: true, ignored: type || "unknown" });
  }

  const recipients = recipientsOf(event.data ?? {});
  if (recipients.length === 0) return NextResponse.json({ ok: true, note: "no recipient" });

  const label =
    type === "email.complained"
      ? "marked our email as spam"
      : "bounced (undeliverable)";

  try {
    const supabase = createAdminClient();
    const { data: profiles } = await supabase.from("profiles").select("id");

    for (const email of recipients) {
      // Leave a trace on any matching CRM lead(s).
      const { data: leads } = await supabase
        .from("leads")
        .select("id")
        .ilike("contact_email", email)
        .order("created_at", { ascending: false })
        .limit(5);

      let link = "/crm";
      if (leads && leads.length > 0) {
        link = `/crm/lead/${leads[0].id}`;
        for (const lead of leads) {
          await supabase.from("lead_activities").insert({
            lead_id: lead.id,
            kind: "note",
            title: "✉️ Email bounced",
            body: `Our email to ${email} ${label}. Get a valid email before sending quotes or invoices.`,
            actor_id: null,
          });
        }
      }

      // Alert the whole team.
      const rows = (profiles ?? []).map((p) => ({
        user_id: p.id,
        type: "system" as const,
        title: "Email bounced",
        body: `${email} ${label} — the contact needs a valid email.`,
        link,
      }));
      if (rows.length > 0) await supabase.from("notifications").insert(rows);
    }
  } catch (e) {
    // Best-effort alerting — don't make Resend retry forever on our own error.
    console.error("[resend-webhook] handling failed:", e);
  }

  return NextResponse.json({ ok: true });
}
