import { describe, expect, it } from "vitest";

import {
  MAX_KILLED_STEPS,
  advance,
  beginStep,
  chatCursorAfter,
  coerceState,
  daysInWindow,
  dedupeById,
  emptyState,
  endStep,
  finishJob,
  isDue,
  leaseIsFree,
  mergeRequest,
  nextPhase,
  nudgeCursor,
  openJob,
  summarise,
} from "./job-core";

const NOW = "2026-09-06T12:00:00.000Z";

describe("the schedule", () => {
  it("is due immediately when nothing has ever run", () => {
    expect(isDue(emptyState(), NOW)).toBe(true);
  });

  it("is not due while a job is active, whatever the clock says", () => {
    const state = { ...emptyState(), job: openJob({}, NOW) };
    expect(isDue(state, "2030-01-01T00:00:00.000Z")).toBe(false);
  });

  it("becomes due exactly one interval after the last job finished", () => {
    const job = openJob({}, NOW);
    const done = finishJob(emptyState(), { ...job, phase: "done" }, NOW, 12 * 3_600_000);
    expect(done.job).toBeNull();
    expect(done.next_due_at).toBe("2026-09-07T00:00:00.000Z");
    expect(isDue(done, "2026-09-06T23:59:59.000Z")).toBe(false);
    expect(isDue(done, "2026-09-07T00:00:00.000Z")).toBe(true);
  });

  it("records the finished job with its counters and outcome", () => {
    const job = { ...openJob({}, NOW), rows: 12, days_done: 3, chats: 2, errors: ["x"] };
    const state = finishJob(emptyState(), job, NOW, 1);
    expect(state.last).toMatchObject({ rows: 12, days: 3, chats: 2, ok: false, errors: ["x"] });
  });
});

describe("the lease", () => {
  it("is free when unset or expired, held until then", () => {
    expect(leaseIsFree(emptyState(), NOW)).toBe(true);
    expect(leaseIsFree({ ...emptyState(), lease_until: "2026-09-06T11:59:59.000Z" }, NOW)).toBe(true);
    expect(leaseIsFree({ ...emptyState(), lease_until: "2026-09-06T12:00:01.000Z" }, NOW)).toBe(false);
  });
});

describe("phases", () => {
  it("skips the optional phases nobody asked for", () => {
    const plain = openJob({}, NOW);
    expect(nextPhase(plain)).toBe("rollup");
    expect(nextPhase({ ...plain, phase: "rollup" })).toBe("done");
  });

  it("visits chats and report when they were requested", () => {
    const job = openJob({ report: "daily", analyse_chats: true }, NOW);
    expect(nextPhase({ ...job, phase: "rollup" })).toBe("chats");
    expect(nextPhase({ ...job, phase: "chats" })).toBe("report");
    expect(nextPhase({ ...job, phase: "report" })).toBe("done");
  });

  it("goes straight from rollup to report when only a report was asked for", () => {
    const job = openJob({ report: "weekly" }, NOW);
    expect(nextPhase({ ...job, phase: "rollup" })).toBe("report");
  });

  it("advancing resets the kill counter", () => {
    const job = { ...openJob({}, NOW), killed: 2 };
    expect(advance(job)).toMatchObject({ phase: "rollup", killed: 0 });
  });
});

describe("a killed step", () => {
  it("counts up before the work and back to zero after it", () => {
    const job = openJob({}, NOW);
    const begun = beginStep(job).job;
    expect(begun.killed).toBe(1);
    expect(begun.steps).toBe(1);
    expect(endStep(begun).killed).toBe(0);
  });

  it("abandons the phase after three steps in a row died", () => {
    let job = openJob({}, NOW);
    for (let i = 0; i < MAX_KILLED_STEPS; i++) job = beginStep(job).job; // never ended
    expect(job.killed).toBe(MAX_KILLED_STEPS);
    const { job: next, abandonedPhase } = beginStep(job);
    expect(abandonedPhase).toBe("sync");
    expect(next.phase).toBe("rollup");
    expect(next.killed).toBe(1);
    expect(next.errors[0]).toMatch(/sync: abandoned after 3 steps/);
  });
});

