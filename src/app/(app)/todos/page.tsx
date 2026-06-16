import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { TodoWithRelations } from "@/lib/types";

import { TodosView } from "./todos-view";

export const metadata = { title: "To-Dos" };

export default async function TodosPage() {
  const supabase = await createClient();

  const [todosRes, members] = await Promise.all([
    supabase
      .from("todos")
      .select(
        "*, assignee:profiles!todos_assigned_to_fkey(id, full_name, username, avatar_url)",
      )
      .order("created_at", { ascending: false }),
    getMembers(),
  ]);

  return (
    <TodosView
      todos={(todosRes.data ?? []) as unknown as TodoWithRelations[]}
      members={members}
    />
  );
}
