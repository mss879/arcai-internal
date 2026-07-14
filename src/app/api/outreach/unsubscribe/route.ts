import { createAdminClient } from "@/lib/supabase/admin";
import { suppressEmail, verifyUnsubscribe } from "@/lib/lead-outreach";

export const runtime = "nodejs";

/**
 * One-click unsubscribe for cold-outreach recipients (they're not logged in,
 * so this path is exempt from the auth middleware). The link carries the email
 * plus an HMAC token; a valid token adds the address to outreach_suppressions
 * so it's never emailed again. Always returns a friendly HTML page.
 */
function page(title: string, message: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:64px auto;background:#fff;border:1px solid #e9ecf5;border-radius:18px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#f97316,#c2410c);padding:24px 28px;color:#fff;font-size:18px;font-weight:700;">ARC AI</div>
    <div style="padding:28px;color:#0f172a;">
      <h1 style="margin:0 0 10px;font-size:19px;">${title}</h1>
      <p style="margin:0;color:#475569;font-size:15px;line-height:1.6;">${message}</p>
    </div>
  </div>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = (url.searchParams.get("e") ?? "").trim();
  const token = (url.searchParams.get("t") ?? "").trim();

  if (!email || !token || !verifyUnsubscribe(email, token)) {
    return page(
      "Invalid link",
      "This unsubscribe link looks invalid or has expired. If you keep hearing from us, just reply to the email and we'll remove you.",
    );
  }

  try {
    const supabase = createAdminClient();
    await suppressEmail(supabase, email, "unsubscribe");
  } catch (e) {
    console.error("[outreach] unsubscribe failed:", e);
    // Still show success — the token was valid; don't leak internal errors.
  }

  return page(
    "You're unsubscribed",
    `We won't email <strong>${email}</strong> again. Sorry for the interruption — thanks for letting us know.`,
  );
}
