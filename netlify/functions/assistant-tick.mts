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
// So Arcus gets its own minute: the memory miner, the pulse, the nudges, the
// morning briefing, the mission driver and the janitor.
//
// One lightweight HTTP call to /api/assistant/tick, which does the work.

export const config = { schedule: "* * * * *" };

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

  const secret = process.env.SMS_CRON_SECRET?.trim();
  const url = `${base}/api/assistant/tick${
    secret ? `?secret=${encodeURIComponent(secret)}` : ""
  }`;

  try {
    const res = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
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
