import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { TodoWithRelations } from "@/lib/types";

import { TodosView } from "./todos-view";

export const metadata = { title: "To-Dos" };

export default async function TodosPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [todosRes, projectsRes, members] = await Promise.all([
    supabase
      .from("todos")
      .select(
        "*, assignee:profiles!todos_assigned_to_fkey(id, full_name, username, avatar_url), project:projects(id, name), subtasks:todo_subtasks(id, todo_id, title, is_done, position, created_at)",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("id, name")
      .order("created_at", { ascending: false }),
    getMembers(),
  ]);

  return (
    <TodosView
      todos={(todosRes.data ?? []) as unknown as TodoWithRelations[]}
      members={members}
      projects={projectsRes.data ?? []}
      currentUserId={user?.id ?? null}
    />
  );
}
