import { describe, expect, it } from "vitest";

import {
  choosePortalChannel,
  type PortalChannelFacts,
} from "./portal-send-core";

const facts = (f: Partial<PortalChannelFacts> = {}): PortalChannelFacts => ({
  requested: "auto",
  whatsappConfigured: true,
  wa: { doNotContact: false, windowOpen: true },
  portalTemplate: "arc_portal_link",
  smsConfigured: true,
  clientName: "Nimal",
  ...f,
});

describe("choosePortalChannel", () => {
  it("uses the WhatsApp button while the 24h window is open", () => {
    const choice = choosePortalChannel(facts());
    expect(choice.rung).toBe("whatsapp_cta");
    expect(choice.whatsappProblem).toBeNull();
  });

  it("falls to the approved template once the window has shut", () => {
    const choice = choosePortalChannel(
      facts({ wa: { doNotContact: false, windowOpen: false } }),
    );
    expect(choice.rung).toBe("whatsapp_template");
    expect(choice.whatsappProblem).toBeNull();
  });

  it("falls to SMS when the window is shut and no template is set", () => {
    const choice = choosePortalChannel(
      facts({ wa: { doNotContact: false, windowOpen: false }, portalTemplate: null }),
    );
    expect(choice.rung).toBe("sms");
    expect(choice.whatsappProblem).toContain("no portal template is set");
  });

  it("falls to SMS when the client opted out of WhatsApp, and says so by name", () => {
    const choice = choosePortalChannel(
      facts({ wa: { doNotContact: true, windowOpen: true } }),
    );
    expect(choice.rung).toBe("sms");
    expect(choice.whatsappProblem).toBe("Nimal has opted out of WhatsApp messages.");
  });

  it("falls to SMS when the number isn't usable on WhatsApp", () => {
    const choice = choosePortalChannel(facts({ wa: null }));
    expect(choice.rung).toBe("sms");
    expect(choice.whatsappProblem).toBe(
      "Nimal's phone number isn't a usable WhatsApp number.",
    );
  });

  it("falls to SMS when WhatsApp isn't configured at all", () => {
    const choice = choosePortalChannel(facts({ whatsappConfigured: false, wa: null }));
    expect(choice.rung).toBe("sms");
    expect(choice.whatsappProblem).toBe("WhatsApp isn't configured.");
  });

  it("gives up — for a task — when neither channel can send", () => {
    const choice = choosePortalChannel(
      facts({ whatsappConfigured: false, wa: null, smsConfigured: false }),
    );
    expect(choice.rung).toBe("give_up");
    expect(choice.whatsappProblem).toBe("WhatsApp isn't configured.");
  });

  it("never downgrades an explicit WhatsApp request to SMS", () => {
    // Asking for WhatsApp is a choice, not a preference. Silently texting
    // instead would surprise whoever pressed the button.
    const choice = choosePortalChannel(
      facts({ requested: "whatsapp", wa: { doNotContact: true, windowOpen: true } }),
    );
    expect(choice.rung).toBe("give_up");
    expect(choice.whatsappProblem).toBe("Nimal has opted out of WhatsApp messages.");
  });

  it("still sends on WhatsApp when it was asked for and can", () => {
    expect(choosePortalChannel(facts({ requested: "whatsapp" })).rung).toBe(
      "whatsapp_cta",
    );
  });

  it("skips WhatsApp entirely when SMS was asked for, and reports no problem", () => {
    const choice = choosePortalChannel(facts({ requested: "sms" }));
    expect(choice.rung).toBe("sms");
    // WhatsApp was never tried, so there is nothing to explain to the team.
    expect(choice.whatsappProblem).toBeNull();
  });

  it("gives up on an SMS request when SMS isn't configured", () => {
    const choice = choosePortalChannel(facts({ requested: "sms", smsConfigured: false }));
    expect(choice.rung).toBe("give_up");
    expect(choice.whatsappProblem).toBeNull();
  });
});
