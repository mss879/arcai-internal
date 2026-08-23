import { createClient } from "@/lib/supabase/server";

import { DeliveryView } from "./delivery-view";

export const metadata = { title: "Client Delivery" };

export default async function DeliveryPage() {
  const supabase = await createClient();
  const [
    projectsRes,
    requestsRes,
    settingsRes,
    eventsRes,
    automationsRes,
    mediaRes,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("*, client:clients(id, name, company, phone)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_document_requests")
      .select("*")
      .order("position", { ascending: true }),
    supabase.from("delivery_settings").select("*").eq("id", 1).maybeSingle(),
    supabase
      .from("delivery_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(120),
    supabase.from("automations").select("id, name, is_active"),
    // Recent client-sent files, for the "awaiting filing" tray. Which of
    // them are already filed is worked out client-side from the requests.
    supabase
      .from("wa_messages")
      .select(
        "id, contact_id, message_type, body, meta, created_at, contact:wa_contacts(id, display_name, profile_name, wa_id, client_id, mode)",
      )
      .eq("direction", "in")
      .in("message_type", ["image", "document"])
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  return (
    <DeliveryView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any}
      requests={requestsRes.data ?? []}
      settings={settingsRes.data ?? null}
      events={eventsRes.data ?? []}
      automations={automationsRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      waMedia={(mediaRes.data ?? []) as any}
    />
  );
}
