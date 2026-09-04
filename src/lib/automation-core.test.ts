import { describe, expect, it } from "vitest";

import {
  isNudgeTrigger,
  matchesTriggerConfig,
  passesConditions,
  renderTokens,
  type TriggerEvent,
} from "./automation-core";

type Automation = Parameters<typeof matchesTriggerConfig>[0];
type Lead = NonNullable<TriggerEvent["lead"]>;
type Run = Parameters<typeof renderTokens>[1];

/** Only `trigger`, `trigger_config` and `conditions` are ever read. */
const automation = (a: {
  trigger: string;
  trigger_config?: Record<string, unknown>;
  conditions?: unknown[];
}): Automation =>
  ({
    trigger: a.trigger,
    trigger_config: a.trigger_config ?? {},
    conditions: a.conditions ?? [],
  }) as unknown as Automation;

const lead = (l: Partial<Record<string, unknown>> = {}): Lead =>
  ({ id: "lead-1", pipeline_id: null, stage_id: null, ...l }) as unknown as Lead;

const run = (r: Partial<Record<string, unknown>> = {}): Run =>
  ({
    subject_name: null,
    subject_phone: null,
    subject_email: null,
    context: {},
    ...r,
  }) as unknown as Run;

describe("matchesTriggerConfig", () => {
  it("fires on every stage move when no stage is named", () => {
    expect(
      matchesTriggerConfig(automation({ trigger: "stage_changed" }), {
        trigger: "stage_changed",
        lead: lead({ stage_id: "s2" }),
      } as TriggerEvent),
    ).toBe(true);
  });

  it("respects a stage filter", () => {
    const a = automation({
      trigger: "stage_changed",
      trigger_config: { stage_id: "s2" },
    });
    const ev = (stage: string) =>
      ({ trigger: "stage_changed", lead: lead({ stage_id: stage }) }) as TriggerEvent;
    expect(matchesTriggerConfig(a, ev("s2"))).toBe(true);
    expect(matchesTriggerConfig(a, ev("s9"))).toBe(false);
  });

  it("blocks a lead from the wrong pipeline whatever the trigger", () => {
    expect(
      matchesTriggerConfig(
        automation({ trigger: "stage_changed", trigger_config: { pipeline_id: "p1" } }),
        { trigger: "stage_changed", lead: lead({ pipeline_id: "p2" }) } as TriggerEvent,
      ),
    ).toBe(false);
  });

  it("matches a tag case-insensitively", () => {
    const a = automation({ trigger: "tag_added", trigger_config: { tag: "VIP" } });
    expect(
      matchesTriggerConfig(a, {
        trigger: "tag_added",
        payload: { tag: "vip" },
      } as TriggerEvent),
    ).toBe(true);
    expect(
      matchesTriggerConfig(a, {
        trigger: "tag_added",
        payload: { tag: "cold" },
      } as TriggerEvent),
    ).toBe(false);
  });

  it("matches a WhatsApp keyword anywhere in the message", () => {
    const a = automation({
      trigger: "wa_message_received",
      trigger_config: { keyword: "price" },
    });
    expect(
      matchesTriggerConfig(a, {
        trigger: "wa_message_received",
        payload: { message: "What's the PRICE for a website?" },
      } as TriggerEvent),
    ).toBe(true);
  });

  it("filters payment_received by installment number", () => {
    const a = automation({ trigger: "payment_received", trigger_config: { seq: 1 } });
    const ev = (seq: number) =>
      ({ trigger: "payment_received", payload: { seq } }) as TriggerEvent;
    expect(matchesTriggerConfig(a, ev(1))).toBe(true);
    expect(matchesTriggerConfig(a, ev(2))).toBe(false);
  });

  it("filters an expense by category AND minimum amount", () => {
    const a = automation({
      trigger: "expense_added",
      trigger_config: { category: "Ads", min_amount: 10_000 },
    });
    const ev = (category: string, amount: number) =>
      ({ trigger: "expense_added", payload: { category, amount } }) as TriggerEvent;
    expect(matchesTriggerConfig(a, ev("ads", 15_000))).toBe(true);
    expect(matchesTriggerConfig(a, ev("ads", 500))).toBe(false);
    expect(matchesTriggerConfig(a, ev("hosting", 15_000))).toBe(false);
  });

  it("fires on any service type when the filter is blank", () => {
    expect(
      matchesTriggerConfig(automation({ trigger: "project_created" }), {
        trigger: "project_created",
        payload: { service_type: "website" },
      } as TriggerEvent),
    ).toBe(true);
  });
});

