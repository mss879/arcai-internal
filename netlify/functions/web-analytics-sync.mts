// Netlify Scheduled Function — the twice-daily website analytics pull.
//
// 06:15 and 18:15 UTC. Each run starts a sync job and does the first
// bounded step of it; the automation tick (every five minutes) finishes
// whatever is left, so a job that needs several steps still completes
// within the half hour. The morning run also asks for the daily report and
// for the day's chat conversations to be labelled — the evening one pulls
// data only, so the paid model calls happen once a day, not twice.
//
// The tick would start a job on its own twelve hours after the last one
// finished; this schedule pins the two runs to fixed times instead of
// letting them drift, and is the thing that still fires if the tick's ring
// is busy.

export const config = { schedule: "15 6,18 * * *" };

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

  // Fail closed, matching the route: no secret, no pull. Header only —
  // a query param would put the secret in logs.
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (!secret) {
    console.error("[web-analytics] SMS_CRON_SECRET unset — refusing to run.");
    return;
  }

  const morning = new Date().getUTCHours() < 12;
  const query = morning ? "?report=daily&chats=1&budget=18000" : "?budget=18000";

  try {
    const res = await fetch(`${base}/api/web-analytics/sync${query}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      console.error(`[web-analytics] sync returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as {
      done?: boolean;
      totalRows?: number;
      errors?: string[];
      summary?: { phase?: string | null; days_left?: number };
    };
    console.log(
      `[web-analytics] ${morning ? "morning" : "evening"} pull — ${body.totalRows ?? 0} rows, ` +
        (body.done
          ? "job complete"
          : `continuing on the tick (phase ${body.summary?.phase ?? "?"}, ${body.summary?.days_left ?? 0} days queued)`) +
        (body.errors?.length ? `, errors: ${body.errors.join("; ")}` : ""),
    );
  } catch (e) {
    console.error(
      `[web-analytics] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export default handler;
