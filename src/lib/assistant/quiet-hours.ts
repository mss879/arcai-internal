/**
 * Quiet hours — one evaluation, both sides of the wire (0104).
 *
 * The rule was born in `pulse.ts` for push nudges. The terminal's spoken
 * alerts need the SAME rule in the browser — two implementations of "is it
 * too late to bother them" WILL disagree at exactly 21:30 one night, and a
 * voice that pipes up during quiet hours gets the whole feature turned off.
 *
 * The original lived behind `server-only` and leaned on helpers from two
 * other server modules, so the pure parts are extracted here — framework-free
 * and dependency-free, importable from a tick or a component alike.
 * `pulse.ts` now imports this; behaviour is unchanged by construction, the
 * function bodies having moved verbatim.
 */

/** Minutes since local midnight in `timezone`, safe against bad zone names. */
export function localMinutesOfDay(timezone: string, at = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return h * 60 + (Number.isFinite(m) ? m : 0);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

function toMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "HH:MM" window that may wrap past midnight (21:30 → 07:30). */
export function inQuietHours(tz: string, start: string, end: string): boolean {
  const now = localMinutesOfDay(tz);
  const from = toMinutes(start, 21 * 60 + 30);
  const to = toMinutes(end, 7 * 60 + 30);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}
