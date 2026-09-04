import { DELIVERY_STAGE_META, DELIVERY_STAGES } from "@/lib/constants";
import type { DeliveryStage } from "@/lib/types";

/**
 * How far along a project is, as one number a client can read (0112).
 *
 * The rule is deliberately explainable in a sentence: THE STAGE SETS THE
 * RANGE, YOUR MILESTONES MOVE YOU THROUGH IT. Each delivery stage owns a band
 * of the 0–100 scale; within the band, the share of client-visible
 * milestones ticked off decides where the needle sits. A project with no
 * milestones still shows the start of its band, so the number can never sit
 * at 0% while the team is visibly at work.
 *
 * `override` is the team's manual number (projects.progress_override). It
 * wins outright when set — the escape hatch for a build whose milestones
 * don't describe it well — and `source` says which one is on screen so the
 * team side can show "manual" and offer "back to auto".
 *
 * Pure and client-safe: no dates, no I/O. The portal, the board, the project
 * page and the assistant all call this so a client and a teammate never see
 * two different percentages for the same job.
 */

export type ProgressMilestone = {
  status: string;
  client_visible: boolean | null;
  kind: string;
};

export type ProgressInput = {
  status: string | null | undefined;
  deliveryStage: string | null | undefined;
  milestones: ProgressMilestone[];
  override?: number | null;
};

export type ProgressBand = DeliveryStage | "none" | "done";

export type ProjectProgress = {
  /** 0–100, integer. */
  percent: number;
  source: "override" | "computed";
  band: ProgressBand;
  /** The stage in the client's words (DELIVERY_STAGE_META.clientLabel). */
  bandLabel: string;
  milestonesDone: number;
  milestonesTotal: number;
};

/** [from, to] of the scale each stage owns. Delivered and aftercare are done. */
const BANDS: Record<DeliveryStage | "none", readonly [number, number]> = {
  none: [0, 5],
  onboarding: [5, 20],
  assets: [20, 40],
  build: [40, 75],
  review: [75, 95],
  delivered: [100, 100],
  aftercare: [100, 100],
};

const DONE_LABEL = "Delivered";
const NOT_STARTED_LABEL = "Not started yet";

function isStage(value: string | null | undefined): value is DeliveryStage {
  return (
    typeof value === "string" &&
    (DELIVERY_STAGES as readonly string[]).includes(value)
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function computeProjectProgress(input: ProgressInput): ProjectProgress {
  const visible = input.milestones.filter(
    (m) => m.kind === "milestone" && m.client_visible !== false,
  );
  const milestonesTotal = visible.length;
  const milestonesDone = visible.filter((m) => m.status === "done").length;

  const stage = isStage(input.deliveryStage) ? input.deliveryStage : null;
  const finished =
    input.status === "completed" ||
    stage === "delivered" ||
    stage === "aftercare";

  const band: ProgressBand = finished ? "done" : (stage ?? "none");
  const bandLabel = finished
    ? DONE_LABEL
    : stage
      ? DELIVERY_STAGE_META[stage].clientLabel
      : NOT_STARTED_LABEL;

  const override =
    typeof input.override === "number" && Number.isFinite(input.override)
      ? clampPercent(input.override)
      : null;
  if (override !== null) {
    return {
      percent: override,
      source: "override",
      band,
      bandLabel,
      milestonesDone,
      milestonesTotal,
    };
  }

  if (finished) {
    return {
      percent: 100,
      source: "computed",
      band,
      bandLabel,
      milestonesDone,
      milestonesTotal,
    };
  }

  const [from, to] = BANDS[stage ?? "none"];
  const fraction = milestonesTotal ? milestonesDone / milestonesTotal : 0;
  return {
    percent: clampPercent(from + (to - from) * fraction),
    source: "computed",
    band,
    bandLabel,
    milestonesDone,
    milestonesTotal,
  };
}

/** True when a project is of the kind the portal calls "your website". */
export function isWebsiteServiceType(serviceType: string | null | undefined): boolean {
  return serviceType === "business_website" || serviceType === "ecommerce_website";
}
