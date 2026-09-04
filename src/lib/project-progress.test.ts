import { describe, expect, it } from "vitest";

import { computeProjectProgress } from "./project-progress";

const ms = (status: string, visible = true, kind = "milestone") => ({
  status,
  client_visible: visible,
  kind,
});

describe("computeProjectProgress", () => {
  it("sits at the start of the band with no milestones", () => {
    expect(
      computeProjectProgress({ status: "active", deliveryStage: "build", milestones: [] })
        .percent,
    ).toBe(40);
    expect(
      computeProjectProgress({ status: "planning", deliveryStage: null, milestones: [] })
        .percent,
    ).toBe(0);
  });

  it("moves through the band as client-visible milestones are done", () => {
    const half = computeProjectProgress({
      status: "active",
      deliveryStage: "build",
      milestones: [ms("done"), ms("pending")],
    });
    // build owns 40–75; half way is 57.5 → 58.
    expect(half.percent).toBe(58);
    expect(half.milestonesDone).toBe(1);
    expect(half.milestonesTotal).toBe(2);
    expect(half.bandLabel).toBe("Building your project");
  });

  it("ignores launch checks and hidden milestones", () => {
    const res = computeProjectProgress({
      status: "active",
      deliveryStage: "review",
      milestones: [ms("done", false), ms("done", true, "launch_check"), ms("pending")],
    });
    expect(res.milestonesTotal).toBe(1);
    expect(res.percent).toBe(75);
  });

  it("is 100 once delivered or completed, whatever the milestones say", () => {
    expect(
      computeProjectProgress({
        status: "active",
        deliveryStage: "delivered",
        milestones: [ms("pending")],
      }).percent,
    ).toBe(100);
    expect(
      computeProjectProgress({ status: "completed", deliveryStage: "assets", milestones: [] })
        .percent,
    ).toBe(100);
  });

  it("lets a manual override win and says so", () => {
    const res = computeProjectProgress({
      status: "active",
      deliveryStage: "assets",
      milestones: [],
      override: 63,
    });
    expect(res.percent).toBe(63);
    expect(res.source).toBe("override");
    const clamped = computeProjectProgress({
      status: "active",
      deliveryStage: "assets",
      milestones: [],
      override: 140,
    });
    expect(clamped.percent).toBe(100);
  });
});
