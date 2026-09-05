import type { TodoRecurrence } from "@/lib/database.types";

/**
 * When does a repeating to-do come back? (0119)
 *
 * The weekly and monthly jobs an agency runs on — invoice the retainers, post
 * the roundup, check the backups — lived in somebody's head, because a to-do
 * could only happen once. This is the arithmetic behind making them repeat.
 *
 * Pure and dependency-free, and worth testing rather than eyeballing: every
 * recurring-task bug is a date bug, and they are all invisible until the
 * wrong week.
 *
 * Two rules that are easy to get wrong and matter:
 *
 *   • The next occurrence is measured from the DUE DATE, not from when the
 *     task was ticked off. A weekly job done three days late is still due on
 *     the same weekday next week — otherwise a series drifts later and later
 *     until it lands on a different day entirely.
 *   • A monthly job due on the 31st falls back to the last day of a shorter
 *     month rather than skidding into the next one. The 31st of February is
 *     the 28th, not the 3rd of March.
 */

/** Days in a month, 1-indexed month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDaysUtc(iso: string, days: number): Date {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * The next due date after `from`, or null when the series has ended.
 *
 * `from` is the occurrence that has just been completed — its own due date,
 * as an ISO timestamp or date.
 */
export function nextOccurrence(
  recurrence: TodoRecurrence | null | undefined,
  from: string,
): string | null {
  if (!recurrence?.freq) return null;

  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return null;

  const interval = Math.max(1, Math.floor(Number(recurrence.interval) || 1));
  let next: Date;

  switch (recurrence.freq) {
    case "daily":
      next = addDaysUtc(from, interval);
      break;

    case "weekly": {
      const days = (recurrence.byweekday ?? [])
        .map((d) => Math.floor(Number(d)))
        .filter((d) => d >= 0 && d <= 6)
        .sort((a, b) => a - b);

      if (!days.length) {
        // No chosen days = the same weekday, `interval` weeks on.
        next = addDaysUtc(from, 7 * interval);
        break;
      }

      // The next chosen weekday later in the same week, if there is one.
      const current = start.getUTCDay();
      const later = days.find((d) => d > current);
      if (later !== undefined) {
        next = addDaysUtc(from, later - current);
        break;
      }
      // Otherwise the first chosen day, `interval` weeks on.
      next = addDaysUtc(from, 7 * interval - current + days[0]);
      break;
    }

    case "monthly": {
      const year = start.getUTCFullYear();
      const month = start.getUTCMonth(); // 0-indexed
      const day = start.getUTCDate();

      const targetMonth = month + interval;
      const targetYear = year + Math.floor(targetMonth / 12);
      const normalisedMonth = ((targetMonth % 12) + 12) % 12;

      // Clamp: the 31st of a 30-day month is the 30th, not the 1st.
      const maxDay = daysInMonth(targetYear, normalisedMonth + 1);
      next = new Date(start);
      next.setUTCFullYear(targetYear, normalisedMonth, Math.min(day, maxDay));
      break;
    }

    default:
      return null;
  }

  if (recurrence.until) {
    const until = new Date(recurrence.until);
    // `until` is inclusive of its own day, so compare dates rather than times.
    if (!Number.isNaN(until.getTime()) && next > endOfDay(until)) return null;
  }

  return next.toISOString();
}

function endOfDay(d: Date): Date {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/**
 * Catch a series up to now.
 *
 * A weekly to-do nobody touched for a month should not come back four times —
 * it should come back once, next week. This walks forward from the last due
 * date and returns only the next occurrence that is still in the future,
 * capped so a badly-configured daily series can't loop.
 */
export function catchUpOccurrence(
  recurrence: TodoRecurrence | null | undefined,
  lastDue: string,
  now: Date,
): string | null {
  let cursor = lastDue;
  for (let i = 0; i < 400; i++) {
    const next = nextOccurrence(recurrence, cursor);
    if (!next) return null;
    if (new Date(next) > now) return next;
    cursor = next;
  }
  return null;
}

/** "Every 2 weeks on Mon, Wed" — for the UI, and for a to-do's own subtitle. */
export function describeRecurrence(
  recurrence: TodoRecurrence | null | undefined,
): string | null {
  if (!recurrence?.freq) return null;
  const interval = Math.max(1, Math.floor(Number(recurrence.interval) || 1));
  const unit =
    recurrence.freq === "daily"
      ? "day"
      : recurrence.freq === "weekly"
        ? "week"
        : "month";
  const every = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;

  if (recurrence.freq === "weekly" && recurrence.byweekday?.length) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = [...recurrence.byweekday]
      .sort((a, b) => a - b)
      .map((d) => names[d])
      .filter(Boolean);
    if (days.length) return `${every} on ${days.join(", ")}`;
  }
  return every;
}
