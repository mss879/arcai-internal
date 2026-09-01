// Netlify Scheduled Function — the app's built-in cron.
//
// Runs every 5 minutes and pokes the automation tick so every timer fires
// even when nobody has the app open in a browser:
//   • CRM prospect-research reports (new leads → auto briefings)
//   • SMS drip / automation workflows
//   • finance reminders (installments, cheques)
//   • to-do deadline reminders
//
// Every 5 minutes, not every minute: everything inside the tick is either
// self-gated (analytics hourly, careers 15 min, the AI passes ~daily) or a
// queue that tolerates a few minutes of latency, and at one-a-minute the
// idle invocations alone were a real Netlify bill. Live WhatsApp replies —
// the one truly latency-sensitive job — have their own every-minute
// function (wa-agent-tick.mts).
//
// You do NOT need to set up any external cron service — Netlify runs this
// automatically on every deploy, on the schedule declared below.
//
// It only makes one lightweight HTTP call to /api/automation/tick (which
// does the actual work), so it comfortably fits a scheduled function's
// 30-second budget.

export const config = { schedule: "*/5 * * * *" };

const handler = async () => {
  const base = (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    console.error(
      "[scheduled-tick] No site URL — set NEXT_PUBLIC_APP_URL (Netlify also provides URL).",
    );
    return;
  }

  // Fail closed, matching the route: no secret, no tick. The secret travels
  // only in the Authorization header — a query param would put it in logs.
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (!secret) {
    console.error("[scheduled-tick] SMS_CRON_SECRET unset — refusing to tick.");
    return;
  }

  try {
    const res = await fetch(`${base}/api/automation/tick`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      console.error(`[scheduled-tick] tick returned ${res.status}`);
    }
  } catch (e) {
    console.error(
      `[scheduled-tick] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export default handler;
