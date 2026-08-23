import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { AFTERCARE_TASKS } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import { nextInvoiceNumber } from "@/lib/invoice";
import { settledAmount } from "@/lib/projects";
import { sendPushToUser } from "@/lib/push";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

export type ProjectAutomationResult = {
  budget_alerts: number;
  retainers_created: number;
  balance_chases: number;
  aftercare_batches: number;
};

/**
 * The project timers, run from the one automation tick.
 *
 * Four jobs, all of them bookkeeping-guarded so nothing can fire twice:
 *
 *   1. BUDGET ALERTS (MON-2) — a project whose recorded costs pass its cap
 *      tells the team once, not every minute.
 *   2. RETAINERS (MON-6) — on its nominated day of the month a recurring
 *      project produces next month's copy, carrying the template forward.
 *   3. BALANCE CHASE (MON-11) — an unpaid balance on a delivered project is
 *      chased on an escalating ladder rather than forgotten.
 *   4. AFTERCARE (PLAN-12) — a delivered project with aftercare on keeps
 *      generating its monthly maintenance work.
 *
 * Never throws: the tick runs everything else after it.
 */
export async function processProjectAutomations(
  supabase: DB,
): Promise<ProjectAutomationResult> {
  const result: ProjectAutomationResult = {
    budget_alerts: 0,
    retainers_created: 0,
    balance_chases: 0,
    aftercare_batches: 0,
  };

  for (const step of [
    () => runBudgetAlerts(supabase, result),
    () => runRetainers(supabase, result),
    () => runBalanceChases(supabase, result),
    () => runAftercare(supabase, result),
  ]) {
    try {
      await step();
    } catch (e) {
      console.error("[project-automation] step failed:", e);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 1. Budget alerts (MON-2)
// ---------------------------------------------------------------------------

async function runBudgetAlerts(db: DB, result: ProjectAutomationResult) {
  const { data: projects } = await db
    .from("projects")
    .select("id, name, currency, budget, expense_cap")
    .is("deleted_at", null)
    .is("budget_alerted_at", null)
    .in("status", ["planning", "active", "on_hold"])
    .limit(200);

  for (const project of projects ?? []) {
    // expense_cap wins when set; `budget` is the fallback so the column that
    // sat inert on the header finally does something.
    const cap = Number(project.expense_cap ?? project.budget ?? 0);
    if (cap <= 0) continue;

    // 0100 — both ledgers. A cap that ignores the hosting bill booked in
    // Finance is a cap that never trips on the projects that need it to.
    const [{ data: expenses }, { data: financeCosts }] = await Promise.all([
      db.from("project_expenses").select("amount").eq("project_id", project.id),
      db.from("expenses").select("amount").eq("project_id", project.id),
    ]);
    const spend = [...(expenses ?? []), ...(financeCosts ?? [])].reduce(
      (s, e) => s + Number(e.amount ?? 0),
      0,
    );
    if (spend <= cap) continue;

    await notifyTeam(db, {
      title: "Project over budget",
      body: `${project.name} has spent ${project.currency} ${spend.toLocaleString()} against a ${project.currency} ${cap.toLocaleString()} cap.`,
      link: `/projects/${project.id}`,
    });
    await db
      .from("projects")
      .update({ budget_alerted_at: new Date().toISOString() })
      .eq("id", project.id);

    // 0096 — same crossing, same once-per-project guard, now available to
    // the automation engine as a trigger.
    const { fireExpensesOverBudget } = await import("@/lib/project-events");
    await fireExpensesOverBudget(db, project.id, {
      spent: spend,
      cap,
      currency: project.currency,
    });
    result.budget_alerts++;
  }
}

// ---------------------------------------------------------------------------
// 2. Retainers (MON-6)
// ---------------------------------------------------------------------------

async function runRetainers(db: DB, result: ProjectAutomationResult) {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const thisMonth = today.toISOString().slice(0, 7);

  const { data: retainers } = await db
    .from("projects")
    .select(
      "id, name, client_id, currency, total_value, budget, service_type, template_id, retainer_day, retainer_last_run_on, aftercare_enabled, deposit_required_percent",
    )
    .eq("is_retainer", true)
    .is("deleted_at", null)
    .lte("retainer_day", dayOfMonth)
    .limit(100);

  for (const parent of retainers ?? []) {
    // One child per calendar month, whatever happens to the tick.
    if ((parent.retainer_last_run_on ?? "").slice(0, 7) === thisMonth) continue;

    const monthLabel = today.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    // Strip any month already in the parent's name so a series doesn't end up
    // called "Retainer — July 2026 — August 2026".
    const base = parent.name.replace(/\s+[—-]\s+[A-Z][a-z]+ \d{4}\s*$/, "").trim();

    const { data: child, error } = await db
      .from("projects")
      .insert({
        name: `${base} — ${monthLabel}`,
        description: `Retainer month generated automatically from "${parent.name}".`,
        client_id: parent.client_id,
        status: "active",
        currency: parent.currency,
        total_value: parent.total_value,
        budget: parent.budget,
        service_type: parent.service_type,
        template_id: parent.template_id,
        retainer_parent_id: parent.id,
        deposit_required_percent: parent.deposit_required_percent,
        start_date: today.toISOString().slice(0, 10),
        // The month it bills for is the month it should be finished in.
        due_date: endOfMonth(today),
        created_by: null,
      })
      .select("id, name")
      .single();

    if (error || !child) {
      console.error("[project-automation] retainer insert failed:", error?.message);
      continue;
    }

    // Carry the plan forward too — a retainer month with no tasks is just a
    // row in a table.
    if (parent.template_id) {
      await seedFromTemplate(db, child.id, parent.template_id, today);
    }

    await db
      .from("projects")
      .update({ retainer_last_run_on: today.toISOString().slice(0, 10) })
      .eq("id", parent.id);

    // 0096 — a retainer month is a real new project, so the kickoff flows
    // (seed the plan, staff it, send the portal) run for it too.
    const { fireProjectCreated } = await import("@/lib/project-events");
    await fireProjectCreated(db, child.id, "retainer");

    await notifyTeam(db, {
      title: "Retainer month created",
      body: child.name,
      link: `/projects/${child.id}`,
    });
    result.retainers_created++;
  }
}

function endOfMonth(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

/**
 * The tick's own copy of "apply a template".
 *
 * Kept separate from the server action in plan-actions.ts on purpose: this one
 * runs with no signed-in user, seeds only tasks and milestones (a retainer
 * month rarely needs the client's brand assets collected again), and must
 * never throw into the tick.
 */
async function seedFromTemplate(
  db: DB,
  projectId: string,
  templateId: string,
  start: Date,
): Promise<void> {
  const { data: items } = await db
    .from("project_template_items")
    .select("*")
    .eq("template_id", templateId)
    .in("kind", ["task", "milestone"])
    .order("position");
  if (!items?.length) return;

  const dateFor = (offset: number | null) => {
    if (offset === null || offset === undefined) return null;
    const d = new Date(start);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const todos = items
    .filter((i) => i.kind === "task")
    .map((i) => ({
      title: i.title,
      description: i.detail,
      priority: i.priority,
      project_id: projectId,
      due_date: dateFor(i.offset_days) ? `${dateFor(i.offset_days)}T17:00:00` : null,
      position: i.position,
      created_by: null,
    }));
  const milestones = items
    .filter((i) => i.kind === "milestone")
    .map((i) => ({
      project_id: projectId,
      title: i.title,
      detail: i.detail,
      kind: "milestone" as const,
      due_date: dateFor(i.offset_days),
      position: i.position,
      created_by: null,
    }));

  if (todos.length) await db.from("todos").insert(todos);
  if (milestones.length) await db.from("project_milestones").insert(milestones);
}

// ---------------------------------------------------------------------------
// 3. Balance chase ladder (MON-11)
// ---------------------------------------------------------------------------

/** Days after delivery at which each rung of the ladder fires. */
const CHASE_LADDER = [7, 14, 21] as const;

async function runBalanceChases(db: DB, result: ProjectAutomationResult) {
  const { data: projects } = await db
    .from("projects")
    .select(
      "id, name, currency, total_value, deposit_paid, client_id, delivery_stage, delivery_stage_changed_at, balance_chase_count, balance_chased_at, balance_chase_paused",
    )
    .is("deleted_at", null)
    .eq("balance_chase_paused", false)
    .in("delivery_stage", ["delivered", "aftercare"])
    .limit(100);

  for (const project of projects ?? []) {
    const rung = project.balance_chase_count ?? 0;
    if (rung >= CHASE_LADDER.length) continue;

    const deliveredAt = project.delivery_stage_changed_at;
    if (!deliveredAt) continue;
    const daysSinceDelivery = Math.floor(
      (Date.now() - new Date(deliveredAt).getTime()) / 86_400_000,
    );
    if (daysSinceDelivery < CHASE_LADDER[rung]) continue;

    // A rung a week apart, even if the project was delivered long ago and the
    // ladder is catching up.
    if (project.balance_chased_at) {
      const sinceLast = Math.floor(
        (Date.now() - new Date(project.balance_chased_at).getTime()) / 86_400_000,
      );
      if (sinceLast < 5) continue;
    }

    const [{ data: linked }, { data: own }] = await Promise.all([
      db.from("company_payments").select("price_lkr, is_paid").eq("project_id", project.id),
      db.from("payments").select("amount, status").eq("project_id", project.id),
    ]);
    const received = settledAmount({
      deposit_paid: project.deposit_paid,
      company_payments: linked ?? [],
      payments: own ?? [],
    });
    const balance = Math.max(0, Number(project.total_value ?? 0) - received);

    // Settled while we weren't looking — reset the ladder so a future project
    // balance starts from the friendly rung again.
    if (balance <= 0) {
      if (rung > 0) {
        await db
          .from("projects")
          .update({ balance_chase_count: 0, balance_chased_at: null })
          .eq("id", project.id);
      }
      continue;
    }

    const client = project.client_id
      ? (
          await db
            .from("clients")
            .select("name, phone")
            .eq("id", project.client_id)
            .maybeSingle()
        ).data
      : null;

    const amount = `${project.currency} ${balance.toLocaleString()}`;
    const firstName = (client?.name ?? "there").split(/\s+/)[0];
    const message = [
      `Hi ${firstName}, hope you're happy with "${project.name}". The balance of ${amount} is now due — the bank details are on your invoice. Thank you!`,
      `Hi ${firstName}, a reminder that ${amount} is still outstanding on "${project.name}". Could you let us know when it will be settled?`,
      `Hi ${firstName}, the balance of ${amount} on "${project.name}" is now ${daysSinceDelivery} days past delivery. Please arrange payment or contact us at support@arcai.agency so we can sort it out.`,
    ][rung];

    let sent = false;
    const phone = normalizePhone(client?.phone ?? "");
    if (isSmsConfigured() && phone.ok) {
      const res = await sendSms({
        to: phone.value,
        message,
        contactName: client?.name || undefined,
      });
      await db.from("sms_messages").insert({
        to_number: phone.value,
        message,
        client_id: project.client_id,
        client_name: client?.name ?? "",
        kind: "payment_reminder",
        status: res.ok ? "sent" : "failed",
        error: res.ok ? null : res.error,
        segments: countSmsSegments(message),
        created_by: null,
      });
      sent = res.ok;
    }

    // No phone, no SMS credentials, or a send failure: the team still needs to
    // know the rung came due, so the ladder never silently stalls.
    if (!sent) {
      await notifyTeam(db, {
        title: "Balance chase needs a human",
        body: `${project.name} — ${amount} outstanding. Couldn't text the client.`,
        link: `/projects/${project.id}`,
      });
    }

    await db
      .from("projects")
      .update({
        balance_chase_count: rung + 1,
        balance_chased_at: new Date().toISOString(),
      })
      .eq("id", project.id);
    result.balance_chases++;
  }
}

// ---------------------------------------------------------------------------
// 4. Aftercare (PLAN-12)
// ---------------------------------------------------------------------------

async function runAftercare(db: DB, result: ProjectAutomationResult) {
  const today = new Date();
  const month = today.toISOString().slice(0, 7);

  const { data: projects } = await db
    .from("projects")
    .select("id, name, aftercare_last_run_on")
    .eq("aftercare_enabled", true)
    .is("deleted_at", null)
    .in("delivery_stage", ["delivered", "aftercare"])
    .limit(100);

  for (const project of projects ?? []) {
    if ((project.aftercare_last_run_on ?? "").slice(0, 7) === month) continue;

    const { data: owner } = await db
      .from("project_members")
      .select("user_id")
      .eq("project_id", project.id)
      .eq("is_owner", true)
      .maybeSingle();

    const rows = AFTERCARE_TASKS.map((t, i) => ({
      title: `${t.title} (${month})`,
      description: t.description,
      project_id: project.id,
      assigned_to: owner?.user_id ?? null,
      priority: "medium" as const,
      position: i,
      created_by: null,
    }));

    const { error } = await db.from("todos").insert(rows);
    if (error) {
      console.error("[project-automation] aftercare insert failed:", error.message);
      continue;
    }

    await db
      .from("projects")
      .update({ aftercare_last_run_on: today.toISOString().slice(0, 10) })
      .eq("id", project.id);
    result.aftercare_batches++;
  }
}

// ---------------------------------------------------------------------------
// Auto-invoice on delivery (MON-4)
// ---------------------------------------------------------------------------

export type AutoInvoiceResult =
  | { ok: true; invoiceId: string; invoiceNumber: string; total: number }
  | { ok: false; detail: string };

/**
 * Raise the balance invoice for a project.
 *
 * Contract value plus every billable extra that hasn't been invoiced yet,
 * minus what the client has already paid. The extras are stamped `invoiced_at`
 * in the same breath, which is the existing guard against billing a cost
 * twice — so this can be called from the delivery stage move without any risk
 * of a double charge if it somehow runs again.
 *
 * Returns a saved invoice, not a PDF: the team downloads or emails it from
 * /invoices exactly like one they typed.
 */
export async function generateProjectInvoice(
  db: DB,
  projectId: string,
): Promise<AutoInvoiceResult> {
  const { data: project } = await db
    .from("projects")
    .select(
      "id, name, currency, total_value, deposit_paid, service_type, description, client:clients(name, company, email, phone)",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, detail: "Project not found." };

  const [{ data: extras }, { data: linked }, { data: own }, { data: numbers }] =
    await Promise.all([
      db
        .from("project_expenses")
        .select("id, description, detail, qty, unit_amount, amount")
        .eq("project_id", projectId)
        .eq("billable", true)
        .is("invoiced_at", null),
      db.from("company_payments").select("price_lkr, is_paid").eq("project_id", projectId),
      db.from("payments").select("amount, status").eq("project_id", projectId),
      db.from("invoices").select("invoice_number"),
    ]);

  const received = settledAmount({
    deposit_paid: project.deposit_paid,
    company_payments: linked ?? [],
    payments: own ?? [],
  });

  const contract = Number(project.total_value ?? 0);
  const items = [
    ...(contract > 0
      ? [
          {
            item: project.name,
            description:
              project.description ?? "Project as agreed.",
            qty: "1",
            rate: String(contract),
            total: contract,
          },
        ]
      : []),
    ...(extras ?? []).map((e) => ({
      item: e.description,
      description: e.detail ?? "",
      qty: String(e.qty),
      rate: String(e.unit_amount),
      total: Number(e.amount),
    })),
  ];

  if (items.length === 0)
    return { ok: false, detail: "Nothing to invoice — no value and no billable extras." };

  const grandTotal = items.reduce((s, i) => s + i.total, 0);
  const balance = Math.max(0, grandTotal - received);
  if (balance <= 0)
    return { ok: false, detail: "Nothing outstanding — the project is fully paid." };

  const client = project.client as unknown as {
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  } | null;

  const invoiceNumber = nextInvoiceNumber(
    (numbers ?? []).map((n) => n.invoice_number),
  );

  const { data: invoice, error } = await db
    .from("invoices")
    .insert({
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      bill_to_name: client?.name ?? project.name,
      bill_to_details: [client?.company, client?.email, client?.phone]
        .filter(Boolean)
        .join("\n"),
      items,
      grand_total: grandTotal,
      amount_paid: received,
      due_today: balance,
      project_id: projectId,
      recipient_email: client?.email ?? null,
      created_by: null,
    })
    .select("id, invoice_number")
    .single();

  if (error || !invoice) return { ok: false, detail: error?.message ?? "Insert failed." };

  if (extras?.length) {
    await db
      .from("project_expenses")
      .update({ invoiced_at: new Date().toISOString() })
      .in(
        "id",
        extras.map((e) => e.id),
      );
  }

  await notifyTeam(db, {
    title: `Invoice ${invoice.invoice_number} raised`,
    body: `${project.name} — ${project.currency} ${balance.toLocaleString()} due.`,
    // appLink is null when NEXT_PUBLIC_APP_URL is unset; the in-app
    // notification only needs the relative path anyway.
    link: "/invoices",
  });

  return {
    ok: true,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    total: balance,
  };
}

// ---------------------------------------------------------------------------

/** In-app + push to every member, the way delivery alerts already do it. */
async function notifyTeam(
  db: DB,
  n: { title: string; body: string; link: string },
): Promise<void> {
  const { data: members } = await db.from("profiles").select("id");
  if (!members?.length) return;

  await db.from("notifications").insert(
    members.map((m) => ({
      user_id: m.id,
      type: "system" as const,
      title: n.title,
      body: n.body,
      link: n.link,
    })),
  );
  await Promise.all(
    members.map((m) =>
      sendPushToUser({
        userId: m.id,
        title: n.title,
        body: n.body,
        link: n.link,
      }).catch(() => undefined),
    ),
  );
}
