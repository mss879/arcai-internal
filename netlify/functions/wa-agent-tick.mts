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

  const secret = process.env.SMS_CRON_SECRET?.trim();
  const url = `${base}/api/whatsapp/agent-tick${
    secret ? `?secret=${encodeURIComponent(secret)}` : ""
  }`;

  try {
    const res = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
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