describe("requests", () => {
  it("folds a report into a job that has not reached the report yet", () => {
    const job = { ...openJob({}, NOW), phase: "rollup" as const };
    const { job: merged, consumed } = mergeRequest(job, { report: "daily", analyse_chats: true });
    expect(consumed).toBe(true);
    expect(merged.report).toBe("daily");
    expect(merged.analyse_chats).toBe(true);
  });

  it("leaves a request pending when the job is already past what it asks for", () => {
    const job = { ...openJob({ report: "daily" }, NOW), phase: "report" as const };
    const { consumed } = mergeRequest(job, { analyse_chats: true });
    expect(consumed).toBe(false);
  });

  it("opens a rebuild with its window queued for the rollup", () => {
    const job = openJob({}, NOW, { rebuild: { days: ["2026-09-06", "2026-09-05"] } });
    expect(job.rebuild).toBe(true);
    expect(job.pending_days).toEqual(["2026-09-06", "2026-09-05"]);
    expect(openJob({}, NOW).pending_days).toBeNull();
  });
});

describe("cursors", () => {
  it("only nudges past a FULL page of tied timestamps", () => {
    const t = "2026-09-06T10:00:00.000Z";
    expect(nudgeCursor(t, t, false)).toBe(t);
    expect(nudgeCursor(t, t, true)).toBe("2026-09-06T10:00:00.001Z");
    expect(nudgeCursor("2026-09-06T11:00:00.000Z", t, true)).toBe("2026-09-06T11:00:00.000Z");
  });

  it("drops the row a >= cursor read twice across a page boundary", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "b" }, { id: "c" }];
    expect(dedupeById(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("moves the chat cursor to the first conversation it did not reach", () => {
    const firstAt = new Map([
      ["s1", "2026-09-01T00:00:00.000Z"],
      ["s2", "2026-09-02T00:00:00.000Z"],
      ["s3", "2026-09-03T00:00:00.000Z"],
    ]);
    const partial = chatCursorAfter({
      since: "2026-08-01T00:00:00.000Z",
      order: ["s1", "s2", "s3"],
      firstAt,
      processed: 2,
      lastCreatedAt: "2026-09-05T00:00:00.000Z",
      pageFull: true,
    });
    expect(partial).toEqual({ since: "2026-09-03T00:00:00.000Z", exhausted: false });

    const whole = chatCursorAfter({
      since: "2026-08-01T00:00:00.000Z",
      order: ["s1", "s2", "s3"],
      firstAt,
      processed: 3,
      lastCreatedAt: "2026-09-05T00:00:00.000Z",
      pageFull: false,
    });
    expect(whole).toEqual({ since: "2026-09-05T00:00:00.000Z", exhausted: true });
  });

  it("never moves the chat cursor backwards", () => {
    const out = chatCursorAfter({
      since: "2026-09-04T00:00:00.000Z",
      order: ["s1", "s2"],
      firstAt: new Map([["s1", "2026-09-04T00:00:00.000Z"], ["s2", "2026-09-03T00:00:00.000Z"]]),
      processed: 1,
      lastCreatedAt: "2026-09-05T00:00:00.000Z",
      pageFull: true,
    });
    expect(out.since).toBe("2026-09-04T00:00:00.000Z");
  });
});

describe("windows and state", () => {
  it("lists UTC days newest first and caps the window", () => {
    const days = daysInWindow(3, new Date("2026-09-06T23:30:00.000Z"));
    expect(days).toEqual(["2026-09-06", "2026-09-05", "2026-09-04"]);
    expect(daysInWindow(1000, new Date(NOW), 5)).toHaveLength(5);
  });

  it("reads back a partial or garbled row as a usable state", () => {
    expect(coerceState(null)).toEqual(emptyState());
    expect(coerceState({ version: "7", job: { phase: "nowhere" } }).job).toBeNull();
    const ok = coerceState({ version: 2, job: { phase: "rollup", started_at: NOW, sync_started_at: NOW } });
    expect(ok.job).toMatchObject({ phase: "rollup", killed: 0, errors: [], failed_streams: [] });
  });

  it("summarises what the page needs to show", () => {
    const state = {
      ...emptyState(),
      lease_until: "2026-09-06T12:01:00.000Z",
      job: { ...openJob({}, NOW), pending_days: ["a", "b"], rows: 5 },
    };
    expect(summarise(state, NOW)).toMatchObject({
      running: true,
      stepping: true,
      phase: "sync",
      rows: 5,
      days_left: 2,
    });
  });
});
