// Netlify Scheduled Function — the app's built-in cron.
//
// Runs every minute and pokes the automation tick so every timer fires
// even when nobody has the app open in a browser:
//   • CRM prospect-research reports (new leads → auto briefings)
//   • SMS drip / automation workflows
//   • finance reminders (installments, cheques)
//   • to-do deadline reminders
//
// You do NOT need to set up any external cron service — Netlify runs this
// automatically on every deploy, on the schedule declared below.
//
// It only makes one lightweight HTTP call to /api/automation/tick (which
// does the actual work), so it comfortably fits a scheduled function's
// 30-second budget.

export const config = { schedule: "* * * * *" };

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

  const secret = process.env.SMS_CRON_SECRET?.trim();
  const url = `${base}/api/automation/tick${
    secret ? `?secret=${encodeURIComponent(secret)}` : ""
  }`;

  try {
    const res = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
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
