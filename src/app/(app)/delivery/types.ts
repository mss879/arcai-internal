import type { Client, Project, WaContactMode } from "@/lib/types";

/** A project row with the joined client the hub renders. */
export type DeliveryProject = Project & {
  client?: Pick<Client, "id" | "name" | "company" | "phone"> | null;
};

/** An inbound WhatsApp media message with its thread, for the filing tray. */
export type WaMediaRow = {
  id: string;
  contact_id: string;
  message_type: string;
  body: string;
  meta: Record<string, unknown> | null;
  created_at: string;
  contact?: {
    id: string;
    display_name: string | null;
    profile_name: string | null;
    wa_id: string;
    client_id: string | null;
    mode: WaContactMode;
  } | null;
};
