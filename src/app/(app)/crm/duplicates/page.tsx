import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types";

import { DuplicatesView } from "./duplicates-view";

export const metadata = { title: "Duplicate leads" };

export default async function DuplicatesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  return <DuplicatesView leads={(data ?? []) as Lead[]} />;
}
