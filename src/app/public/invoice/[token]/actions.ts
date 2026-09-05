"use server";

import { headers } from "next/headers";

import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createSlip, MAX_SLIP_BYTES, slipMimeOk } from "@/lib/slips";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * The public invoice page's "I've paid" (0120).
 *
 * A server action is a public POST endpoint: the share token is re-resolved
 * here, the file is capped and typed, and the rate limit is per token AND
 * per connection. Nothing is paid by this — the slip joins the queue and a
 * finance person confirms it.
 */
export async function uploadPaymentSlip(
  token: string,
  formData: FormData,
): Promise<ActionResult> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { ok: false, error: "This link isn't valid." };

  const supabase = createAdminClient();
  const ip = clientIp(await headers());
  const [byToken, byIp] = await Promise.all([
    enforceRateLimit(supabase, `slip:${token}`, { limit: 5, windowSec: 3600 }),
    enforceRateLimit(supabase, `slip-ip:${ip}`, { limit: 20, windowSec: 3600 }),
  ]);
  if (!byToken.ok || !byIp.ok) {
    return { ok: false, error: "That's a lot at once — give it a little while and try again." };
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, status, project_id, client_id")
    .eq("share_token", token)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "This invoice link is no longer active." };
  if (invoice.status === "paid") return { ok: false, error: "This invoice is already paid — thank you!" };
  if (invoice.status === "void") return { ok: false, error: "This invoice has been withdrawn." };

  // One slip at a time per invoice: a second upload while one waits is
  // almost always the same slip again.
  const { count } = await supabase
    .from("payment_slips")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoice.id)
    .eq("status", "pending");
  if ((count ?? 0) > 0) {
    return { ok: false, error: "We already have a slip from you for this invoice — we'll confirm it shortly." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the slip first." };
  if (!slipMimeOk(file.type)) return { ok: false, error: "Send a photo (JPG, PNG) or a PDF of the slip." };
  if (file.size > MAX_SLIP_BYTES) return { ok: false, error: "That file is over 10MB — a screenshot is plenty." };
  const note = String(formData.get("note") ?? "").slice(0, 200);

  const res = await createSlip(supabase, {
    source: "public_invoice",
    file: { buffer: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name },
    invoiceId: invoice.id,
    projectId: invoice.project_id,
    clientId: invoice.client_id,
    note,
    ip,
  });
  if (!res.ok) return res;
  return { ok: true };
}
