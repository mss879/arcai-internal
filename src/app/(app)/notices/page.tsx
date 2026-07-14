import { createClient } from "@/lib/supabase/server";

import { NoticesView, type ClientLite } from "./notices-view";

export const metadata = { title: "Notice Generation" };

export default async function NoticesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [supabase, { tab }] = await Promise.all([createClient(), searchParams]);

  const [noticesRes, clientsRes] = await Promise.all([
    supabase.from("notices").select("*").order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company, email").order("name"),
  ]);

  const initialTab = tab === "past" || tab === "create" ? tab : "create";

  return (
    <NoticesView
      pastNotices={noticesRes.data ?? []}
      clients={(clientsRes.data ?? []) as ClientLite[]}
      initialTab={initialTab}
    />
  );
}
