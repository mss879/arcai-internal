import { describe, expect, it } from "vitest";

import { buildIcs, foldLine, icsDate, icsFilename } from "./ics";

const base = {
  uid: "meeting-1@arcai",
  sequence: 0,
  method: "REQUEST" as const,
  title: "Kickoff",
  startsAt: "2026-09-10T09:30:00.000Z",
  durationMinutes: 60,
  organizer: { name: "ARC AI", email: "support@arcai.agency" },
  stampedAt: "2026-09-05T12:00:00.000Z",
};

const lines = (ics: string) => ics.split("\r\n");
/** Undo RFC 5545 line folding, so assertions read the logical value. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("icsDate", () => {
  it("writes a UTC basic-format stamp", () => {
    expect(icsDate("2026-09-10T09:30:00.000Z")).toBe("20260910T093000Z");
  });

  it("converts a non-UTC input rather than copying its digits", () => {
    expect(icsDate("2026-09-10T15:00:00+05:30")).toBe("20260910T093000Z");
  });

  it("throws instead of emitting a broken file", () => {
    expect(() => icsDate("not a date")).toThrow();
  });
});

describe("buildIcs", () => {
  it("produces a complete VCALENDAR with CRLF endings", () => {
    const ics = buildIcs(base);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(lines(ics)).toContain("METHOD:REQUEST");
    expect(lines(ics)).toContain("UID:meeting-1@arcai");
  });

  it("derives DTEND from the duration", () => {
    const ics = buildIcs({ ...base, durationMinutes: 90 });
    expect(lines(ics)).toContain("DTSTART:20260910T093000Z");
    expect(lines(ics)).toContain("DTEND:20260910T110000Z");
  });

  it("marks a cancellation as CANCELLED, or the entry never leaves the calendar", () => {
    const ics = buildIcs({ ...base, method: "CANCEL", sequence: 2 });
    expect(lines(ics)).toContain("METHOD:CANCEL");
    expect(lines(ics)).toContain("STATUS:CANCELLED");
    expect(lines(ics)).toContain("SEQUENCE:2");
  });

  it("keeps the same UID across a reschedule so it updates rather than doubles", () => {
    const first = buildIcs(base);
    const moved = buildIcs({ ...base, sequence: 1, startsAt: "2026-09-11T09:30:00.000Z" });
    expect(lines(first)).toContain("UID:meeting-1@arcai");
    expect(lines(moved)).toContain("UID:meeting-1@arcai");
    expect(lines(moved)).toContain("SEQUENCE:1");
  });

  it("escapes commas, semicolons and newlines in text", () => {
    const ics = buildIcs({
      ...base,
      title: "Kickoff, part 2",
      description: "Bring the brief; and the deck\nThanks",
    });
    expect(lines(ics)).toContain("SUMMARY:Kickoff\\, part 2");
    // A real backslash before the semicolon — writing "\\;" here rather than
    // "\;", which JavaScript would collapse back to a bare semicolon and make
    // this assertion pass whether or not the escaping works.
    expect(unfold(ics)).toContain(
      "DESCRIPTION:Bring the brief\\; and the deck\\nThanks",
    );
  });

  it("lists attendees as RSVP-able participants", () => {
    const ics = buildIcs({
      ...base,
      attendees: [{ name: "Nimal Perera", email: "nimal@example.com" }],
    });
    // The line legitimately folds — compare the unfolded content.
    expect(unfold(ics)).toContain(
      "ATTENDEE;CN=Nimal Perera;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:nimal@example.com",
    );
  });

  it("never emits a line longer than 75 octets", () => {
    const ics = buildIcs({
      ...base,
      description: "x".repeat(400),
    });
    for (const line of lines(ics)) {
      expect(Buffer.from(line, "utf8").length).toBeLessThanOrEqual(75);
    }
  });

  it("negative sequences floor to zero rather than emitting garbage", () => {
    expect(lines(buildIcs({ ...base, sequence: -3 }))).toContain("SEQUENCE:0");
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Kickoff")).toBe("SUMMARY:Kickoff");
  });

  it("continues with a leading space", () => {
    const folded = foldLine("DESCRIPTION:" + "a".repeat(200));
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    // Sinhala is three bytes per character; a naive character-count fold
    // would cut one in half and produce invalid UTF-8.
    const folded = foldLine("DESCRIPTION:" + "ක".repeat(60));
    for (const line of folded.split("\r\n")) {
      expect(Buffer.from(line, "utf8").length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe("DESCRIPTION:" + "ක".repeat(60));
  });
});

describe("icsFilename", () => {
  it("makes a title safe for a filesystem", () => {
    expect(icsFilename("Kickoff: ARC AI / Aarah")).toBe("Kickoff-ARC-AI-Aarah.ics");
  });

  it("falls back rather than producing a dotfile", () => {
    expect(icsFilename("///")).toBe("meeting.ics");
  });
});
