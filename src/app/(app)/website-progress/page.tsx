import { createClient } from "@/lib/supabase/server";
import type { Client, WebsiteProject } from "@/lib/types";

import { WebsiteProgressView } from "./website-progress-view";

export const metadata = { title: "Website Progress" };

type WebsiteProjectRow = WebsiteProject & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
};

export default async function WebsiteProgressPage() {
  const supabase = await createClient();

  const [sitesRes, clientsRes] = await Promise.all([
    supabase
      .from("website_projects")
      .select("*, client:clients(id, name, company)")
      .order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company").order("name"),
  ]);

  return (
    <WebsiteProgressView
      // The clients join isn't declared in the hand-authored DB types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sites={(sitesRes.data ?? []) as any as WebsiteProjectRow[]}
      clients={clientsRes.data ?? []}
    />
  );
}
