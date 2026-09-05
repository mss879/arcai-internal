import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  buildLedger,
  invoiceStatusFor,
  type MoneyProject,
  type ProjectPaymentLike,
} from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * A client's statement of account (T4.6).
 *
 * "What does this client owe us, and how did we get there" has until now
 * been answered per project: the project page shows its ledger, the invoice
 * shows its own balance, and the client page adds the projects up. None of
 * them lists the invoices and the payments side by side with a running
 * balance, which is the one document an accountant on the client's side
 * actually asks for.
 *
 * The arithmetic is not new. Every receipt comes through `buildLedger()` —
 * the same reconciliation of `deposit_paid` against the payment rows that
 * every other screen uses — and an invoice is "outstanding" by
 * `invoiceStatusFor()`. This module only ARRANGES that money by date and
 * by currency; it never decides what counts.
 *
 * Money in, without counting anything twice:
 *
 *   • a project's ledger — deposit, payment rows, Payments-board rows;
 *   • `payments` rows with no project (money against a standalone invoice,
 *     new since 0120), and board rows linked to a client invoice alone;
 *   • an instalment ticked off on its own (it IS the money — no payments
 *     row is written for it), but never one a payments row already carries;
 *   • a recurring month received (likewise its own money).
 *
 * Client-safe and pure below the fold: `composeStatement()` takes rows and
 * returns a document, so the test can pin it. `buildClientStatement()` is
 * the fetch in front of it.
 */

export type StatementPeriod = {
  /** `YYYY-MM-DD`, inclusive. Absent = from the beginning. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive. Absent = today. */
  to?: string | null;
};

export type StatementClient = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  /** 0117 — the public link's credential. Null before the migration. */
  statementToken: string | null;
};

// ---------------------------------------------------------------------------
// Inputs — structural, like projects.ts, so the fetch can hand-pick columns.
// ---------------------------------------------------------------------------

export type StatementProjectInput = Omit<MoneyProject, "payments"> & {
  id: string;
  name: string;
  currency?: string | null;
  start_date?: string | null;
  created_at?: string | null;
  /** The project's own rows, with the two links the statement reads. */
  payments?:
    | (ProjectPaymentLike & { invoice_id?: string | null; installment_id?: string | null })[]
    | null;
};

export type StatementInvoiceInput = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  grand_total: number | string;
  /** 0120 — the reconciled figure. */
  paid_amount?: number | string | null;
  /** The legacy snapshot, read when 0120 has not reconciled the row. */
  amount_paid?: number | string | null;
  status?: string | null;
  currency?: string | null;
  project_id?: string | null;
};

/** A `payments` row with no project — money against a standalone invoice. */
export type StatementClientPaymentInput = {
  id: string;
  amount: number | string;
  currency?: string | null;
  status?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
  method?: string | null;
  notes?: string | null;
  invoice_id?: string | null;
  installment_id?: string | null;
};

/** A Payments-board row linked to a client invoice but no project. */
export type StatementBoardRowInput = {
  id: string;
  price_lkr: number | string;
  is_paid?: boolean | null;
  created_at?: string | null;
  company_name?: string | null;
  invoice_id?: string | null;
};

export type StatementPlanInput = {
  id: string;
  title: string;
  currency?: string | null;
  installments: {
    id: string;
    seq: number;
    amount: number | string;
    status: string;
    paid_at?: string | null;
    due_date: string;
    invoice_id?: string | null;
  }[];
};

export type StatementRecurringInput = {
  id: string;
  label: string;
  currency?: string | null;
  entries: {
    id: string;
    period: string;
    amount: number | string;
    currency?: string | null;
    status: string;
    received_on?: string | null;
    due_date: string;
    invoice_id?: string | null;
  }[];
};

