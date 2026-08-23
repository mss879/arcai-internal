import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, ProjectAnomalyKind } from "@/lib/database.types";
import { settledAmount } from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * Quiet guards against the same money being recorded twice (AI-9).
 *
 * Deliberately RULE-BASED, not a model. Three reasons: it is arithmetic and a
 * model would be worse at it; it has to be explainable to the person being
 * told they made a mistake; and it runs over every project on every tick, so
 * it must cost nothing.
 *
 * `buildLedger()` already flags cross-table duplicates on one project's money
 * (invariant 1). This extends the same idea to the cases it can't see: the
 * same expense typed twice, a payment that overshoots the contract, two
 * projects born of one deposit.
 *
 * Every finding is FINGERPRINTED by the pair it concerns, and the fingerprint
 * is unique in the table — so dismissing one keeps it dismissed rather than
 * having it reappear on the next tick.
 */

export type AnomalyScanResult = { found: number; scanned: number };

type Finding = {
  projectId: string | null;
  kind: ProjectAnomalyKind;
  detail: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
};

/** Two ids in a stable order, so A-vs-B and B-vs-A are the same finding. */
function pairKey(kind: string, a: string, b: string): string {
  return `${kind}:${[a, b].sort().join(":")}`;
}

export async function processProjectAnomalies(
  supabase: DB,
): Promise<AnomalyScanResult> {
  const result: AnomalyScanResult = { found: 0, scanned: 0 };
  const findings: Finding[] = [];

  try {
    const { data: projects } = await supabase
      .from("projects")
      .select(
        "id, name, client_id, currency, total_value, deposit_paid, created_at, payments(id, amount, status, paid_at), company_payments(id, price_lkr, is_paid, created_at)",
      )
      .is("deleted_at", null)
      .limit(300);
    if (!projects?.length) return result;
    result.scanned = projects.length;

    const ids = projects.map((p) => p.id);
    const { data: expenses } = await supabase
      .from("project_expenses")
      .select("id, project_id, description, amount, incurred_on, vendor, receipt_path")
      .in("project_id", ids);

    // ---- 1. The same expense entered twice -------------------------------
    // Same project, same amount, same description, within a week. Anything
    // looser flags legitimate recurring costs; anything tighter misses the
    // common case of two people entering the same supplier bill.
    const byProject = new Map<string, typeof expenses>();
    for (const e of expenses ?? []) {
      const list = byProject.get(e.project_id) ?? [];
      list.push(e);
      byProject.set(e.project_id, list);
    }

    for (const [projectId, list] of byProject) {
      const rows = list ?? [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i];
          const b = rows[j];
          if (Number(a.amount) !== Number(b.amount)) continue;
          if (
            a.description.trim().toLowerCase() !== b.description.trim().toLowerCase()
          )
            continue;
          const gap = Math.abs(
            Date.parse(`${a.incurred_on}T00:00:00Z`) -
              Date.parse(`${b.incurred_on}T00:00:00Z`),
          );
          if (gap > 7 * 24 * 3600_000) continue;

          findings.push({
            projectId,
            kind: "duplicate_expense",
            detail: `"${a.description}" appears twice at ${Number(a.amount).toLocaleString()} — ${a.incurred_on} and ${b.incurred_on}.`,
            evidence: {
              expense_ids: [a.id, b.id],
              amount: Number(a.amount),
              dates: [a.incurred_on, b.incurred_on],
              vendor: a.vendor,
            },
            fingerprint: pairKey("dup_exp", a.id, b.id),
          });
        }
      }
    }

    // ---- 2. Money recorded twice, and money that overshoots --------------
    for (const row of projects) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = row as any;
      const own: { id: string; amount: number; status: string; paid_at: string | null }[] =
        p.payments ?? [];
      const linked: {
        id: string;
        price_lkr: number;
        is_paid: boolean;
        created_at: string;
      }[] = p.company_payments ?? [];

      // The same amount paid on both boards within 3 days is almost always one
      // payment entered in two places — the exact mistake settledAmount()
      // reconciles for the deposit but cannot see across the payment tables.
      for (const o of own.filter((x) => (x.status ?? "paid") === "paid")) {
        for (const l of linked.filter((x) => x.is_paid)) {
          if (Number(o.amount) !== Number(l.price_lkr)) continue;
          const oDate = o.paid_at ? Date.parse(o.paid_at) : null;
          const lDate = Date.parse(l.created_at);
          if (oDate === null || Math.abs(oDate - lDate) > 3 * 24 * 3600_000) continue;

          findings.push({
            projectId: p.id,
            kind: "duplicate_payment",
            detail: `${Number(o.amount).toLocaleString()} is recorded both on this project and on the Payments board within three days — check it isn't the same payment counted twice.`,
            evidence: {
              payment_id: o.id,
              company_payment_id: l.id,
              amount: Number(o.amount),
            },
            fingerprint: pairKey("dup_pay", o.id, l.id),
          });
        }
      }

      // Received well past the contract value. A small overshoot is a rounding
      // or a tip; 5% and 1,000 over is someone billing the wrong project.
      const total = Number(p.total_value) || 0;
      if (total > 0) {
        const received = settledAmount({
          deposit_paid: p.deposit_paid,
          payments: own,
          company_payments: linked,
        });
        const over = received - total;
        if (over > 1000 && over / total > 0.05) {
          findings.push({
            projectId: p.id,
            kind: "payment_over_value",
            detail: `${received.toLocaleString()} received against a ${total.toLocaleString()} contract — ${Math.round(over).toLocaleString()} more than the project is worth.`,
            evidence: { received, total_value: total, over },
            // Keyed on the overshoot amount, so it re-raises only if it grows.
            fingerprint: `over_value:${p.id}:${Math.round(over)}`,
          });
        }
      }
    }

    // ---- 3. Two projects from one deposit --------------------------------
    // Same client, same value, created within a day of each other. This is
    // what an automation firing twice looks like from the outside.
    const byClient = new Map<string, typeof projects>();
    for (const p of projects) {
      if (!p.client_id) continue;
      const list = byClient.get(p.client_id) ?? [];
      list.push(p);
      byClient.set(p.client_id, list);
    }
    for (const list of byClient.values()) {
      const rows = list ?? [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i];
          const b = rows[j];
          const aValue = Number(a.total_value) || 0;
          if (aValue === 0 || aValue !== (Number(b.total_value) || 0)) continue;
          if (
            Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at)) >
            24 * 3600_000
          )
            continue;

          findings.push({
            projectId: a.id,
            kind: "duplicate_project",
            detail: `"${a.name}" and "${b.name}" are the same client, the same value and were created within a day — one deposit may have created two projects.`,
            evidence: {
              project_ids: [a.id, b.id],
              names: [a.name, b.name],
              value: aValue,
            },
            fingerprint: pairKey("dup_proj", a.id, b.id),
          });
        }
      }
    }

    // ---- Record, skipping anything already raised or dismissed ------------
    for (const f of findings) {
      const { data: existing } = await supabase
        .from("project_anomalies")
        .select("id")
        .eq("fingerprint", f.fingerprint)
        .maybeSingle();
      if (existing) continue;

      const { error } = await supabase.from("project_anomalies").insert({
        project_id: f.projectId,
        kind: f.kind,
        detail: f.detail,
        evidence: f.evidence,
        fingerprint: f.fingerprint,
      });
      // A unique-violation here is two ticks racing, not a problem.
      if (!error) result.found++;
    }
  } catch (e) {
    console.error("[project-anomalies] scan failed:", e);
  }

  return result;
}
