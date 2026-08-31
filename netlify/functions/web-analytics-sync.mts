// Netlify Scheduled Function — the nightly website analytics pull.
//
// The every-minute automation tick already runs this pipeline hourly, so
// this is not what keeps the data fresh. It exists for the one job the
// hourly pass deliberately does not do: write the day's report, having
// first pulled a full day of settled data.
//
// 06:15 UTC, a little after the hourly pass at 06:00, so the two never
// contend for the same source connection.

export const config = { schedule: "15 6 * * *" };

const handler = async () => {
  const base = (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    console.error(
      "[web-analytics] No site URL — set NEXT_PUBLIC_APP_URL (Netlify also provides URL).",
    );
    return;
  }

  const secret = process.env.SMS_CRON_SECRET?.trim();
  const url = `${base}/api/web-analytics/sync?report=daily&chats=1${
    secret ? `&secret=${encodeURIComponent(secret)}` : ""
  }`;

  try {
    const res = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    if (!res.ok) {
      console.error(`[web-analytics] sync returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as { totalRows?: number; errors?: string[] };
    console.log(
      `[web-analytics] daily pull done — ${body.totalRows ?? 0} rows` +
        (body.errors?.length ? `, errors: ${body.errors.join("; ")}` : ""),
    );
  } catch (e) {
    console.error(
      `[web-analytics] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export default handler;
