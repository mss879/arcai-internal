"use server";

import { revalidatePath } from "next/cache";

import { PROJECT_WITH_CLIENT, type AiProjectWithClient } from "@/lib/ai-projects/projects";
import { leadEmail, notifyProject } from "@/lib/ai-projects/tools";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, AiLeadStatus } from "@/lib/types";

/** The Conversations and Leads tabs' actions (0126). */

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
};

export async function loadConversationTranscript(
  projectId: string,
  conversationId: string,
): Promise<ActionResult<{ messages: TranscriptMessage[] }>> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_messages")
    .select("id, role, content, tool_name, meta, created_at")
    .eq("project_id", projectId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    messages: (data ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolName: m.tool_name,
      meta: (m.meta ?? {}) as Record<string, unknown>,
      createdAt: m.created_at,
    })),
  };
}

/** Removes the transcript. Usage rows keep their cost (the conversation
 * pointer is cleared), so the month's bill does not change. */
export async function deleteConversation(projectId: string, conversationId: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_conversations").delete().eq("id", conversationId).eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ai-projects/${projectId}`);
  return { ok: true };
}

export async function updateLeadStatus(projectId: string, leadId: string, status: AiLeadStatus): Promise<ActionResult> {
  await requireAdmin();
  if (!["new", "contacted", "archived"].includes(status)) return { ok: false, error: "Unknown status." };
  const supabase = await createClient();
  const { error } = await supabase.from("ai_leads").update({ status }).eq("id", leadId).eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ai-projects/${projectId}`);
  return { ok: true };
}

export async function resendLeadEmail(projectId: string, leadId: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const [{ data: project }, { data: lead }] = await Promise.all([
    supabase.from("ai_projects").select(PROJECT_WITH_CLIENT).eq("id", projectId).maybeSingle(),
    supabase.from("ai_leads").select("*").eq("id", leadId).eq("project_id", projectId).maybeSingle(),
  ]);
  const p = project as unknown as AiProjectWithClient | null;
  if (!p || !lead) return { ok: false, error: "That lead no longer exists." };
  if (!p.notification_email) return { ok: false, error: "Set a notification email on the Agent tab first." };
  const mail = leadEmail(p, lead);
  const res = await notifyProject(supabase, p, mail.subject, mail.body);
  await supabase
    .from("ai_leads")
    .update(res.sent ? { notified_at: new Date().toISOString(), notify_error: null } : { notify_error: res.error ?? "not sent" })
    .eq("id", leadId);
  revalidatePath(`/ai-projects/${projectId}`);
  return res.sent ? { ok: true } : { ok: false, error: res.error ?? "The email could not be sent." };
}