export type ComposeStatementInput = {
  client: StatementClient;
  projects: StatementProjectInput[];
  invoices: StatementInvoiceInput[];
  clientPayments?: StatementClientPaymentInput[];
  clientBoardRows?: StatementBoardRowInput[];
  plans?: StatementPlanInput[];
  recurring?: StatementRecurringInput[];
  period?: StatementPeriod;
  /** `YYYY-MM-DD`. Defaults to the real today; tests pass one. */
  today?: string;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type StatementLine = {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  kind: "invoice" | "receipt";
  /** "Invoice #00214", "Payment", "Deposit", "Instalment 2 of 3"… */
  reference: string;
  description: string;
  /** Owed by the client — an invoice raised. */
  debit: number;
  /** Paid by the client. */
  credit: number;
  /** Running balance after this line, in this currency. */
  balance: number;
  project: string | null;
};

export type StatementOutstandingInvoice = {
  id: string;
  number: string;
  date: string;
  dueDate: string | null;
  total: number;
  paid: number;
  balance: number;
  overdue: boolean;
};

export type CurrencyStatement = {
  currency: string;
  /** Balance carried in from before `from`. Zero for an all-time statement. */
  opening: number;
  invoiced: number;
  received: number;
  closing: number;
  lines: StatementLine[];
  /** Invoices not yet settled as of today, whatever the period. */
  outstanding: StatementOutstandingInvoice[];
};

export type ClientStatement = {
  client: StatementClient;
  period: { from: string | null; to: string };
  /** `YYYY-MM-DD` the figures were read. */
  generatedAt: string;
  /** Most-used currency first. Never summed across — there is no FX here. */
  currencies: CurrencyStatement[];
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const day = (iso: string | null | undefined): string | null =>
  iso ? iso.slice(0, 10) : null;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** "September 2026" for a `YYYY-MM-01` period. */
function monthLabel(period: string): string {
  const d = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The lines and the outstanding list come from one intermediate shape. */
type RawLine = Omit<StatementLine, "balance"> & { currency: string };

// ---------------------------------------------------------------------------
// Pure: rows in, document out
// ---------------------------------------------------------------------------

export function composeStatement(input: ComposeStatementInput): ClientStatement {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const from = day(input.period?.from) || null;
  const to = day(input.period?.to) || today;

  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const invoiceById = new Map(input.invoices.map((i) => [i.id, i]));
  const invoiceRef = (id: string | null | undefined): string | null => {
    const inv = id ? invoiceById.get(id) : null;
    return inv ? `Invoice ${inv.invoice_number}` : null;
  };

  const raw: RawLine[] = [];

  // --- Debits: every live invoice --------------------------------------
  for (const inv of input.invoices) {
    if (inv.status === "void") continue;
    const project = inv.project_id ? projectById.get(inv.project_id) : null;
    raw.push({
      id: `invoice:${inv.id}`,
      date: day(inv.invoice_date) ?? today,
      kind: "invoice",
      reference: `Invoice ${inv.invoice_number}`,
      description: project?.name ?? "Invoice",
      debit: num(inv.grand_total),
      credit: 0,
      project: project?.name ?? null,
      currency: (inv.currency || "LKR").toUpperCase(),
    });
  }

  // --- Credits: the project ledgers -----------------------------------
  // Instalments a payments row already carries must not appear twice.
  const carriedInstalments = new Set<string>();
  for (const project of input.projects) {
    const currency = (project.currency || "LKR").toUpperCase();
    const undated = day(project.start_date) ?? day(project.created_at) ?? today;
    const paymentsById = new Map(
      (project.payments ?? []).map((p) => [p.id ?? "", p] as const),
    );
    for (const p of project.payments ?? []) {
      if (p.installment_id) carriedInstalments.add(p.installment_id);
    }
    for (const row of buildLedger(project)) {
      if (!row.paid) continue;
      const own = row.source === "project" ? paymentsById.get(row.id) : undefined;
      const settles = own ? invoiceRef(own.invoice_id) : null;
      raw.push({
        id: `${project.id}:${row.id}`,
        date: row.date ? day(row.date)! : undated,
        kind: "receipt",
        reference:
          row.source === "deposit"
            ? "Deposit"
            : row.source === "payments_board"
              ? "Payment (board)"
              : row.method
                ? `Payment · ${row.method}`
                : "Payment",
        description: [settles, row.note].filter(Boolean).join(" — ") || project.name,
        debit: 0,
        credit: row.amount,
        project: project.name,
        currency,
      });
    }
  }

  // --- Credits: money against a standalone invoice ---------------------
  for (const p of input.clientPayments ?? []) {
    if ((p.status ?? "paid") !== "paid") continue;
    if (p.installment_id) carriedInstalments.add(p.installment_id);
    raw.push({
      id: `payment:${p.id}`,
      date: day(p.paid_at) ?? day(p.created_at) ?? today,
      kind: "receipt",
      reference: p.method ? `Payment · ${p.method}` : "Payment",
      description: [invoiceRef(p.invoice_id), p.notes].filter(Boolean).join(" — ") || "Payment received",
      debit: 0,
      credit: num(p.amount),
      project: null,
      currency: (p.currency || "LKR").toUpperCase(),
    });
  }
  for (const b of input.clientBoardRows ?? []) {
    if (b.is_paid !== true) continue;
    raw.push({
      id: `board:${b.id}`,
      date: day(b.created_at) ?? today,
      kind: "receipt",
      reference: "Payment (board)",
      description: [invoiceRef(b.invoice_id), b.company_name].filter(Boolean).join(" — ") || "Payment received",
      debit: 0,
      credit: num(b.price_lkr),
      project: null,
      currency: "LKR",
    });
  }

  // --- Credits: an instalment ticked off on its own --------------------
  for (const plan of input.plans ?? []) {
    const total = plan.installments.length;
    for (const inst of plan.installments) {
      if (inst.status !== "paid") continue;
      if (carriedInstalments.has(inst.id)) continue;
      raw.push({
        id: `instalment:${inst.id}`,
        date: day(inst.paid_at) ?? day(inst.due_date) ?? today,
        kind: "receipt",
        reference: `Instalment ${inst.seq} of ${total}`,
        description: [invoiceRef(inst.invoice_id), plan.title].filter(Boolean).join(" — "),
        debit: 0,
        credit: num(inst.amount),
        project: null,
        currency: (plan.currency || "LKR").toUpperCase(),
      });
    }
  }

  // --- Credits: a recurring month received ------------------------------
  for (const r of input.recurring ?? []) {
    for (const e of r.entries) {
      if (e.status !== "received") continue;
      raw.push({
        id: `recurring:${e.id}`,
        date: day(e.received_on) ?? day(e.due_date) ?? today,
        kind: "receipt",
        reference: "Recurring",
        description: [invoiceRef(e.invoice_id), `${r.label} · ${monthLabel(e.period)}`]
          .filter(Boolean)
          .join(" — "),
        debit: 0,
        credit: num(e.amount),
        project: null,
        currency: (e.currency || r.currency || "LKR").toUpperCase(),
      });
    }
  }

  // --- Arrange by currency, then by date --------------------------------
  const byCurrency = new Map<string, RawLine[]>();
  for (const line of raw) {
    const list = byCurrency.get(line.currency);
    if (list) list.push(line);
    else byCurrency.set(line.currency, [line]);
  }
  // An invoice's currency decides where its "outstanding" entry sits, even
  // when it has no lines in the window.
  for (const inv of input.invoices) {
    const c = (inv.currency || "LKR").toUpperCase();
    if (!byCurrency.has(c)) byCurrency.set(c, []);
  }

  const currencies: CurrencyStatement[] = [];
  for (const [currency, lines] of byCurrency) {
    lines.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.kind === b.kind ? 0 : a.kind === "invoice" ? -1 : 1) ||
        a.id.localeCompare(b.id),
    );

    // Everything before the window is carried in as one opening figure;
    // the window itself is listed line by line with a running balance.
    const before = lines.filter((l) => from !== null && l.date < from);
    const within = lines.filter((l) => (from === null || l.date >= from) && l.date <= to);
    const opening = round2(before.reduce((s, l) => s + l.debit - l.credit, 0));

    let invoiced = 0;
    let received = 0;
    let running = opening;
    const out: StatementLine[] = within.map((line) => {
      running = round2(running + line.debit - line.credit);
      invoiced += line.debit;
      received += line.credit;
      const { currency: _c, ...rest } = line;
      void _c;
      return { ...rest, balance: running };
    });

    const outstanding: StatementOutstandingInvoice[] = input.invoices
      .filter((inv) => (inv.currency || "LKR").toUpperCase() === currency)
      .filter((inv) => inv.status !== "void")
      .map((inv) => {
        const total = num(inv.grand_total);
        const paid = num(inv.paid_amount ?? inv.amount_paid ?? 0);
        return {
          id: inv.id,
          number: inv.invoice_number,
          date: day(inv.invoice_date) ?? today,
          dueDate: day(inv.due_date),
          total,
          paid,
          balance: round2(Math.max(0, total - paid)),
          overdue: Boolean(inv.due_date) && day(inv.due_date)! < today && paid < total,
          status: invoiceStatusFor(paid, total),
        };
      })
      .filter((inv) => inv.status !== "paid" && inv.balance > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ status: _s, ...rest }) => {
        void _s;
        return rest;
      });

    currencies.push({
      currency,
      opening,
      invoiced: round2(invoiced),
      received: round2(received),
      closing: round2(opening + invoiced - received),
      lines: out,
      outstanding,
    });
  }

  // The currency with the most movement leads; an empty statement still
  // shows the client's home currency rather than nothing at all.
  currencies.sort(
    (a, b) =>
      b.lines.length - a.lines.length ||
      b.outstanding.length - a.outstanding.length ||
      a.currency.localeCompare(b.currency),
  );
  if (currencies.length === 0) {
    const home = (input.projects[0]?.currency || "LKR").toUpperCase();
    currencies.push({
      currency: home,
      opening: 0,
      invoiced: 0,
      received: 0,
      closing: 0,
      lines: [],
      outstanding: [],
    });
  }

  return {
    client: input.client,
    period: { from, to },
    generatedAt: today,
    currencies,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Read everything a client's statement needs and compose it.
 *
 * Hand-picked columns throughout — this is also what the public page and
 * the client's own portal render, so nothing internal (budgets, costs,
 * share tokens, who recorded what) is ever selected. Null when the client
 * does not exist.
 */
