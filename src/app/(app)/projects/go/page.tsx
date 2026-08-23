import { startOfToday } from "date-fns";

import { requireProfile } from "@/lib/auth";
import { balanceDue, daysSince, projectHealth } from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";

import { GoView, type GoProject } from "./go-view";

export const metadata = { title: "Delivery · on the go" };

/**
 * Delivery, phone-shaped (BIG-5, 0099).
 *
 * The app has been installable since the PWA work; what it never had was a
 * screen designed for the phone rather than shrunk onto it. The month board is
 * a three-column grid of cards about money — useful at a desk, useless when
 * you are standing in a client's office and need to move a stage, log the
 * hour and photograph what you built.
 *
 * Four verbs, big enough to hit with a thumb: approve, log, photograph, nudge.
 * Everything here goes through the same server actions the desktop uses, so
 * the deposit gate and the launch checklist apply identically.
 */
export default async function DeliveryGoPage() {
  const supabase = await createClient();
  const [profile, projectsRes] = await Promise.all([
    requireProfile(),
    supabase
      .from("projects")
      .select(
        "id, name, status, currency, total_value, deposit_paid, due_date, delivery_stage, delivery_stage_changed_at, updated_at, blocked_reason, blocked_since, risk_rank, risk_note, client:clients(id, name, phone), payments(amount, status), company_payments(price_lkr, is_paid)",
      )
      .is("deleted_at", null)
      .in("status", ["planning", "active", "on_hold"])
      .limit(100),
  ]);

  const rows = projectsRes.data ?? [];
  const ids = rows.map((r) => r.id);

  const [{ data: assets }, { data: tasks }, { data: milestones }] =
    ids.length > 0
      ? await Promise.all([
          supabase
            .from("project_document_requests")
            .select("project_id, status, required")
            .in("project_id", ids),
          supabase
            .from("todos")
            .select("project_id, status, due_date")
            .in("project_id", ids),
          supabase
            .from("project_milestones")
            .select("project_id, status, due_date")
            .in("project_id", ids),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

  const todayMs = startOfToday().getTime();

  const projects: GoProject[] = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = row as any;
    const balance = balanceDue({
      total_value: p.total_value,
      deposit_paid: p.deposit_paid,
      payments: p.payments ?? [],
      company_payments: p.company_payments ?? [],
    });
    const assetsOutstanding = (assets ?? []).filter(
      (a) => a.project_id === p.id && a.status === "pending" && a.required,
    ).length;
    const overdueTasks = (tasks ?? []).filter(
      (t) =>
        t.project_id === p.id &&
        t.status !== "done" &&
        t.due_date &&
        new Date(t.due_date).getTime() < todayMs,
    ).length;

    const health = projectHealth({
      status: p.status,
      deliveryStage: p.delivery_stage,
      stageChangedAt: p.delivery_stage_changed_at,
      updatedAt: p.updated_at,
      dueDate: p.due_date,
      blockedSince: p.blocked_since,
      assetsOutstanding,
      overdueTasks,
      overdueMilestones: (milestones ?? []).filter(
        (m) =>
          m.project_id === p.id &&
          m.status !== "done" &&
          m.due_date &&
          new Date(`${m.due_date}T23:59:59`).getTime() < todayMs,
      ).length,
      balance,
      daysSinceDelivered: null,
      budget: null,
      spend: 0,
    });

    return {
      id: p.id,
      name: p.name,
      clientName: p.client?.name ?? null,
      clientPhone: p.client?.phone ?? null,
      stage: p.delivery_stage,
      currency: p.currency || "LKR",
      balance,
      dueDate: p.due_date,
      idleDays: daysSince(p.delivery_stage_changed_at ?? p.updated_at),
      blocked: !!p.blocked_reason,
      assetsOutstanding,
      overdueTasks,
      healthTone: health.tone,
      healthScore: health.score,
      // AI-4's sentence when the radar wrote one; the health engine's
      // otherwise. Same precedence as the board card.
      why: p.risk_note ?? health.reasons[0] ?? null,
      riskRank: p.risk_rank,
    };
  });

  // Worst first — on a phone the top of the list is all most people will read.
  projects.sort((a, b) => {
    if (a.riskRank !== null && b.riskRank !== null) return a.riskRank - b.riskRank;
    if (a.riskRank !== null) return -1;
    if (b.riskRank !== null) return 1;
    return a.healthScore - b.healthScore;
  });

  return <GoView projects={projects} userId={profile.id} />;
}
