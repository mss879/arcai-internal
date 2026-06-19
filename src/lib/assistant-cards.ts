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

export type AssistantCard =
  /** A saved invoice shown for review (no action attached). */
  | { type: "invoice"; invoice: InvoiceCardData }
  /**
   * A pending email send the user must explicitly confirm. Sending happens
   * only when the user taps Send in the UI — never by the model. May target
   * several recipients and carry a custom note (e.g. a payment reminder).
   */
  | {
      type: "confirm_send";
      invoice: InvoiceCardData;
      emails: string[];
      message?: string;
    };
