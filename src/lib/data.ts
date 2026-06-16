import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { MemberLite } from "@/lib/types";

/** All workspace members (for pickers, mentions, assignment). */
export async function getMembers(): Promise<MemberLite[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, username, avatar_url, role")
    .order("full_name", { ascending: true });
  return data ?? [];
}
