/**
 * Calendar helpers for AI Projects (0126).
 *
 * Every "day" and "month" in this module is Asia/Colombo — the agency's own
 * calendar — so a visitor chatting at 23:30 Colombo on the 30th lands on that
 * month's bill and not the next one's. Web Analytics keeps UTC days; that is
 * a different feature with a different owner (the website's own clock), and
 * the two are documented as different on purpose.
 *
 * Pure: dates in, YYYY-MM-DD strings out, nothing read from the environment.
 * Day strings are compared as strings, which works because the format sorts.
 */

export const AI_TIME_ZONE = "Asia/Colombo";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: AI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const HOUR_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: AI_TIME_ZONE,
  hour: "numeric",
  hour12: false,
});

/** Today in Colombo, as YYYY-MM-DD. */
export function colomboDay(at: Date = new Date()): string {
  return DAY_FORMAT.format(at);
}

/** The Colombo hour of the day, 0–23. */
export function colomboHour(at: Date = new Date()): number {
  const h = Number(HOUR_FORMAT.format(at));
  return Number.isFinite(h) ? h % 24 : 0;
}

/** True for a well-formed YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The first day of the month a day belongs to. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The current Colombo month, as its first day. */
export function colomboPeriod(at: Date = new Date()): string {
  return monthStart(colomboDay(at));
}

function fromParts(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return fromParts(y ?? 1970, m ?? 1, (d ?? 1) + n);
}

export function addMonths(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  return fromParts(y ?? 1970, (m ?? 1) + n, 1);
}

export function previousPeriod(period: string): string {
  return addMonths(monthStart(period), -1);
}

export function nextPeriod(period: string): string {
  return addMonths(monthStart(period), 1);
}

/** The last day of a period. */
export function periodEnd(period: string): string {
  return addDays(nextPeriod(period), -1);
}

/** "September 2026" — the words on the invoice line. */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Every day from `from` to `to` inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let day = from;
  // Guard against a reversed range producing an infinite loop.
  for (let i = 0; i < 4000 && day <= to; i += 1) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

/** The day `n` days before `day`. */
export function daysAgo(day: string, n: number): string {
  return addDays(day, -n);
}

/** Midnight at the start of a Colombo day, as an ISO instant. Colombo has no
 * daylight saving, so the offset is a constant. */
export function colomboDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}
