/**
 * Which channel a portal link goes out on — the decision, without the sending.
 *
 * `src/lib/portal-send.ts` is `server-only`: it reads the project, resolves the
 * client's WhatsApp thread and calls Meta and Notify.lk. But the ladder it
 * walks (0112) is a pure function of five facts known before any of that:
 *
 *   1. WhatsApp with an "Open your project" button, while the client's 24h
 *      window is open.
 *   2. WhatsApp as the approved portal template, when the window is closed and
 *      Delivery → Settings names one.
 *   3. SMS.
 *   4. Nothing — a task for the team.
 *
 * Splitting the decision out means the ladder can be tested for every
 * combination of "no template", "opted out", "window closed", "SMS
 * unconfigured" without a Supabase client or a Meta account. The wording of
 * every problem string is part of the contract: the caller shows them to the
 * team and pastes them into the fallback task.
 */

export type PortalSendChannel = "auto" | "whatsapp" | "sms";

/** What the caller should try first. */
export type PortalRung =
  | "whatsapp_cta"
  | "whatsapp_template"
  | "sms"
  | "give_up";

export type PortalChannelFacts = {
  /** What the caller asked for. "auto" walks the whole ladder. */
  requested: PortalSendChannel;
  /** WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID are set. */
  whatsappConfigured: boolean;
  /**
   * The client's WhatsApp thread, when their number resolves to one. Null
   * means the number isn't usable on WhatsApp.
   */
  wa: { doNotContact: boolean; windowOpen: boolean } | null;
  /** delivery_settings.portal_template_name, trimmed. */
  portalTemplate: string | null;
  /** The Notify.lk keys are set. */
  smsConfigured: boolean;
  /** For the problem strings, which name the client. */
  clientName: string;
};

export type PortalChannelChoice = {
  rung: PortalRung;
  /**
   * Why WhatsApp was skipped, in the words the team sees. Null when WhatsApp
   * was never in play (the caller asked for SMS) or when it is being used.
   */
  whatsappProblem: string | null;
};

/**
 * Walk the ladder. Never sends, never throws.
 *
 * A caller that asked for a specific channel gets that channel or `give_up` —
 * it is never quietly downgraded, because "send on WhatsApp" from a human is a
 * choice, not a preference.
 */
export function choosePortalChannel(facts: PortalChannelFacts): PortalChannelChoice {
  const { requested } = facts;

  // An explicit SMS request skips the WhatsApp rungs entirely — and reports no
  // WhatsApp problem, because WhatsApp was never tried.
  if (requested === "sms") {
    return {
      rung: facts.smsConfigured ? "sms" : "give_up",
      whatsappProblem: null,
    };
  }

  const whatsappProblem = whatsappBlocker(facts);
  if (!whatsappProblem) {
    return {
      rung: facts.wa!.windowOpen ? "whatsapp_cta" : "whatsapp_template",
      whatsappProblem: null,
    };
  }

  // Asked for WhatsApp specifically and it can't happen: stop, don't text.
  if (requested === "whatsapp") {
    return { rung: "give_up", whatsappProblem };
  }

  return {
    rung: facts.smsConfigured ? "sms" : "give_up",
    whatsappProblem,
  };
}

/**
 * The reason WhatsApp can't carry this link, or null when it can. The strings
 * are the ones portal-send.ts has always shown; they are quoted into the
 * fallback task, so they read as sentence fragments after "WhatsApp: ".
 */
function whatsappBlocker(facts: PortalChannelFacts): string | null {
  if (!facts.whatsappConfigured) return "WhatsApp isn't configured.";
  if (!facts.wa) {
    return `${facts.clientName}'s phone number isn't a usable WhatsApp number.`;
  }
  if (facts.wa.doNotContact) {
    return `${facts.clientName} has opted out of WhatsApp messages.`;
  }
  if (!facts.wa.windowOpen && !facts.portalTemplate) {
    return "their 24h WhatsApp window is closed and no portal template is set (Client Delivery → Settings)";
  }
  return null;
}
