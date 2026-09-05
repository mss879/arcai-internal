import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { startOfToday } from "date-fns";

import type { Database } from "@/lib/database.types";
import { balanceDue, daysSince, projectHealth, type HealthTone } from "@/lib/projects";
import type { DeliveryStage } from "@/lib/types";

type DB = SupabaseClient<Database>;

/**
 * The phone-first delivery list (BIG-5, 0099), as data.
 *
 * Built once here for the page AND for /api/go/data (0119): the service
 * worker keeps the JSON as the offline copy, and it has to be the same list
 * the page rendered or the two would disagree the moment the signal drops.
 * Worst first — on a phone the top of the list is all most people read.
 */

export type GoProject = {
  id: string;
  name: string;
  clientName: string | null;
  clientPhone: string | null;
  stage: DeliveryStage | null;
  currency: string;
  balance: number;
  dueDate: string | null;
  idleDays: number | null;
  blocked: boolean;
  assetsOutstanding: number;
  overdueTasks: number;
  healthTone: HealthTone;
  healthScore: number;
  why: string | null;
  riskRank: number | null;
};

export async function loadGoProjects(supabase: DB): Promise<GoProject[]> {
  const { data: rows } = await supabase
    .from("projects")
    .select(
      "id, name, status, currency, total_value, deposit_paid, due_date, delivery_stage, delivery_stage_changed_at, updated_at, blocked_reason, blocked_since, risk_rank, risk_note, client:clients(id, name, phone), payments(amount, status), company_payments(price_lkr, is_paid)",
    )
    .is("deleted_at", null)
    .in("status", ["planning", "active", "on_hold"])
    .limit(100);

  const list = rows ?? [];
  const ids = list.map((r) => r.id);

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

  const projects: GoProject[] = list.map((row) => {
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

  projects.sort((a, b) => {
    if (a.riskRank !== null && b.riskRank !== null) return a.riskRank - b.riskRank;
    if (a.riskRank !== null) return -1;
    if (b.riskRank !== null) return 1;
    return a.healthScore - b.healthScore;
  });

  return projects;
}
