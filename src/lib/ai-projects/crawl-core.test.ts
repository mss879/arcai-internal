import { describe, expect, it } from "vitest";

import {
  MAX_KILLED_STEPS,
  beginStep,
  decidePage,
  endStep,
  foldCrawlStatus,
  isSourceStale,
  leaseIsFree,
  nextPhase,
  scheduleNext,
  scrapingTimedOut,
  type CrawlJobLite,
} from "./crawl-core";

const job = (over: Partial<CrawlJobLite> = {}): CrawlJobLite => ({
  status: "crawling",
  killed: 0,
  steps: 0,
  errors: [],
  error: null,
  started_at: "2026-09-07T06:00:00.000Z",
  lease_until: null,
  version: 0,
  ...over,
});

describe("lease and steps", () => {
  it("is free when unset or expired", () => {
    expect(leaseIsFree(null, "2026-09-07T06:00:00.000Z")).toBe(true);
    expect(leaseIsFree("2026-09-07T05:59:59.000Z", "2026-09-07T06:00:00.000Z")).toBe(true);
    expect(leaseIsFree("2026-09-07T06:01:00.000Z", "2026-09-07T06:00:00.000Z")).toBe(false);
  });

  it("bumps killed before work and resets it after", () => {
    const { job: started, abandoned } = beginStep(job());
    expect(abandoned).toBe(false);
    expect(started.killed).toBe(1);
    expect(started.steps).toBe(1);
    expect(endStep(started).killed).toBe(0);
  });

  it("fails the job after three killed steps in a row", () => {
    const { job: failed, abandoned } = beginStep(job({ killed: MAX_KILLED_STEPS }));
    expect(abandoned).toBe(true);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("abandoned");
    expect(failed.errors).toHaveLength(1);
  });
});

describe("phases", () => {
  it("walks queued → starting → crawling → ingesting → finalising → completed", () => {
    expect(nextPhase("queued")).toBe("starting");
    expect(nextPhase("starting")).toBe("crawling");
    expect(nextPhase("crawling")).toBe("ingesting");
    expect(nextPhase("ingesting")).toBe("finalising");
    expect(nextPhase("finalising")).toBe("completed");
    expect(nextPhase("completed")).toBe("completed");
    expect(nextPhase("failed")).toBe("failed");
  });
});

describe("page decisions", () => {
  it("skips only a ready source with the same hash", () => {
    expect(decidePage(null, "h")).toBe("new");
    expect(decidePage({ content_hash: "h", status: "ready" }, "h")).toBe("unchanged");
    expect(decidePage({ content_hash: "h", status: "stale" }, "h")).toBe("changed");
    expect(decidePage({ content_hash: "g", status: "ready" }, "h")).toBe("changed");
  });

  it("marks a source the run did not see as stale", () => {
    const started = "2026-09-07T06:00:00.000Z";
    expect(isSourceStale(null, started)).toBe(true);
    expect(isSourceStale("2026-09-07T05:00:00.000Z", started)).toBe(true);
    expect(isSourceStale("2026-09-07T06:10:00.000Z", started)).toBe(false);
  });
});

describe("timing", () => {
  it("times out a crawl stuck scraping for over thirty minutes", () => {
    expect(scrapingTimedOut("2026-09-07T06:00:00.000Z", "2026-09-07T06:29:00.000Z")).toBe(false);
    expect(scrapingTimedOut("2026-09-07T06:00:00.000Z", "2026-09-07T06:31:00.000Z")).toBe(true);
    expect(scrapingTimedOut("garbage", "2026-09-07T06:31:00.000Z")).toBe(false);
  });

  it("schedules the next crawl an interval away, or never", () => {
    expect(scheduleNext("2026-09-07T06:00:00.000Z", 7)).toBe("2026-09-14T06:00:00.000Z");
    expect(scheduleNext("2026-09-07T06:00:00.000Z", 14)).toBe("2026-09-21T06:00:00.000Z");
    expect(scheduleNext("2026-09-07T06:00:00.000Z", null)).toBeNull();
  });

  it("folds Firecrawl's statuses", () => {
    expect(foldCrawlStatus("completed")).toBe("completed");
    expect(foldCrawlStatus("failed")).toBe("failed");
    expect(foldCrawlStatus("scraping")).toBe("scraping");
    expect(foldCrawlStatus(undefined)).toBe("scraping");
  });
});
