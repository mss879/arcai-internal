import { describe, expect, it } from "vitest";

import {
  HISTORY_MAX_CHARS,
  HISTORY_MAX_MESSAGES,
  MESSAGE_MAX_CHARS,
  buildTools,
  composeSystemPrompt,
  isReasoningModelName,
  parseChatRequest,
  retrievalQuery,
  validateAgentSettings,
  validateLead,
  windowHistory,
  type PromptProject,
} from "./chat-core";

const project: PromptProject = {
  agentName: "Ava",
  businessName: "Silverline Dental",
  websiteUrl: "https://silverline.lk",
  systemPrompt: "Be cheerful. Our clinic is in Colombo 4.",
  leadCapture: true,
  booking: true,
  bookingUrl: "https://cal.com/silverline",
  handoff: true,
};

describe("parseChatRequest", () => {
  it("accepts a well-formed body and caps the page fields", () => {
    const res = parseChatRequest({
      session: "sess_12345678",
      visitor: "vis_12345678",
      message: "  Do you do implants?  ",
      page: { url: "https://silverline.lk/services", title: "Services", referrer: "javascript:alert(1)" },
      preview: "yes",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.message).toBe("Do you do implants?");
    expect(res.request.page.referrer).toBeNull();
    expect(res.request.preview).toBe(false);
  });

  it("rejects a missing session, an empty message and an oversized one", () => {
    expect(parseChatRequest({ message: "hi" }).ok).toBe(false);
    expect(parseChatRequest({ session: "sess_12345678", message: "   " }).ok).toBe(false);
    expect(parseChatRequest({ session: "sess_12345678", message: "x".repeat(MESSAGE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(parseChatRequest(null).ok).toBe(false);
  });
});

describe("windowHistory", () => {
  it("keeps the last twelve messages and the character budget, oldest dropped", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `m${i}`,
    }));
    const kept = windowHistory(many);
    expect(kept).toHaveLength(HISTORY_MAX_MESSAGES);
    expect(kept[0]?.content).toBe("m18");

    const long = [
      { role: "user" as const, content: "a".repeat(HISTORY_MAX_CHARS) },
      { role: "assistant" as const, content: "b".repeat(100) },
    ];
    expect(windowHistory(long)).toEqual([{ role: "assistant", content: "b".repeat(100) }]);
  });
});

describe("retrievalQuery", () => {
  it("borrows the previous question for a short follow-up", () => {
    expect(retrievalQuery("how much", "Do you do implants?")).toBe("Do you do implants?\nhow much");
    expect(retrievalQuery("What are your opening hours today", "x")).toBe("What are your opening hours today");
  });
});

describe("composeSystemPrompt", () => {
  it("puts the static parts first and the retrieved context and page last", () => {
    const prompt = composeSystemPrompt(
      project,
      [{ title: "Implants", url: "https://silverline.lk/implants", content: "From Rs 150,000.", similarity: 0.8 }],
      { url: "https://silverline.lk/services", title: "Services" },
    );
    const at = (s: string) => prompt.indexOf(s);
    expect(at("You are Ava")).toBe(0);
    expect(at("OWNER'S INSTRUCTIONS")).toBeLessThan(at("HOW TO ANSWER"));
    expect(at("HOW TO ANSWER")).toBeLessThan(at("TOOLS"));
    expect(at("TOOLS")).toBeLessThan(at("BUSINESS KNOWLEDGE (retrieved"));
    expect(at("BUSINESS KNOWLEDGE (retrieved")).toBeLessThan(at("CURRENT PAGE"));
    expect(prompt).toContain("[1] Implants — https://silverline.lk/implants");
    expect(prompt).toContain("Silverline Dental");
  });

  it("includes only the tool sections that are switched on", () => {
    const off = composeSystemPrompt({ ...project, leadCapture: false, booking: false, handoff: false }, [], { url: null, title: null });
    expect(off).not.toContain("TOOLS");
    expect(off).toContain("Nothing in the knowledge base matched");
    expect(off).not.toContain("CURRENT PAGE");

    const bookingWithoutUrl = composeSystemPrompt({ ...project, bookingUrl: null, leadCapture: false, handoff: false }, [], { url: null, title: null });
    expect(bookingWithoutUrl).not.toContain("BOOKING");
    expect(buildTools({ ...project, bookingUrl: null }).map((t) => t.function.name)).toEqual(["capture_lead", "request_human"]);
    expect(buildTools(project).map((t) => t.function.name)).toEqual(["capture_lead", "offer_booking", "request_human"]);
  });
});

describe("validateLead", () => {
  it("needs a name and one valid contact", () => {
    expect(validateLead({ name: "A" }).ok).toBe(false);
    expect(validateLead({ name: "Nimal", email: "not-an-email" }).ok).toBe(false);
    const res = validateLead({ name: " Nimal Perera ", email: "NIMAL@EXAMPLE.COM", phone: "077 123 4567", interest: "implants" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lead).toMatchObject({ name: "Nimal Perera", email: "nimal@example.com", phone: "077 123 4567" });
    expect(validateLead({ name: "Nimal", phone: "12345" }).ok).toBe(false);
  });
});

describe("validateAgentSettings", () => {
  const good = {
    agentName: "Ava",
    systemPrompt: "Be nice.",
    model: "gpt-5.6-luna",
    temperature: 0.4,
    reasoningEffort: "low",
    welcomeMessage: "Hi!",
    suggestedQuestions: ["Prices?", "", "Hours?"],
    primaryColor: "#F97316",
    userBubbleColor: "",
    agentBubbleColor: "",
    widgetPosition: "right",
    showBranding: true,
    bookingUrl: "https://cal.com/x",
    notificationEmail: "Owner@Example.com",
    leadCaptureEnabled: true,
    bookingEnabled: true,
    handoffEnabled: true,
  };

  it("cleans a good submission", () => {
    const res = validateAgentSettings(good, ["gpt-5.6-luna"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.suggestedQuestions).toEqual(["Prices?", "Hours?"]);
      expect(res.value.primaryColor).toBe("#f97316");
      expect(res.value.notificationEmail).toBe("owner@example.com");
    }
  });

  it("refuses an unknown model, a bad colour, booking without a link, and leads without an email", () => {
    expect(validateAgentSettings(good, ["gpt-4o"]).ok).toBe(false);
    expect(validateAgentSettings({ ...good, primaryColor: "orange" }, ["gpt-5.6-luna"]).ok).toBe(false);
    expect(validateAgentSettings({ ...good, bookingUrl: "" }, ["gpt-5.6-luna"]).ok).toBe(false);
    expect(validateAgentSettings({ ...good, notificationEmail: "" }, ["gpt-5.6-luna"]).ok).toBe(false);
    expect(validateAgentSettings({ ...good, temperature: 3 }, ["gpt-5.6-luna"]).ok).toBe(false);
  });
});

describe("isReasoningModelName", () => {
  it("matches the gpt-5 family and the o-series only", () => {
    expect(isReasoningModelName("gpt-5.6-luna")).toBe(true);
    expect(isReasoningModelName("o3-mini")).toBe(true);
    expect(isReasoningModelName("gpt-4o-mini")).toBe(false);
    expect(isReasoningModelName("gpt-4.1")).toBe(false);
  });
});