describe("passesConditions", () => {
  it("passes when there are no conditions", () => {
    expect(passesConditions(automation({ trigger: "lead_created" }), lead())).toBe(true);
  });

  it("requires every condition to pass", () => {
    const a = automation({
      trigger: "lead_created",
      conditions: [
        { field: "source", op: "eq", value: "website" },
        { field: "value", op: "gt", value: 50_000 },
      ],
    });
    expect(passesConditions(a, lead({ source: "website", value: 90_000 }))).toBe(true);
    expect(passesConditions(a, lead({ source: "website", value: 10_000 }))).toBe(false);
    expect(passesConditions(a, lead({ source: "referral", value: 90_000 }))).toBe(false);
  });

  it("matches a tag array with `contains`", () => {
    const a = automation({
      trigger: "lead_created",
      conditions: [{ field: "tags", op: "contains", value: "VIP" }],
    });
    expect(passesConditions(a, lead({ tags: ["vip", "warm"] }))).toBe(true);
    expect(passesConditions(a, lead({ tags: ["cold"] }))).toBe(false);
  });

  it("treats is_set / not_set as blank-or-missing, not falsy", () => {
    const isSet = automation({
      trigger: "lead_created",
      conditions: [{ field: "contact_email", op: "is_set" }],
    });
    expect(passesConditions(isSet, lead({ contact_email: "a@b.com" }))).toBe(true);
    expect(passesConditions(isSet, lead({ contact_email: "" }))).toBe(false);
    expect(passesConditions(isSet, lead({ contact_email: null }))).toBe(false);
  });

  it("fails safe on an operator it doesn't know", () => {
    // A typo in a condition must never fire a customer-facing automation.
    expect(
      passesConditions(
        automation({
          trigger: "lead_created",
          conditions: [{ field: "source", op: "starts_with", value: "web" }],
        }),
        lead({ source: "website" }),
      ),
    ).toBe(false);
  });

  it("ignores a half-written condition rather than blocking on it", () => {
    expect(
      passesConditions(
        automation({ trigger: "lead_created", conditions: [{ field: "source" }] }),
        lead({ source: "website" }),
      ),
    ).toBe(true);
  });
});

describe("renderTokens", () => {
  it("uses the first name for {{name}} and the whole one for {{full_name}}", () => {
    const text = renderTokens(
      "Hi {{name}}, we have you as {{full_name}}.",
      run({ subject_name: "Nimal Perera" }),
    );
    expect(text).toBe("Hi Nimal, we have you as Nimal Perera.");
  });

  it("falls back to 'there' when nobody is named", () => {
    expect(renderTokens("Hi {{name}}", run())).toBe("Hi there");
    expect(renderTokens("Hi {{full_name}}", run())).toBe("Hi there");
  });

  it("blanks a token it has no value for rather than printing it", () => {
    expect(renderTokens("Call {{phone}}.", run())).toBe("Call .");
  });

  it("fills lead tokens only when a lead is passed", () => {
    const t = "{{title}} at {{company}} for {{value}}";
    expect(
      renderTokens(t, run(), {
        title: "New site",
        company: "Aarah",
        value: 250_000,
      } as never),
    ).toBe("New site at Aarah for 250000");
    // No lead: the tokens are left alone for a later pass to fill.
    expect(renderTokens(t, run())).toBe(t);
  });

  it("exposes context values as {{key}} and replaces every occurrence", () => {
    expect(
      renderTokens(
        "Invoice {{invoice_number}} — {{invoice_number}}",
        run({ context: { invoice_number: "INV-0042" } }),
      ),
    ).toBe("Invoice INV-0042 — INV-0042");
  });

  it("writes a null context value as blank, not 'null'", () => {
    expect(
      renderTokens("Balance {{amount}}.", run({ context: { amount: null } })),
    ).toBe("Balance .");
  });
});

describe("isNudgeTrigger", () => {
  it("counts timer-driven triggers as nudges, so quiet hours apply", () => {
    expect(isNudgeTrigger("invoice_unpaid", null)).toBe(true);
    expect(isNudgeTrigger("project_overdue", null)).toBe(true);
    expect(isNudgeTrigger("project_delivered", null)).toBe(true);
  });

  it("does not count a reply to something the customer just did", () => {
    expect(isNudgeTrigger("payment_received", null)).toBe(false);
    expect(isNudgeTrigger("wa_message_received", null)).toBe(false);
    expect(isNudgeTrigger(null, null)).toBe(false);
  });

  it("counts a prospected lead's first touch as unprompted", () => {
    expect(isNudgeTrigger("lead_created", { source: "prospecting" })).toBe(true);
    expect(isNudgeTrigger("lead_created", { source: "website" })).toBe(false);
  });
});
