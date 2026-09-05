import { describe, expect, it } from "vitest";

import {
  catchUpOccurrence,
  describeRecurrence,
  nextOccurrence,
} from "./todo-recurrence";

const day = (iso: string) => nextOccurrence({ freq: "daily" }, iso)?.slice(0, 10);

describe("nextOccurrence — daily", () => {
  it("moves on a day", () => {
    expect(day("2026-09-05T09:00:00.000Z")).toBe("2026-09-06");
  });

  it("respects the interval", () => {
    expect(
      nextOccurrence({ freq: "daily", interval: 3 }, "2026-09-05T09:00:00.000Z")?.slice(0, 10),
    ).toBe("2026-09-08");
  });

  it("crosses a month end", () => {
    expect(day("2026-09-30T09:00:00.000Z")).toBe("2026-10-01");
  });
});

describe("nextOccurrence — weekly", () => {
  it("keeps the same weekday when no days are chosen", () => {
    // 2026-09-05 is a Saturday.
    const next = nextOccurrence({ freq: "weekly" }, "2026-09-05T09:00:00.000Z");
    expect(next?.slice(0, 10)).toBe("2026-09-12");
    expect(new Date(next!).getUTCDay()).toBe(6);
  });

  it("finds the next chosen day later in the same week", () => {
    // Saturday (6) with Mon/Wed chosen → the following Monday.
    const next = nextOccurrence(
      { freq: "weekly", byweekday: [1, 3] },
      "2026-09-07T09:00:00.000Z", // a Monday
    );
    expect(new Date(next!).getUTCDay()).toBe(3); // Wednesday
    expect(next?.slice(0, 10)).toBe("2026-09-09");
  });

  it("wraps to the first chosen day of the next week", () => {
    const next = nextOccurrence(
      { freq: "weekly", byweekday: [1, 3] },
      "2026-09-09T09:00:00.000Z", // Wednesday — the last chosen day
    );
    expect(new Date(next!).getUTCDay()).toBe(1); // Monday
    expect(next?.slice(0, 10)).toBe("2026-09-14");
  });

  it("ignores nonsense weekday numbers rather than throwing", () => {
    const next = nextOccurrence(
      { freq: "weekly", byweekday: [9, -1] },
      "2026-09-05T09:00:00.000Z",
    );
    expect(next?.slice(0, 10)).toBe("2026-09-12");
  });
});

describe("nextOccurrence — monthly", () => {
  it("keeps the day of the month", () => {
    expect(
      nextOccurrence({ freq: "monthly" }, "2026-09-15T09:00:00.000Z")?.slice(0, 10),
    ).toBe("2026-10-15");
  });

  it("clamps the 31st to the last day of a shorter month", () => {
    // The 31st of February is the 28th — never the 3rd of March.
    expect(
      nextOccurrence({ freq: "monthly" }, "2027-01-31T09:00:00.000Z")?.slice(0, 10),
    ).toBe("2027-02-28");
  });

  it("handles a leap February", () => {
    expect(
      nextOccurrence({ freq: "monthly" }, "2028-01-31T09:00:00.000Z")?.slice(0, 10),
    ).toBe("2028-02-29");
  });

  it("crosses a year boundary", () => {
    expect(
      nextOccurrence({ freq: "monthly", interval: 4 }, "2026-11-10T09:00:00.000Z")?.slice(0, 10),
    ).toBe("2027-03-10");
  });
});

describe("nextOccurrence — ending", () => {
  it("stops after `until`", () => {
    expect(
      nextOccurrence(
        { freq: "weekly", until: "2026-09-10" },
        "2026-09-05T09:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("includes an occurrence falling ON the until date", () => {
    expect(
      nextOccurrence(
        { freq: "daily", until: "2026-09-06" },
        "2026-09-05T09:00:00.000Z",
      )?.slice(0, 10),
    ).toBe("2026-09-06");
  });

  it("returns null with no recurrence at all", () => {
    expect(nextOccurrence(null, "2026-09-05T09:00:00.000Z")).toBeNull();
    expect(nextOccurrence(undefined, "2026-09-05T09:00:00.000Z")).toBeNull();
  });

  it("returns null rather than throwing on a bad date", () => {
    expect(nextOccurrence({ freq: "daily" }, "not a date")).toBeNull();
  });
});

describe("catchUpOccurrence", () => {
  it("comes back ONCE after a long gap, not four times", () => {
    // A weekly task nobody touched for a month is due next week, not four
    // times over — that would be a list of guilt, not a task.
    const next = catchUpOccurrence(
      { freq: "weekly" },
      "2026-08-01T09:00:00.000Z",
      new Date("2026-09-05T09:00:00.000Z"),
    );
    expect(next?.slice(0, 10)).toBe("2026-09-12");
  });

  it("gives the very next one when nothing was missed", () => {
    const next = catchUpOccurrence(
      { freq: "daily" },
      "2026-09-05T09:00:00.000Z",
      new Date("2026-09-05T10:00:00.000Z"),
    );
    expect(next?.slice(0, 10)).toBe("2026-09-06");
  });

  it("returns null once the series has ended", () => {
    expect(
      catchUpOccurrence(
        { freq: "weekly", until: "2026-08-20" },
        "2026-08-01T09:00:00.000Z",
        new Date("2026-09-05T09:00:00.000Z"),
      ),
    ).toBeNull();
  });
});

describe("describeRecurrence", () => {
  it("reads as English", () => {
    expect(describeRecurrence({ freq: "weekly" })).toBe("Every week");
    expect(describeRecurrence({ freq: "daily", interval: 3 })).toBe("Every 3 days");
    expect(describeRecurrence({ freq: "weekly", byweekday: [1, 3] })).toBe(
      "Every week on Mon, Wed",
    );
  });

  it("says nothing when it doesn't repeat", () => {
    expect(describeRecurrence(null)).toBeNull();
  });
});
