import { requireProfile } from "@/lib/auth";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";

import { InsightsView } from "./insights-view";

export const metadata = { title: "Project insights" };

/**
 * The AI layer, in one place (theme 5, 0098).
 *
 * Five things that all answer "what do the projects actually know": ask them
 * a question, see tonight's risk ranking, price the next job from history,
 * keep or dismiss what a finished project taught us, and clear the arithmetic
 * guards.
 *
 * Everything here reads. The only writes are a person's decisions — keep,
 * dismiss, resolve.
 */
export default async function ProjectInsightsPage() {
  const supabase = await createClient();

  const [, riskRes, lessonsRes, anomaliesRes] = await Promise.all([
    // Resolved for the auth gate the layout already applies; nothing here is
    // admin-only — Estimates, which was, now lives under Reports.
    requireProfile(),
    // AI-4 — last night's ranking, worst first.
    supabase
      .from("projects")
      .select("id, name, risk_rank, risk_note, risk_checked_at, due_date, delivery_stage, client:clients(name)")
      .is("deleted_at", null)
      .not("risk_rank", "is", null)
      .order("risk_rank", { ascending: true })
      .limit(20),
    // AI-6 — undecided first; that is the queue.
    supabase
      .from("project_lessons")
      .select("id, project_id, project_name, title, body, category, status, evidence, created_at")
      .order("status", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(60),
    // AI-9 — only what is still open.
    supabase
      .from("project_anomalies")
      .select("id, project_id, kind, detail, evidence, status, created_at, project:projects(name)")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  return (
    <InsightsView
      aiReady={isOpenAIConfigured()}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      risk={(riskRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lessons={(lessonsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anomalies={(anomaliesRes.data ?? []) as any}
    />
  );
}
