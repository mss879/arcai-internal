// Netlify Scheduled Function — the WhatsApp agent's own cron.
//
// Deliberately separate from automation-tick. That one runs ~15 subsystems
// sequentially in a single invocation with no deadline, so a slow Lighthouse
// pass or a Gemini image render can eat the whole budget and starve whatever
// comes after it. Live customers must never be behind that queue: a warm lead
// from a Meta ad expects an answer in seconds, not whenever a carousel
// finishes rendering.
//
// So replying to customers gets its own function and its own full budget:
//   • queued inbound agent replies (the webhook only arms a debounced timer)
//   • promised follow-ups ("call me Monday")
//   • the autonomous follow-up cadence
//
// This is the ONE tick that stays at every minute — reply speed is the
// point of it — which is affordable because its idle path is three cheap
// lease queries. The automation and assistant ticks run far less often.
//
// Like automation-tick it only makes one lightweight HTTP call; the route
// does the work.

export const config = { schedule: "* * * * *" };

const handler = async () => {
  const base = (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    console.error(
      "[wa-agent-tick] No site URL — set NEXT_PUBLIC_APP_URL (Netlify also provides URL).",
    );
    return;
  }

  // Fail closed, matching the route: no secret, no tick. Header only —
  // a query param would put the secret in logs.
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (!secret) {
    console.error("[wa-agent-tick] SMS_CRON_SECRET unset — refusing to tick.");
    return;
  }

  try {
    const res = await fetch(`${base}/api/whatsapp/agent-tick`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      console.error(`[wa-agent-tick] tick returned ${res.status}`);
    }
  } catch (e) {
    console.error(
      `[wa-agent-tick] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export default handler;
