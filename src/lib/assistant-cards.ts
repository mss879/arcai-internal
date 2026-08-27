/**
 * Rich UI payloads the voice assistant can attach to a reply.
 *
 * These are deliberately framework-free and server-safe (no "server-only",
 * no React) so both the server tools (`@/lib/ai/tools`) and the client voice
 * hook (`@/components/assistant/use-voice-chat`) can share one definition.
 *
 * A "card" is something the assistant shows the user for review — most
 * importantly the invoice send-confirmation, where the human must visually
 * verify the invoice and the recipient address before anything is sent.
 */

import type { ProposalContent, ProposalSelection } from "@/lib/proposal";

export type InvoiceCardItem = {
  /** Short item / service label (may be empty). */
  item: string;
  /** Fuller service description. */
  description: string;
  /** Quantity, kept as a display string to match the generator. */
  qty: string;
  /** Unit price, kept as a display string. */
  rate: string;
  /** Computed line total in LKR. */
  total: number;
};

export type InvoiceCardData = {
  id: string;
  invoice_number: string;
  /** ISO date (YYYY-MM-DD). */
  invoice_date: string;
  bill_to_name: string;
  bill_to_details: string;
  items: InvoiceCardItem[];
  grand_total: number;
  due_today: number;
};

/**
 * A proposal the assistant drafted and saved. Carries the full selection and
 * content so the card can render the branded PDF straight from what's already
 * in the transcript — no second round-trip to fetch the row back.
 */
export type ProposalCardData = {
  id: string;
  client_name: string;
  project_name: string;
  /** ISO date (YYYY-MM-DD). */
  proposal_date: string;
  /** Human label for the chosen package, from selectionSummary(). */
  package_summary: string;
  line_items: { label: string; amount: number; original?: number }[];
  grand_total: number;
  /** Monthly/at-cost notes that sit under the total (never part of it). */
  recurring_notes: string[];
  selection: ProposalSelection;
  content: ProposalContent;
};

export type SmsCardData = {
  /** Recipient in Notify.lk format (94XXXXXXXXX). */
  to_number: string;
  /** Pretty-printed number for display, e.g. +94 71 234 5678. */
  to_display: string;
  client_id: string | null;
  /** CRM lead the number came from, when the name matched a lead instead of a saved client. */
  lead_id: string | null;
  client_name: string;
  /** The final message text exactly as it will be sent. */
  message: string;
  kind: "custom" | "payment_reminder";
  invoice_id: string | null;
  /** Human label for the linked invoice (e.g. "#00206"), if any. */
  invoice_number: string | null;
};

export type CardSendState = "idle" | "sending" | "sent" | "error" | "cancelled";

/**
 * Client-side outcome of a confirm card. Normally the card manages its own
 * state from its buttons; when the user confirms BY VOICE ("yes, send it")
 * the voice hook resolves the send itself and records it here so the card
 * reflects what happened. Never sent by the server.
 */
export type CardResolution = { state: CardSendState; error?: string };

export type AssistantCard =
  /** A saved invoice shown for review (no action attached). */
  | { type: "invoice"; invoice: InvoiceCardData }
  /**
   * A pending email send the user must explicitly confirm. Sending happens
   * only when the user taps Send (or says yes) — never by the model. May
   * target several recipients and carry a custom note (e.g. a reminder).
   */
  | {
      type: "confirm_send";
      invoice: InvoiceCardData;
      emails: string[];
      message?: string;
      resolution?: CardResolution;
    }
  /**
   * A pending SMS (custom text or payment reminder) the user must explicitly
   * confirm. Like emails, nothing is sent until the user taps Send or says yes.
   */
  | { type: "confirm_send_sms"; sms: SmsCardData; resolution?: CardResolution }
  /** A saved proposal shown for review, with a PDF download (no send action). */
  | { type: "proposal"; proposal: ProposalCardData }
  /**
   * A mission Arcus has planned but not started (0103).
   *
   * The same shape of promise as a confirm card: it shows exactly what would
   * happen, and nothing happens until a person taps Approve. Approval goes
   * through an HTTP route, never a tool, so the model can propose a plan but
   * can never authorise its own.
   */
  | {
      type: "mission_plan";
      mission: {
        id: string;
        title: string;
        goal: string;
        steps: { n: number; title: string }[];
      };
      resolution?: CardResolution;
    };
