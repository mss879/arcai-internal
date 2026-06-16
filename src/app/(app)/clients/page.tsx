import { createClient } from "@/lib/supabase/server";

import { ClientsView } from "./clients-view";

export const metadata = { title: "Clients" };

export default async function ClientsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("*")
    .order("created_at", { ascending: false });

  return <ClientsView clients={data ?? []} />;
}