export async function buildClientStatement(
  db: DB,
  clientId: string,
  period: StatementPeriod = {},
): Promise<ClientStatement | null> {
  const { data: client } = await db
    .from("clients")
    .select("id, name, company, email, phone, statement_token")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: projectRows } = await db
    .from("projects")
    .select(
      "id, name, currency, total_value, deposit_paid, start_date, created_at, payments(id, amount, status, paid_at, method, notes, invoice_id, installment_id), company_payments(id, price_lkr, is_paid, created_at, company_name)",
    )
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  const projects = (projectRows ?? []) as unknown as StatementProjectInput[];
  const projectIds = projects.map((p) => p.id);

  const invoiceQuery = db
    .from("invoices")
    .select(
      "id, invoice_number, invoice_date, due_date, grand_total, paid_amount, amount_paid, status, currency, project_id",
    )
    .order("invoice_date", { ascending: true })
    .limit(500);
  const { data: invoiceRows } = projectIds.length
    ? await invoiceQuery.or(`client_id.eq.${clientId},project_id.in.(${projectIds.join(",")})`)
    : await invoiceQuery.eq("client_id", clientId);
  const invoices = (invoiceRows ?? []) as StatementInvoiceInput[];
  const invoiceIds = invoices.map((i) => i.id);

  const [clientPaymentsRes, boardRes, plansRes, recurringRes] = await Promise.all([
    invoiceIds.length
      ? db
          .from("payments")
          .select("id, amount, currency, status, paid_at, created_at, method, notes, invoice_id, installment_id")
          .is("project_id", null)
          .in("invoice_id", invoiceIds)
          .then((r) => r, () => ({ data: null }))
      : Promise.resolve({ data: null }),
    invoiceIds.length
      ? db
          .from("company_payments")
          .select("id, price_lkr, is_paid, created_at, company_name, invoice_id")
          .is("project_id", null)
          .in("invoice_id", invoiceIds)
          .then((r) => r, () => ({ data: null }))
      : Promise.resolve({ data: null }),
    db
      .from("payment_plans")
      .select(
        "id, title, currency, installments:payment_installments(id, seq, amount, status, paid_at, due_date, invoice_id)",
      )
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: null })),
    db
      .from("recurring_income")
      .select(
        "id, label, currency, entries:recurring_income_entries(id, period, amount, currency, status, received_on, due_date, invoice_id)",
      )
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: null })),
  ]);

  return composeStatement({
    client: {
      id: client.id,
      name: client.name,
      company: client.company,
      email: client.email,
      phone: client.phone,
      statementToken: client.statement_token ?? null,
    },
    projects,
    invoices,
    clientPayments: (clientPaymentsRes.data ?? []) as StatementClientPaymentInput[],
    clientBoardRows: (boardRes.data ?? []) as StatementBoardRowInput[],
    plans: ((plansRes.data ?? []) as unknown as (Omit<StatementPlanInput, "installments"> & {
      installments: StatementPlanInput["installments"] | null;
    })[]).map((p) => ({ ...p, installments: p.installments ?? [] })),
    recurring: ((recurringRes.data ?? []) as unknown as (Omit<StatementRecurringInput, "entries"> & {
      entries: StatementRecurringInput["entries"] | null;
    })[]).map((r) => ({ ...r, entries: r.entries ?? [] })),
    period,
  });
}

/** The public page and PDF for a statement token. Null when the token is unknown. */
export async function clientIdForStatementToken(db: DB, token: string): Promise<string | null> {
  const { data } = await db
    .from("clients")
    .select("id")
    .eq("statement_token", token)
    .maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return data?.id ?? null;
}
