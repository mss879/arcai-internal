import { describe, expect, it } from "vitest";

import {
  categoryOf,
  classifyConversion,
  countsAsConversion,
  isGenuine,
  leadOutcome,
  ledgerKey,
  looksLikeDottedGmail,
  looksLikeTestEmail,
  mergeVerdict,
  sessionLedgerKey,
} from "./ledger-core";

const person = {
  is_bot: false,
  engaged_seconds: 38,
  forms_started: 1,
  page_count: 3,
  user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0",
  identified_email: null,
};

/** The newsletter script, exactly as it appeared in the mirror in September 2026. */
const script = {
  is_bot: false,
  engaged_seconds: 0,
  forms_started: 0,
  page_count: 1,
  user_agent: '"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.0.0 Safari/537.36"',
  identified_email: "u.we.y.o.bu1.4.7@gmail.com",
};

describe("what a conversion is", () => {
  it("knows the three categories and treats the unknown as an enquiry", () => {
    expect(categoryOf("contact_form")).toBe("enquiry");
    expect(categoryOf("chat_lead")).toBe("enquiry");
    expect(categoryOf("whatsapp_click")).toBe("contact_click");
    expect(categoryOf("newsletter")).toBe("other");
    expect(categoryOf("form_submit")).toBe("enquiry");
    expect(categoryOf("something_new")).toBe("enquiry");
    expect(categoryOf(null)).toBe("enquiry");
  });

  it("keys an enquiry by the lead id the form minted, and a click by kind and session", () => {
    expect(ledgerKey("contact_form", "s_1", { lead_id: "lead_abc" })).toBe("lead_abc");
    expect(ledgerKey("whatsapp_click", "s_1", {})).toBe("whatsapp_click:s_1");
    expect(ledgerKey("contact_form", "s_1", null)).toBe("contact_form:s_1");
    expect(sessionLedgerKey("s_1")).toBe("session:s_1");
  });

  it("counts confirmed leads and unreviewed enquiries, never a bare contact click", () => {
    expect(countsAsConversion({ status: "lead", category: "contact_click" })).toBe(true);
    expect(countsAsConversion({ status: "unreviewed", category: "enquiry" })).toBe(true);
    expect(countsAsConversion({ status: "unreviewed", category: "contact_click" })).toBe(false);
    expect(countsAsConversion({ status: "spam", category: "enquiry" })).toBe(false);
    expect(countsAsConversion({ status: "test", category: "enquiry" })).toBe(false);
    expect(isGenuine({ status: "unreviewed" })).toBe(true);
    expect(isGenuine({ status: "spam" })).toBe(false);
  });
});

describe("the spam rules", () => {
  it("files the newsletter script as spam on its quoted user agent alone", () => {
    const v = classifyConversion({
      kind: "form_submit",
      category: "enquiry",
      meta: { kind: "form_submit" },
      session: script,
    });
    expect(v.status).toBe("spam");
    expect(v.source).toBe("rule");
    expect(v.flags).toMatchObject({
      quoted_user_agent: true,
      zero_engagement: true,
      dotted_gmail: true,
    });
  });

  it("files a form submitted with zero engagement and no form interaction as spam", () => {
    const v = classifyConversion({
      kind: "contact_form",
      category: "enquiry",
      meta: {},
      session: { ...script, user_agent: "Mozilla/5.0", identified_email: null },
    });
    expect(v.status).toBe("spam");
    expect(v.reason).toMatch(/zero engaged seconds/);
  });

  it("files a success reported for a form nobody focused as spam", () => {
    const v = classifyConversion({
      kind: "contact_form",
      category: "enquiry",
      meta: { untouched: true },
      session: person,
    });
    expect(v.status).toBe("spam");
    expect(v.flags.untouched).toBe(true);
  });

  it("does not apply the form rules to a chat lead or a WhatsApp click", () => {
    const chat = classifyConversion({
      kind: "chat_lead",
      category: "enquiry",
      meta: {},
      session: { ...person, forms_started: 0, engaged_seconds: 0 },
    });
    expect(chat.status).toBe("unreviewed");
    const click = classifyConversion({
      kind: "whatsapp_click",
      category: "contact_click",
      meta: {},
      session: { ...person, forms_started: 0, engaged_seconds: 0 },
    });
    expect(click.status).toBe("unreviewed");
  });

  it("leaves a real enquiry unreviewed, which counts", () => {
    const v = classifyConversion({
      kind: "contact_form",
      category: "enquiry",
      meta: { lead_id: "lead_1" },
      session: person,
    });
    expect(v.status).toBe("unreviewed");
    expect(v.source).toBe("none");
    expect(countsAsConversion({ status: v.status, category: "enquiry" })).toBe(true);
  });

  it("recognises the script's dot-obfuscated Gmail addresses", () => {
    expect(looksLikeDottedGmail("u.we.y.o.bu1.4.7@gmail.com")).toBe(true);
    expect(looksLikeDottedGmail("first.last@gmail.com")).toBe(false);
    expect(looksLikeDottedGmail("a.b.c.d@outlook.com")).toBe(false);
    expect(looksLikeDottedGmail(null)).toBe(false);
  });
});

describe("tests", () => {
  it("files anything sent in test mode as a test, whatever else is true of it", () => {
    const v = classifyConversion({
      kind: "contact_form",
      category: "enquiry",
      meta: { test: true },
      session: script,
    });
    expect(v.status).toBe("test");
  });

  it("recognises a test address", () => {
    expect(looksLikeTestEmail("shahid@arcai.agency")).toBe(true);
    expect(looksLikeTestEmail("test.run@gmail.com")).toBe(true);
    expect(looksLikeTestEmail("someone+test@gmail.com")).toBe(true);
    expect(looksLikeTestEmail("contest@gmail.com")).toBe(false);
    expect(looksLikeTestEmail("jane@company.lk")).toBe(false);
  });
});

describe("a person's verdict is final", () => {
  it("never lets a rule overwrite a manual status", () => {
    const merged = mergeVerdict(
      { status: "lead", status_source: "manual", status_reason: "Spoke to them" },
      { status: "spam", source: "rule", reason: "quoted UA", flags: {} },
    );
    expect(merged).toEqual({
      status: "lead",
      status_source: "manual",
      status_reason: "Spoke to them",
    });
  });

  it("lets a rule replace an older rule, and fill in for nobody", () => {
    const fresh = { status: "spam" as const, source: "rule" as const, reason: "r", flags: {} };
    expect(mergeVerdict({ status: "unreviewed", status_source: "rule", status_reason: null }, fresh).status).toBe("spam");
    expect(mergeVerdict(null, fresh).status).toBe("spam");
  });
});

describe("outcomes", () => {
  it("reads qualified and won off the matched CRM lead, or off a confirmed row", () => {
    const row = { status: "unreviewed" as const, status_source: "none" as const };
    expect(leadOutcome(row, null)).toEqual({ qualified: false, won: false, outcome: "none" });
    expect(leadOutcome(row, { status: "open", score: "hot", deleted_at: null })).toMatchObject({
      qualified: true,
      outcome: "open",
    });
    expect(leadOutcome(row, { status: "won", score: null, deleted_at: null })).toMatchObject({
      qualified: true,
      won: true,
      outcome: "won",
    });
    expect(leadOutcome(row, { status: "lost", score: "hot", deleted_at: null })).toMatchObject({
      qualified: false,
      outcome: "lost",
    });
    expect(
      leadOutcome({ status: "lead", status_source: "manual" }, null),
    ).toMatchObject({ qualified: true, outcome: "none" });
  });
});
