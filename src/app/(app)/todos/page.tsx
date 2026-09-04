import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { TodoWithRelations } from "@/lib/types";

import { TodosView } from "./todos-view";

export const metadata = { title: "To-Dos" };

export default async function TodosPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const supabase = await createClient();
  const { all } = await searchParams;

  // 0114 — every open task, plus the ones finished in the last two months.
  // Done work older than that is history, not a to-do; `?all=1` still
  // loads it for the rare look back.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffIso = cutoff.toISOString();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [todosRes, projectsRes, members] = await Promise.all([
    (all === "1"
      ? supabase
          .from("todos")
          .select(
            "*, assignee:profiles!todos_assigned_to_fkey(id, full_name, username, avatar_url), project:projects(id, name), subtasks:todo_subtasks(id, todo_id, title, is_done, position, created_at)",
          )
      : supabase
          .from("todos")
          .select(
            "*, assignee:profiles!todos_assigned_to_fkey(id, full_name, username, avatar_url), project:projects(id, name), subtasks:todo_subtasks(id, todo_id, title, is_done, position, created_at)",
          )
          .or(
            `status.neq.done,completed_at.gte.${cutoffIso},created_at.gte.${cutoffIso}`,
          )
    ).order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("id, name")
      .is("deleted_at", null)
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
