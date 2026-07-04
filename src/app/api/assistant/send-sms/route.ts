import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { SMS_MAX_LENGTH, countSmsSegments, normalizePhone } from "@/lib/sms-utils";

export const runtime = "nodejs";

/**
 * Send an SMS the assistant prepared. This is the ONLY path that actually
 * sends — it fires only when the user taps "Send" on the confirmation card,
 * after seeing the recipient and the exact message. The assistant model never
 * reaches this route, so nothing is texted without an explicit human action.
 * Every attempt is logged to sms_messages so it shows up in SMS → History.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    toNumber?: unknown;
    message?: unknown;
    clientId?: unknown;
    clientName?: unknown;
    kind?: unknown;
    invoiceId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const phone = normalizePhone(String(body?.toNumber ?? ""));
  if (!phone.ok) {
    return NextResponse.json({ ok: false, error: phone.error }, { status: 400 });
  }

  const message = String(body?.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ ok: false, error: "Message is empty." }, { status: 400 });
  }
  if (message.length > SMS_MAX_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `Message is too long (${message.length}/${SMS_MAX_LENGTH}).` },
      { status: 400 },
    );
  }

  const clientName = String(body?.clientName ?? "").trim();
  const kind = body?.kind === "payment_reminder" ? "payment_reminder" : "custom";

  const result = await sendSms({
    to: phone.value,
    message,
    contactName: clientName || undefined,
  });

  const supabase = await createClient();
  await supabase.from("sms_messages").insert({
    to_number: phone.value,
    message,
    client_id: typeof body?.clientId === "string" && body.clientId ? body.clientId : null,
    client_name: clientName,
    kind,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    invoice_id:
      typeof body?.invoiceId === "string" && body.invoiceId ? body.invoiceId : null,
    segments: countSmsSegments(message),
  });
  revalidatePath("/sms");

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error || "The SMS failed to send." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
