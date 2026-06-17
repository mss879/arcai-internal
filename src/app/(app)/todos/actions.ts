"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/push";
import { extractMentions } from "@/lib/utils";
import type { ActionResult, TodoPriority, TodoStatus } from "@/lib/types";

export type TodoInput = {
  id?: string;
  title: string;
  description?: string;
  priority?: TodoPriority;
  status?: TodoStatus;
  due_date?: string | null;
  assigned_to?: string | null;
};

export async function saveTodo(input: TodoInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };

  const status = input.status ?? "todo";
  const payload = {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    priority: input.priority ?? "medium",
    status,
    due_date: input.due_date || null,
    assigned_to: input.assigned_to || null,
    completed_at: status === "done" ? new Date().toISOString() : null,
  };

  let todoId = input.id;

  if (input.id) {
    const { error } = await supabase
      .from("todos")
      .update(payload)
      .eq("id", input.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await supabase
      .from("todos")
      .insert(payload)
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    todoId = data.id;
  }

  if (!todoId) return { ok: false, error: "Could not save task." };

  // --- Resolve @mentions -> profiles -------------------------------
  const usernames = extractMentions(input.description ?? "");
  let mentionedIds: string[] = [];
  if (usernames.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, username")
      .in("username", usernames);
    mentionedIds = (profs ?? []).map((p) => p.id);
  }

  await supabase.from("todo_mentions").delete().eq("todo_id", todoId);
  if (mentionedIds.length) {
    await supabase
      .from("todo_mentions")
      .insert(mentionedIds.map((uid) => ({ todo_id: todoId!, user_id: uid })));
  }

  // --- Notifications -----------------------------------------------
  const { data: actor } = await supabase
    .from("profiles")
    .select("full_name, username")
    .eq("id", user.id)
    .single();
  const actorName = actor?.full_name || actor?.username || "Someone";

  const recipients = new Map<string, { title: string; type: "mention" | "assignment" }>();
  for (const id of mentionedIds) {
    if (id !== user.id)
      recipients.set(id, {
        title: `${actorName} mentioned you in a task`,
        type: "mention",
      });
  }
  if (input.assigned_to && input.assigned_to !== user.id) {
    recipients.set(input.assigned_to, {
      title: `${actorName} assigned you a task`,
      type: "assignment",
    });
  }

  if (recipients.size) {
    await supabase.from("notifications").insert(
      Array.from(recipients.entries()).map(([uid, info]) => ({
        user_id: uid,
        actor_id: user.id,
        type: info.type,
        title: info.title,
        body: input.title.trim(),
        link: "/todos",
      })),
    );

    // Also push to each recipient's devices (no-op unless they've enabled it).
    await Promise.all(
      Array.from(recipients.entries()).map(([uid, info]) =>
        sendPushToUser({
          userId: uid,
          title: info.title,
          body: input.title.trim(),
          link: "/todos",
        }),
      ),
    );
  }

  revalidatePath("/todos");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function setTodoStatus(
  id: string,
  status: TodoStatus,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("todos")
    .update({
      status,
      completed_at: status === "done" ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/todos");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteTodo(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("todos").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/todos");
  revalidatePath("/dashboard");
  return { ok: true };
}
