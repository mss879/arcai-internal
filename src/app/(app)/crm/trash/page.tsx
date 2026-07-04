import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types";

import { TrashView } from "./trash-view";

export const metadata = { title: "CRM Trash" };

export default async function CrmTrashPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("*")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });

  return <TrashView leads={(data ?? []) as Lead[]} />;
}
