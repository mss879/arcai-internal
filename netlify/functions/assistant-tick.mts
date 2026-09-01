// Netlify Scheduled Function — Arcus's own heartbeat (0103).
//
// A third scheduled function, for the same reason there is already a second
// one: latency isolation. The WhatsApp agent was split out of the main tick
// so a customer waiting for a reply could not be starved by a Lighthouse pass
// or an image render. Missions are the same shape of problem in the other
// direction — a mission step is a model call with tools, and running three of
// them inside the automation tick would push the twenty-odd timers that share
// that invocation towards the platform's ceiling.
//
// Every 30 minutes, not every minute: the pulse self-gates to 15 minutes,
// the briefing and the memory miner to once a day, the janitor to hours —
// a per-minute cron mostly paid to discover that every gate was shut. The
// only real trade is mission latency (a step advances ~each half hour),
// which is fine for errands nobody is watching in real time.
//
// One lightweight HTTP call to /api/assistant/tick, which does the work.

export const config = { schedule: "*/30 * * * *" };

const handler = async () => {
  const base = (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    console.error(
      "[assistant-tick] No site URL — set NEXT_PUBLIC_APP_URL (Netlify also provides URL).",
    );
    return;
  }

  // Fail closed, matching the route: no secret, no tick. Header only —
  // a query param would put the secret in logs.
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (!secret) {
    console.error("[assistant-tick] SMS_CRON_SECRET unset — refusing to tick.");
    return;
  }

  try {
    const res = await fetch(`${base}/api/assistant/tick`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      console.error(`[assistant-tick] tick returned ${res.status}`);
    }
  } catch (e) {
    console.error(
      `[assistant-tick] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export default handler;
