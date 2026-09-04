/**
 * iCalendar (RFC 5545) invitations.
 *
 * A meeting saved in the CRM only existed in the CRM: the client got a text
 * with a time in it and had to type it into their own calendar, which is where
 * "they forgot" comes from. An `.ics` attachment puts it in Google Calendar,
 * Apple Calendar or Outlook with one tap, and — because it carries a stable
 * UID and a SEQUENCE — a reschedule updates that same entry instead of
 * creating a second one beside it.
 *
 * Pure and dependency-free: given the same meeting it always produces the same
 * bytes, so it can be tested directly. Three details in here are the kind that
 * are silently wrong until a real calendar rejects the file:
 *
 *   • Times are UTC with a trailing Z. No VTIMEZONE, no floating times.
 *   • Commas, semicolons, backslashes and newlines in text must be escaped, or
 *     a description containing "Bring the brief, please" truncates the field.
 *   • Lines fold at 75 octets with a leading space on continuations.
 */

export type IcsMethod = "REQUEST" | "CANCEL";

export type IcsEvent = {
  /** Stable across every version of this meeting. Usually the row id. */
  uid: string;
  /** Bumped on each reschedule so calendars treat the file as an update. */
  sequence: number;
  method: IcsMethod;
  title: string;
  description?: string | null;
  /** A venue, or the join link for an online meeting. */
  location?: string | null;
  /** ISO timestamp. */
  startsAt: string;
  durationMinutes: number;
  organizer: { name: string; email: string };
  attendees?: { name?: string | null; email: string }[];
  /** When this version was produced. Pass it in — this module is pure. */
  stampedAt: string;
  url?: string | null;
};

/** RFC 5545 escaping for TEXT values. Order matters: backslash first. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/** `20260905T143000Z`. Invalid dates throw rather than emit a broken file. */
export function icsDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Fold to 75 octets per line, continuations prefixed with one space.
 *
 * Counted in UTF-8 bytes, not characters: a description in Sinhala is three
 * bytes per character, and folding on character count would produce lines a
 * strict parser rejects. Never splits a multi-byte character.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off until `end` sits on a character boundary (10xxxxxx is a
    // continuation byte, so never cut immediately before one).
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return out.join("\r\n ");
}

/** Build the .ics body. Lines are CRLF-terminated, as the spec requires. */
export function buildIcs(event: IcsEvent): string {
  const start = new Date(event.startsAt);
  const end = new Date(start.getTime() + event.durationMinutes * 60_000);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ARC AI//Workspace//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${event.method}`,
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
    `DTSTAMP:${icsDate(event.stampedAt)}`,
    `DTSTART:${icsDate(start.toISOString())}`,
    `DTEND:${icsDate(end.toISOString())}`,
    `SUMMARY:${escapeText(event.title)}`,
    // A cancelled event must say so, or the entry stays in the calendar.
    `STATUS:${event.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `ORGANIZER;CN=${escapeText(event.organizer.name)}:mailto:${event.organizer.email}`,
  ];

  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.url) lines.push(`URL:${event.url}`);

  for (const a of event.attendees ?? []) {
    const cn = a.name ? `;CN=${escapeText(a.name)}` : "";
    lines.push(
      `ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** A filename a calendar app will accept. */
export function icsFilename(title: string): string {
  const safe = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "meeting"}.ics`;
}
