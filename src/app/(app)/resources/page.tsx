import { createClient } from "@/lib/supabase/server";

import { ResourcesView } from "./resources-view";

export const metadata = { title: "Resources" };

export default async function ResourcesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("resources")
    .select(
      "*, uploader:profiles!resources_uploaded_by_fkey(full_name, username, avatar_url)",
    )
    .order("created_at", { ascending: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <ResourcesView resources={(data ?? []) as any} />;
}
