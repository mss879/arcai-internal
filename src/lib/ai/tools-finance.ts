import "server-only";

/**
 * The assistant's finance desk — Money & Finance, Payments, Invoices &
 * Quotes, and Notice Generation.
 *
 * Money is the one area where a confidently wrong number does real damage, so
 * this module never invents a figure and never re-derives one that already has
 * an owner: `settledAmount()` decides what a project has received,
 * `projectCostsByProject()` is the only legal merge of the two cost ledgers,
 * `summariseMemberMoney()` decides what a member is owed, and the write tools
 * go through the very server actions the pages use so a payment recorded by
 * voice fires the same automations a click does.
 *
 * Two things shape the tool list. First, the model already carries 30-odd
 * schemas, and every extra one costs it accuracy — so this is six tools with
 * real parameters rather than twenty narrow ones, with `finance_query`
 * carrying a `dataset` enum instead of a list tool per table. Second, "how
 * much are we owed?" has four defensible answers in this codebase (unpaid
 * Payments-board rows, pending installments, pending cheques in, this month's
 * unlanded recurring). Rather than silently picking one, `finance_overview`
 * returns all four labelled and lets the human choose.
 *
 * Every read hands back an artifact so the answer is visible in the preview
 * canvas, and nothing here sends an email, an SMS or a WhatsApp message —
 * that stays with the existing prepare_* confirm-card path, where a person
 * presses Send.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type { InvoiceCardData } from "@/lib/assistant-cards";
import type {
  AppArea,
  Artifact,
  ArtifactColumn,
  ArtifactField,
  ArtifactRow,
  ArtifactTone,
} from "@/lib/assistant-artifacts";
import {
  chartArtifact,
  metricsArtifact,
  recordArtifact,
  rowsToTable,
  tableArtifact,
  timelineArtifact,
} from "@/lib/assistant-artifacts";
import type {
  ChequeStatus,
  Database,
  ExpenseCategory,
  InvoiceItem,
  RecurringIncomeCategory,
} from "@/lib/database.types";
import { attachRepayments, loanBalance, loanRepaid, summariseMemberMoney } from "@/lib/loans";
import { projectCostsByProject } from "@/lib/project-costs";
import {
  balanceDue,
  commissionEarned,
  marginIsMeaningful,
  projectMargin,
  settledAmount,
} from "@/lib/projects";

type DB = SupabaseClient<Database>;

// ---- Tool schemas advertised to the model --------------------------------

/** Tool schemas advertised to the model for this area. */
export const FINANCE_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "finance_overview",
      description:
        "The money picture for one month: cash in, cash out, profit, what is still to collect, and the standing recurring income — plus a month-by-month series and this month's spend by category. Call this for 'how did we do this month', 'what's our profit', 'how much came in', 'what are we owed', 'compare this month to last month' or 'numbers for the accountant'. Cash in = paid project payments + paid installments + received recurring months, exactly as the Finance page counts it; the Payments board is a separate ledger, so use finance_query for that.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "Month as YYYY-MM (e.g. '2026-08'). Defaults to the current month in Colombo.",
          },
          months_back: {
            type: "integer",
            description:
              "How many months the trend series should cover, ending at `month`. Default 6, max 12.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance_query",
      description:
        "List any finance record set as a table: pick the `dataset`. payments_board = the Payments page (who owes us). project_payments = cash booked against projects. expenses = the company spend ledger. installments / plans = payment schedules. cheques = cheques in and out. recurring / recurring_entries = standing monthly income and the individual months. invoices / quotes / notices = saved documents. client_balances = received vs still-owed per client. project_margins = revenue, cost and profit per project. Use this for 'who hasn't paid', 'what did we spend on ads', 'which cheques are due', 'which installments are overdue', 'show me the quotes I sent', 'what notices went out' and 'is that project profitable'.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [
              "payments_board",
              "project_payments",
              "expenses",
              "installments",
              "plans",
              "cheques",
              "recurring",
              "recurring_entries",
              "invoices",
              "quotes",
              "notices",
              "client_balances",
              "project_margins",
            ],
          },
          month: {
            type: "string",
            description: "Restrict to one month, as YYYY-MM. Ignored by plans, recurring, client_balances and project_margins.",
          },
          from: { type: "string", description: "Window start, YYYY-MM-DD (inclusive)." },
          to: { type: "string", description: "Window end, YYYY-MM-DD (inclusive)." },
          status: {
            type: "string",
            description:
              "Dataset-specific filter. payments_board: unpaid|paid|pending|upcoming. project_payments: pending|paid|overdue. installments: pending|paid|overdue. plans: active|completed|cancelled. cheques: pending|deposited|cleared|bounced|cancelled|due_soon|overdue. recurring: active|inactive. recurring_entries: pending|received|skipped|overdue. invoices: sent|unsent|outstanding|settled. quotes: draft|sent|viewed|accepted|declined|expired|open. notices: sent|unsent. 'overdue', 'due_soon', 'outstanding' and 'expired' are derived from dates, not stored.",
          },
          category: {
            type: "string",
            description:
              "expenses: salaries|rent|software|ads|hosting|equipment|transport|utilities|fees|other. recurring: retainer|hosting|maintenance|subscription|rent|other.",
          },
          direction: {
            type: "string",
            enum: ["received", "issued"],
            description: "cheques only — 'received' = money coming in, 'issued' = cheques we wrote.",
          },
          query: {
            type: "string",
            description:
              "Name/number contains-match: company, client, project, plan, arrangement, invoice or quote number, notice recipient.",
          },
          limit: { type: "integer", description: "Rows to return. Default 25, max 100." },
        },
        required: ["dataset"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_finance_document",
      description:
        "Pull up ONE saved invoice, quote or notice in full — line items, totals, balance, who it went to and whether it was sent. Use for 'show me invoice 00214', 'what was the last invoice I made', 'did they accept that quote' or 'show me the notice we sent them'. With no reference it returns the most recent one the signed-in user created.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["invoice", "quote", "notice"] },
          reference: {
            type: "string",
            description:
              "Document number ('00214', '#00214') or the customer/recipient name. Numbers are matched digits-only, so '214' finds '#00214'.",
          },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "member_money",
      description:
        "One team member's money: commission earned, paid out and still owed, plus their loans, repayments and outstanding balance. Use for 'how much commission am I owed', 'what do I still owe on my loan' or 'how much has Kamal repaid'. Commission and loan rows are restricted — a non-admin can only see their own, so this refuses rather than showing a member someone else's subset.",
      parameters: {
        type: "object",
        properties: {
          member: {
            type: "string",
            description: "Member name, or 'me' for the signed-in user. Defaults to 'me'.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_expense",
      description:
        "Log a cost in the company expense ledger on the Money & Finance page — rent, salaries, ads, software, hosting. Use for 'log 45,000 for Facebook ads' or 'we paid 12,000 for hosting'. Link it to a project only when the user says which project the cost belongs to; a linked cost is treated as absorbed and eats that project's margin. For a re-billable extra raised ON a project, use log_project_expense instead.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Total paid in LKR, VAT included." },
          description: { type: "string", description: "What the money went on." },
          category: {
            type: "string",
            enum: [
              "salaries",
              "rent",
              "software",
              "ads",
              "hosting",
              "equipment",
              "transport",
              "utilities",
              "fees",
              "other",
            ],
          },
          vendor: { type: "string", description: "Who was paid." },
          date: { type: "string", description: "ISO date (YYYY-MM-DD). Defaults to today." },
          payment_method: { type: "string", description: "Cash, bank transfer, card…" },
          tax_amount: {
            type: "number",
            description: "The VAT portion INCLUDED IN `amount` — never added on top.",
          },
          project: { type: "string", description: "Project name, when the cost belongs to one." },
        },
        required: ["amount", "description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_money_received",
      description:
        "Mark money as arrived: an installment paid, a cheque cleared, a recurring month received, or a Payments-board row settled. Use for 'mark the second installment paid', 'that cheque cleared' or 'the hosting money came in'. It only acts when the reference matches exactly one open item — otherwise it lists the candidates and changes nothing, so ask the user which one.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["installment", "cheque", "recurring", "payments_board"],
          },
          reference: {
            type: "string",
            description:
              "Who or what it is: plan title or contact, cheque number or party, arrangement label, or the company name on the Payments board.",
          },
          amount: {
            type: "number",
            description:
              "Narrows the match when several items share a name. For a recurring month it also records what actually arrived, if it differed.",
          },
          month: {
            type: "string",
            description: "Recurring only — which month landed, as YYYY-MM. Defaults to this month.",
          },
          cheque_status: {
            type: "string",
            enum: ["deposited", "cleared", "bounced", "cancelled"],
            description: "Cheques only. Defaults to 'cleared'.",
          },
        },
        required: ["kind", "reference"],
        additionalProperties: false,
      },
    },
  },
];

// ---- Small shared helpers ------------------------------------------------

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Coerce anything Postgres hands back (numeric arrives as a string) to a number. */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function total<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0);
}

/** "2026-08-25T…" / "2026-08-25" -> "2026-08". */
function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Month arithmetic on the YYYY-MM string rather than a Date.
 *
 * `new Date(y, m - i, 1).toISOString()` is what the Finance page does, and in
 * a UTC+5:30 workspace it can name the previous month at a boundary. Strings
 * cannot drift.
 */
function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const month = ((total % 12) + 12) % 12;
  return `${Math.floor(total / 12)}-${String(month + 1).padStart(2, "0")}`;
}

/** Last calendar day of a YYYY-MM month, computed in UTC so no zone shifts it. */
function monthEnd(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(day).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

// Plain booleans rather than type predicates: every caller already holds a
// string, and a predicate would narrow the else-branch to `never`.
function isMonth(v: string): boolean {
  return /^\d{4}-\d{2}$/.test(v);
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** The month to report on: what was asked for, else today's (already Colombo-local). */
function resolveMonth(raw: unknown, ctx: ToolContext): string {
  const v = String(raw ?? "").trim();
  if (isMonth(v)) return v;
  if (isDate(v)) return v.slice(0, 7);
  return ctx.today.slice(0, 7);
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Strip the characters PostgREST reads as filter syntax before a search term
 * is baked into an `ilike` pattern or an `or()` string. `or()` is appended
 * raw and split on commas and parentheses, so a member called "Perera, Nimal"
 * would otherwise split one filter into two malformed ones and fail with a
 * 400. `%` and `*` are the wildcards, and a term carrying its own would
 * quietly widen the match. Mirrors `safeLike` in the delivery and growth
 * modules; `.` is safe inside a value and is kept.
 */
function safeLike(s: string): string {
  return s.replace(/[,()%*\\]/g, " ").replace(/\s+/g, " ").trim();
}

function clampLimit(v: unknown, fallback = 25): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** Digits only, leading zeros stripped — so "214" and "#00214" are the same document. */
function normalizeNo(s: string): string {
  return s.replace(/\D/g, "").replace(/^0+/, "");
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** Names for a set of project ids, for tables that show a project column. */
async function projectNames(supabase: DB, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const { data } = await supabase.from("projects").select("id, name").in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.name]));
}

/** Contains-match on a project name. Archived projects never match. */
async function findProjectRow(
  supabase: DB,
  name: unknown,
): Promise<{ id: string; name: string } | null> {
  const q = str(name);
  if (!q) return null;
  const { data } = await supabase
    .from("projects")
    .select("id, name")
    .is("deleted_at", null)
    .ilike("name", `%${safeLike(q)}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "salaries", "rent", "software", "ads", "hosting",
  "equipment", "transport", "utilities", "fees", "other",
];

const RECURRING_CATEGORIES: RecurringIncomeCategory[] = [
  "retainer", "hosting", "maintenance", "subscription", "rent", "other",
];

const CHEQUE_SETTLE_STATUSES: ChequeStatus[] = ["deposited", "cleared", "bounced", "cancelled"];

/** Money cells stay raw numbers — the artifact renderer owns the "Rs. " prefix. */
const money = (v: number): number => Math.round(v * 100) / 100;

// ---- finance_overview ----------------------------------------------------

type Flow = { date: string; amount: number };

/**
 * Everything the overview reads, fetched once.
 *
 * The row caps are deliberately generous rather than paged: a month's answer
 * has to be one round-trip, and a workspace that outgrows them would be
 * quietly wrong on the OLDEST month of the trend, never on the month being
 * asked about — every read is ordered newest-first for that reason.
 */
async function loadOverview(supabase: DB) {
  const [payments, installments, entries, arrangements, expenses, cheques, board] =
    await Promise.all([
      supabase
        .from("payments")
        .select("amount, paid_at, created_at")
        .eq("status", "paid")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("payment_installments")
        .select("amount, due_date, status, paid_at")
        .order("due_date", { ascending: false })
        .limit(1000),
      supabase
        .from("recurring_income_entries")
        .select("amount, due_date, status, received_on, period")
        .order("due_date", { ascending: false })
        .limit(1000),
      supabase
        .from("recurring_income")
        .select("amount, is_active")
        .order("is_active", { ascending: false })
        .limit(500),
      supabase
        .from("expenses")
        .select("expense_date, category, amount, tax_amount")
        .order("expense_date", { ascending: false })
        .limit(1000),
      supabase
        .from("cheques")
        .select("amount, direction, status")
        .order("due_date", { ascending: false })
        .limit(500),
      supabase
        .from("company_payments")
        .select("price_lkr, is_paid, status")
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);

  const error =
    payments.error ??
    installments.error ??
    entries.error ??
    arrangements.error ??
    expenses.error ??
    cheques.error ??
    board.error;

  return { payments, installments, entries, arrangements, expenses, cheques, board, error };
}

async function financeOverview(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const month = resolveMonth(args.month, ctx);
  const back = Math.min(12, Math.max(1, Number(args.months_back) || 6));

  const data = await loadOverview(ctx.supabase);
  if (data.error) return { content: { ok: false, error: data.error.message } };

  // Money in, exactly as the Finance overview counts it: paid project
  // payments + paid installments + RECEIVED recurring months. A pending
  // recurring month is a promise, and a promise in a cash-flow number is how
  // a month looks fine right up until payroll.
  const inflows: Flow[] = [
    ...(data.payments.data ?? []).map((p) => ({
      date: (p.paid_at ?? p.created_at).slice(0, 10),
      amount: num(p.amount),
    })),
    ...(data.installments.data ?? [])
      .filter((i) => i.status === "paid")
      .map((i) => ({ date: (i.paid_at ?? i.due_date).slice(0, 10), amount: num(i.amount) })),
    ...(data.entries.data ?? [])
      .filter((e) => e.status === "received")
      .map((e) => ({ date: (e.received_on ?? e.due_date).slice(0, 10), amount: num(e.amount) })),
  ];
  const outflows: Flow[] = (data.expenses.data ?? []).map((e) => ({
    date: e.expense_date,
    amount: num(e.amount),
  }));

  const inFor = (m: string) =>
    total(inflows.filter((f) => monthKey(f.date) === m), (f) => f.amount);
  const outFor = (m: string) =>
    total(outflows.filter((f) => monthKey(f.date) === m), (f) => f.amount);

  const moneyIn = inFor(month);
  const moneyOut = outFor(month);
  const prev = shiftMonth(month, -1);
  const prevIn = inFor(prev);
  const prevOut = outFor(prev);

  // Four different answers to "what are we owed". Each has a different scope,
  // so each is named rather than blended into one figure.
  const pendingInstallments = total(
    (data.installments.data ?? []).filter((i) => i.status === "pending"),
    (i) => num(i.amount),
  );
  const pendingChequesIn = total(
    (data.cheques.data ?? []).filter((c) => c.status === "pending" && c.direction === "received"),
    (c) => num(c.amount),
  );
  const recurringOutstanding = total(
    (data.entries.data ?? []).filter(
      (e) => e.status === "pending" && monthKey(e.due_date) === month,
    ),
    (e) => num(e.amount),
  );
  const boardUnpaid = total(
    (data.board.data ?? []).filter((p) => !p.is_paid),
    (p) => num(p.price_lkr),
  );
  const stillToCollect = pendingInstallments + pendingChequesIn + recurringOutstanding;

  const monthlyRecurring = total(
    (data.arrangements.data ?? []).filter((r) => r.is_active),
    (r) => num(r.amount),
  );

  const months: string[] = [];
  for (let i = back - 1; i >= 0; i--) months.push(shiftMonth(month, -i));
  const series = months.map((m) => {
    const income = inFor(m);
    const spend = outFor(m);
    return { month: m, label: monthLabel(m), income, spend, profit: income - spend };
  });

  const byCategory = new Map<string, number>();
  for (const e of data.expenses.data ?? []) {
    if (monthKey(e.expense_date) !== month) continue;
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + num(e.amount));
  }
  const categories = [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const profit = moneyIn - moneyOut;
  const label = monthLabel(month);

  const headline: ArtifactField[] = [
    { label: "Money in", value: money(moneyIn), format: "money", tone: "positive", delta: money(moneyIn - prevIn) },
    { label: "Money out", value: money(moneyOut), format: "money", tone: "warning", delta: money(moneyOut - prevOut) },
    {
      label: "Profit",
      value: money(profit),
      format: "money",
      tone: profit >= 0 ? "positive" : "danger",
      delta: money(profit - (prevIn - prevOut)),
    },
    { label: "Still to collect", value: money(stillToCollect), format: "money", tone: "info" },
    { label: "Recurring every month", value: money(monthlyRecurring), format: "money", tone: "positive" },
    { label: "Payments board unpaid", value: money(boardUnpaid), format: "money", tone: "warning" },
  ];

  const seriesColumns: ArtifactColumn[] = [
    { key: "month", label: "Month" },
    { key: "income", label: "In", format: "money", align: "right" },
    { key: "spend", label: "Out", format: "money", align: "right" },
    { key: "profit", label: "Profit", format: "money", align: "right" },
  ];
  const categoryColumns: ArtifactColumn[] = [
    { key: "category", label: "Category" },
    { key: "amount", label: "Amount", format: "money", align: "right" },
  ];

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: `Finance — ${label}`,
      subtitle: "Cash in, cash out, and what is still owed",
      summary:
        "Deltas compare with the previous month. 'Still to collect' is pending installments + pending cheques in + this month's recurring; the Payments board is a separate ledger and is listed on its own.",
      href: "/finance",
      area: "finance",
      metrics: headline,
      actions: [{ label: "Open Money & Finance", href: "/finance" }],
    }),
    chartArtifact({
      title: `Money in — last ${series.length} months`,
      subtitle: "Paid payments, paid installments and received recurring months",
      href: "/finance",
      area: "finance",
      chart: "bar",
      format: "money",
      points: series.map((s) => ({
        label: s.label,
        value: money(s.income),
        tone: (s.income >= s.spend ? "positive" : "warning") as ArtifactTone,
      })),
    }),
    tableArtifact({
      title: "Month by month",
      subtitle: `In, out and profit — ${series[0]?.label ?? label} to ${label}`,
      href: "/finance",
      area: "finance",
      columns: seriesColumns,
      rows: rowsToTable(series, seriesColumns, (s) => ({
        id: s.month,
        tone: (s.profit >= 0 ? "positive" : "danger") as ArtifactTone,
        cells: {
          month: s.label,
          income: money(s.income),
          spend: money(s.spend),
          profit: money(s.profit),
        },
      })),
      total_label: "Net over the window",
      total_value: money(total(series, (s) => s.profit)),
      total_format: "money",
    }),
  ];

  if (categories.length) {
    artifacts.push(
      tableArtifact({
        title: `Spend by category — ${label}`,
        href: "/finance",
        area: "finance",
        columns: categoryColumns,
        rows: rowsToTable(categories, categoryColumns, (c) => ({
          id: c.category,
          cells: { category: c.category, amount: money(c.amount) },
        })),
        total_label: "Total out",
        total_value: money(moneyOut),
        total_format: "money",
        footnote: "VAT recorded on an expense is part of its amount, never added on top.",
      }),
    );
  }

  return {
    content: {
      ok: true,
      month,
      currency: "LKR",
      money_in: money(moneyIn),
      money_out: money(moneyOut),
      profit: money(profit),
      previous_month: { month: prev, money_in: money(prevIn), money_out: money(prevOut) },
      still_to_collect: {
        total: money(stillToCollect),
        pending_installments_all_months: money(pendingInstallments),
        pending_cheques_in_all_dates: money(pendingChequesIn),
        recurring_not_landed_this_month: money(recurringOutstanding),
        note: "installments + cheques + this month's recurring — three different scopes in one number.",
      },
      payments_board_unpaid: money(boardUnpaid),
      payments_board_note:
        "The Payments board is a separate ledger with no settlement date, so it is not part of money in. Use finance_query dataset 'payments_board' for the rows.",
      monthly_recurring: money(monthlyRecurring),
      series: series.map((s) => ({
        month: s.month,
        in: money(s.income),
        out: money(s.spend),
        profit: money(s.profit),
      })),
      top_expense_categories: categories.slice(0, 10).map((c) => ({
        category: c.category,
        amount: money(c.amount),
      })),
    },
    event: { kind: "read", label: `Finance — ${label}`, href: "/finance" },
    artifacts,
  };
}

// ---- finance_query -------------------------------------------------------

type Filters = {
  month: string | null;
  from: string | null;
  to: string | null;
  status: string;
  category: string;
  direction: string;
  query: string;
  limit: number;
  today: string;
};

/** The one table artifact a dataset branch produces, before it is capped. */
type Dataset = {
  title: string;
  subtitle?: string;
  summary?: string;
  href: string;
  area: AppArea;
  columns: ArtifactColumn[];
  rows: ArtifactRow[];
  total_label?: string;
  total_value?: number;
  footnote?: string;
};

function readFilters(args: Record<string, unknown>, ctx: ToolContext): Filters {
  const month = isMonth(str(args.month))
    ? str(args.month)
    : isDate(str(args.month))
      ? str(args.month).slice(0, 7)
      : null;
  return {
    month,
    from: isDate(str(args.from)) ? str(args.from) : month ? `${month}-01` : null,
    to: isDate(str(args.to)) ? str(args.to) : month ? monthEnd(month) : null,
    status: str(args.status).toLowerCase(),
    category: str(args.category).toLowerCase(),
    direction: str(args.direction).toLowerCase(),
    query: str(args.query),
    limit: clampLimit(args.limit),
    today: ctx.today,
  };
}

/** True when a plain date column falls inside the requested window. */
function inWindow(date: string | null | undefined, f: Filters): boolean {
  if (!date) return !f.from && !f.to;
  const d = date.slice(0, 10);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

function daysFrom(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function datasetPaymentsBoard(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("company_payments")
    .select("id, company_name, price_lkr, status, is_paid, project_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return error.message;

  let rows = (data ?? []).filter((p) => inWindow(p.created_at, f));
  if (f.query) rows = rows.filter((p) => contains(p.company_name, f.query));
  if (f.status === "unpaid") rows = rows.filter((p) => !p.is_paid);
  else if (f.status === "paid") rows = rows.filter((p) => p.is_paid);
  else if (f.status === "pending" || f.status === "upcoming") {
    rows = rows.filter((p) => p.status === f.status);
  }

  const names = await projectNames(supabase, rows.map((r) => r.project_id));

  const columns: ArtifactColumn[] = [
    { key: "company", label: "Company" },
    { key: "project", label: "Project", secondary: true },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "due", label: "Expected", format: "status" },
    { key: "settled", label: "Paid", format: "status" },
  ];

  return {
    title: "Payments board",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary:
      "`status` says WHEN the money is expected (pending = due now, upcoming = later). `is_paid` is the only settled flag.",
    href: "/payments",
    area: "payments",
    columns,
    rows: rowsToTable(rows, columns, (p) => ({
      id: p.id,
      href: p.project_id ? `/projects/${p.project_id}` : "/payments",
      tone: (p.is_paid ? "positive" : p.status === "pending" ? "warning" : "neutral") as ArtifactTone,
      cells: {
        company: p.company_name,
        project: p.project_id ? (names.get(p.project_id) ?? "—") : "—",
        amount: money(num(p.price_lkr)),
        due: p.status,
        settled: p.is_paid ? "paid" : "unpaid",
      },
    })),
    total_label: "Unpaid in this list",
    total_value: money(total(rows.filter((p) => !p.is_paid), (p) => num(p.price_lkr))),
  };
}

async function datasetProjectPayments(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("payments")
    .select("id, project_id, amount, status, paid_at, method, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return error.message;

  const names = await projectNames(supabase, (data ?? []).map((p) => p.project_id));
  let rows = (data ?? []).map((p) => ({
    ...p,
    when: (p.paid_at ?? p.created_at).slice(0, 10),
    project: names.get(p.project_id) ?? "—",
  }));
  rows = rows.filter((p) => inWindow(p.when, f));
  if (f.query) rows = rows.filter((p) => contains(p.project, f.query));
  if (["pending", "paid", "overdue"].includes(f.status)) {
    rows = rows.filter((p) => p.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "status", label: "Status", format: "status" },
    { key: "when", label: "Date", format: "date" },
    { key: "method", label: "Method", secondary: true },
  ];

  return {
    title: "Payments booked on projects",
    subtitle: f.month ? monthLabel(f.month) : "Newest first",
    summary:
      "The project's own cash ledger. `paid_at` falls back to when the row was created, exactly as the Finance overview does.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (p) => ({
      id: p.id,
      href: `/projects/${p.project_id}`,
      tone: (p.status === "paid" ? "positive" : p.status === "overdue" ? "danger" : "warning") as ArtifactTone,
      cells: {
        project: p.project,
        amount: money(num(p.amount)),
        status: p.status,
        when: p.when,
        method: p.method ?? "—",
      },
    })),
    total_label: "Total listed",
    total_value: money(total(rows, (p) => num(p.amount))),
  };
}

async function datasetExpenses(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("expenses")
    .select("id, expense_date, category, description, vendor, amount, tax_amount, payment_method, project_id")
    .order("expense_date", { ascending: false })
    .limit(500);
  if (f.from) q = q.gte("expense_date", f.from);
  if (f.to) q = q.lte("expense_date", f.to);
  if ((EXPENSE_CATEGORIES as string[]).includes(f.category)) {
    q = q.eq("category", f.category as ExpenseCategory);
  }
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) {
    rows = rows.filter((e) => contains(e.description, f.query) || contains(e.vendor, f.query));
  }
  const names = await projectNames(supabase, rows.map((e) => e.project_id));

  const columns: ArtifactColumn[] = [
    { key: "date", label: "Date", format: "date" },
    { key: "category", label: "Category", format: "status" },
    { key: "description", label: "Description" },
    { key: "vendor", label: "Vendor", secondary: true },
    { key: "project", label: "Project", secondary: true },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "vat", label: "of which VAT", format: "money", align: "right", secondary: true },
  ];

  return {
    title: "Company expenses",
    subtitle: f.month ? monthLabel(f.month) : f.category ? f.category : "Newest first",
    summary:
      "The Money & Finance spend ledger. A cost with a project attached is absorbed by that project and eats its margin.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (e) => ({
      id: e.id,
      href: e.project_id ? `/projects/${e.project_id}` : "/finance",
      cells: {
        date: e.expense_date,
        category: e.category,
        description: e.description,
        vendor: e.vendor ?? "—",
        project: e.project_id ? (names.get(e.project_id) ?? "—") : "—",
        amount: money(num(e.amount)),
        vat: money(num(e.tax_amount)),
      },
    })),
    total_label: "Total spent",
    total_value: money(total(rows, (e) => num(e.amount))),
    footnote: "VAT is a portion of the amount, not an addition to it.",
  };
}

async function datasetInstallments(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [instRes, planRes] = await Promise.all([
    supabase
      .from("payment_installments")
      .select("id, plan_id, seq, amount, due_date, status, paid_at")
      .order("due_date")
      .limit(500),
    supabase.from("payment_plans").select("id, title, contact_name, currency").limit(500),
  ]);
  if (instRes.error) return instRes.error.message;
  if (planRes.error) return planRes.error.message;

  const plans = new Map((planRes.data ?? []).map((p) => [p.id, p]));
  let rows = (instRes.data ?? []).map((i) => {
    const plan = plans.get(i.plan_id);
    return {
      ...i,
      plan: plan?.title ?? "—",
      contact: plan?.contact_name ?? "—",
      // There is no 'overdue' installment status — it is a pending row whose
      // due date has passed, and that is the only place it is decided.
      overdue: i.status === "pending" && i.due_date < f.today,
    };
  });
  rows = rows.filter((i) => inWindow(i.due_date, f));
  if (f.query) rows = rows.filter((i) => contains(i.plan, f.query) || contains(i.contact, f.query));
  if (f.status === "overdue") rows = rows.filter((i) => i.overdue);
  else if (f.status === "pending" || f.status === "paid") {
    rows = rows.filter((i) => i.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "plan", label: "Plan" },
    { key: "contact", label: "Contact", secondary: true },
    { key: "seq", label: "#", format: "number", align: "right", secondary: true },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "due", label: "Due", format: "date" },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: "Installments",
    subtitle: f.status === "overdue" ? "Overdue" : f.month ? monthLabel(f.month) : "By due date",
    summary: "An installment is only ever pending or paid — 'overdue' means pending with a due date in the past.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (i) => ({
      id: i.id,
      href: "/finance",
      tone: (i.status === "paid" ? "positive" : i.overdue ? "danger" : "warning") as ArtifactTone,
      cells: {
        plan: i.plan,
        contact: i.contact,
        seq: i.seq,
        amount: money(num(i.amount)),
        due: i.due_date,
        status: i.overdue ? "overdue" : i.status,
      },
    })),
    total_label: "Total listed",
    total_value: money(total(rows, (i) => num(i.amount))),
  };
}

async function datasetPlans(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [planRes, instRes] = await Promise.all([
    supabase
      .from("payment_plans")
      .select("id, title, contact_name, total, currency, status, created_at")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase.from("payment_installments").select("plan_id, amount, status").limit(1000),
  ]);
  if (planRes.error) return planRes.error.message;
  if (instRes.error) return instRes.error.message;

  const paidByPlan = new Map<string, number>();
  for (const i of instRes.data ?? []) {
    if (i.status !== "paid") continue;
    paidByPlan.set(i.plan_id, (paidByPlan.get(i.plan_id) ?? 0) + num(i.amount));
  }

  let rows = (planRes.data ?? []).map((p) => {
    const paid = paidByPlan.get(p.id) ?? 0;
    return { ...p, paid, remaining: Math.max(0, num(p.total) - paid) };
  });
  if (f.query) {
    rows = rows.filter((p) => contains(p.title, f.query) || contains(p.contact_name, f.query));
  }
  if (["active", "completed", "cancelled"].includes(f.status)) {
    rows = rows.filter((p) => p.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "title", label: "Plan" },
    { key: "contact", label: "Contact", secondary: true },
    { key: "total", label: "Total", format: "money", align: "right" },
    { key: "paid", label: "Paid", format: "money", align: "right" },
    { key: "remaining", label: "Remaining", format: "money", align: "right" },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: "Payment plans",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary: "Paid is the sum of settled installments; a plan completes itself once every installment is paid.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (p) => ({
      id: p.id,
      href: "/finance",
      tone: (p.status === "completed" ? "positive" : p.status === "cancelled" ? "neutral" : "info") as ArtifactTone,
      cells: {
        title: p.title,
        contact: p.contact_name,
        total: money(num(p.total)),
        paid: money(p.paid),
        remaining: money(p.remaining),
        status: p.status,
      },
    })),
    total_label: "Still to collect on these plans",
    total_value: money(total(rows, (p) => p.remaining)),
  };
}

async function datasetCheques(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("cheques")
    .select("id, direction, party_name, bank, cheque_number, amount, due_date, status, notes")
    .order("due_date")
    .limit(500);
  if (error) return error.message;

  const soon = daysFrom(f.today, 3);
  let rows = (data ?? []).filter((c) => inWindow(c.due_date, f));
  if (f.direction === "received" || f.direction === "issued") {
    rows = rows.filter((c) => c.direction === f.direction);
  }
  if (f.query) {
    rows = rows.filter(
      (c) => contains(c.party_name, f.query) || contains(c.cheque_number, f.query) || contains(c.bank, f.query),
    );
  }
  if (f.status === "due_soon") {
    rows = rows.filter((c) => c.status === "pending" && c.due_date <= soon);
  } else if (f.status === "overdue") {
    rows = rows.filter((c) => c.status === "pending" && c.due_date < f.today);
  } else if (["pending", "deposited", "cleared", "bounced", "cancelled"].includes(f.status)) {
    rows = rows.filter((c) => c.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "party", label: "Party" },
    { key: "direction", label: "In/Out", format: "status" },
    { key: "number", label: "Cheque no.", secondary: true },
    { key: "bank", label: "Bank", secondary: true },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "due", label: "Due", format: "date" },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: "Cheques",
    subtitle:
      f.status === "due_soon"
        ? "Due within 3 days"
        : f.direction
          ? f.direction === "received"
            ? "Coming in"
            : "Written out"
          : "By due date",
    summary: "'Due soon' matches the Finance page: still pending and due within three days.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: "/finance",
      tone: (c.status === "cleared"
        ? "positive"
        : c.status === "bounced"
          ? "danger"
          : c.status === "pending" && c.due_date < f.today
            ? "warning"
            : "neutral") as ArtifactTone,
      cells: {
        party: c.party_name,
        direction: c.direction === "received" ? "in" : "out",
        number: c.cheque_number ?? "—",
        bank: c.bank ?? "—",
        amount: money(num(c.amount)),
        due: c.due_date,
        status: c.status,
      },
    })),
    total_label: "Total listed",
    total_value: money(total(rows, (c) => num(c.amount))),
  };
}

async function datasetRecurring(supabase: DB, f: Filters): Promise<Dataset | string> {
  const month = f.month ?? f.today.slice(0, 7);
  const [incomeRes, entryRes] = await Promise.all([
    supabase
      .from("recurring_income")
      .select("id, label, amount, day_of_month, category, is_active, started_on, ended_on, project_id")
      .order("is_active", { ascending: false })
      .limit(300),
    supabase
      .from("recurring_income_entries")
      .select("income_id, period, status, amount, due_date")
      .eq("period", `${month}-01`)
      .limit(500),
  ]);
  if (incomeRes.error) return incomeRes.error.message;
  if (entryRes.error) return entryRes.error.message;

  const thisMonth = new Map((entryRes.data ?? []).map((e) => [e.income_id, e]));
  let rows = incomeRes.data ?? [];
  if (f.query) rows = rows.filter((r) => contains(r.label, f.query));
  if ((RECURRING_CATEGORIES as string[]).includes(f.category)) {
    rows = rows.filter((r) => r.category === f.category);
  }
  if (f.status === "active") rows = rows.filter((r) => r.is_active);
  else if (f.status === "inactive") rows = rows.filter((r) => !r.is_active);

  const columns: ArtifactColumn[] = [
    { key: "label", label: "Arrangement" },
    { key: "category", label: "Type", format: "status" },
    { key: "amount", label: "Per month", format: "money", align: "right" },
    { key: "day", label: "Day", format: "number", align: "right", secondary: true },
    { key: "active", label: "Active", format: "status" },
    { key: "month", label: monthLabel(month), format: "status" },
  ];

  return {
    title: "Standing income",
    subtitle: `Status shown for ${monthLabel(month)}`,
    summary:
      "What arrives every month if nothing changes. The month column is the fact; the amount is the promise.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (r) => {
      const entry = thisMonth.get(r.id);
      return {
        id: r.id,
        href: "/finance",
        tone: (!r.is_active
          ? "neutral"
          : entry?.status === "received"
            ? "positive"
            : entry?.status === "skipped"
              ? "neutral"
              : "warning") as ArtifactTone,
        cells: {
          label: r.label,
          category: r.category,
          amount: money(num(r.amount)),
          day: r.day_of_month,
          active: r.is_active ? "active" : "stopped",
          month: entry?.status ?? "not generated",
        },
      };
    }),
    total_label: "Active per month",
    total_value: money(total(rows.filter((r) => r.is_active), (r) => num(r.amount))),
  };
}

async function datasetRecurringEntries(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [entryRes, incomeRes] = await Promise.all([
    supabase
      .from("recurring_income_entries")
      .select("id, income_id, period, due_date, amount, status, received_on, note")
      .order("due_date", { ascending: false })
      .limit(500),
    supabase.from("recurring_income").select("id, label, category").limit(300),
  ]);
  if (entryRes.error) return entryRes.error.message;
  if (incomeRes.error) return incomeRes.error.message;

  const labels = new Map((incomeRes.data ?? []).map((r) => [r.id, r.label]));
  let rows = (entryRes.data ?? []).map((e) => ({
    ...e,
    label: labels.get(e.income_id) ?? "—",
    overdue: e.status === "pending" && e.due_date < f.today,
  }));
  if (f.month) rows = rows.filter((e) => monthKey(e.period) === f.month);
  else rows = rows.filter((e) => inWindow(e.due_date, f));
  if (f.query) rows = rows.filter((e) => contains(e.label, f.query));
  if (f.status === "overdue") rows = rows.filter((e) => e.overdue);
  else if (["pending", "received", "skipped"].includes(f.status)) {
    rows = rows.filter((e) => e.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "label", label: "Arrangement" },
    { key: "period", label: "Month" },
    { key: "due", label: "Due", format: "date" },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "status", label: "Status", format: "status" },
    { key: "received", label: "Received on", format: "date", secondary: true },
  ];

  return {
    title: "Recurring months",
    subtitle: f.month ? monthLabel(f.month) : "Newest first",
    summary: "One row per arrangement per month. Only 'received' months count as cash in.",
    href: "/finance",
    area: "finance",
    columns,
    rows: rowsToTable(rows, columns, (e) => ({
      id: e.id,
      href: "/finance",
      tone: (e.status === "received" ? "positive" : e.overdue ? "danger" : e.status === "skipped" ? "neutral" : "warning") as ArtifactTone,
      cells: {
        label: e.label,
        period: monthLabel(monthKey(e.period)),
        due: e.due_date,
        amount: money(num(e.amount)),
        status: e.overdue ? "overdue" : e.status,
        received: e.received_on ?? "—",
      },
    })),
    total_label: "Total listed",
    total_value: money(total(rows, (e) => num(e.amount))),
  };
}

/** What is left on an invoice — the same subtraction the printed PDF shows. */
function invoiceBalance(row: { grand_total: number; amount_paid: number | null; due_today: number }): number {
  return Math.max(0, num(row.grand_total) - num(row.amount_paid) - num(row.due_today));
}

async function datasetInvoices(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("invoices")
    .select("id, invoice_number, invoice_date, bill_to_name, grand_total, due_today, amount_paid, sent_at, project_id")
    .order("created_at", { ascending: false })
    .limit(500);
  if (f.from) q = q.gte("invoice_date", f.from);
  if (f.to) q = q.lte("invoice_date", f.to);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = (data ?? []).map((i) => ({ ...i, balance: invoiceBalance(i) }));
  if (f.query) {
    const wanted = normalizeNo(f.query);
    rows = rows.filter(
      (i) =>
        contains(i.bill_to_name, f.query) ||
        (wanted.length > 0 && normalizeNo(i.invoice_number) === wanted),
    );
  }
  if (f.status === "sent") rows = rows.filter((i) => i.sent_at);
  else if (f.status === "unsent") rows = rows.filter((i) => !i.sent_at);
  else if (f.status === "outstanding") rows = rows.filter((i) => i.balance > 0 || num(i.due_today) > 0);
  else if (f.status === "settled") rows = rows.filter((i) => i.balance === 0 && num(i.due_today) === 0);

  const columns: ArtifactColumn[] = [
    { key: "number", label: "Invoice" },
    { key: "date", label: "Date", format: "date" },
    { key: "billed", label: "Billed to" },
    { key: "total", label: "Total", format: "money", align: "right" },
    { key: "paid", label: "Paid", format: "money", align: "right", secondary: true },
    { key: "due", label: "Due today", format: "money", align: "right", secondary: true },
    { key: "balance", label: "Balance", format: "money", align: "right" },
    { key: "sent", label: "Sent", format: "status" },
  ];

  return {
    title: "Invoices",
    subtitle: f.month ? monthLabel(f.month) : f.status ? `Filtered: ${f.status}` : "Newest first",
    summary:
      "Invoices have no status column — 'sent' just means a send was recorded. Balance = total − amount paid − due today, exactly as the PDF prints it.",
    href: "/invoices?tab=past",
    area: "invoices",
    columns,
    rows: rowsToTable(rows, columns, (i) => ({
      id: i.id,
      href: i.project_id ? `/projects/${i.project_id}` : "/invoices?tab=past",
      tone: (i.balance > 0 ? "warning" : "positive") as ArtifactTone,
      cells: {
        number: i.invoice_number,
        date: i.invoice_date,
        billed: i.bill_to_name,
        total: money(num(i.grand_total)),
        paid: money(num(i.amount_paid)),
        due: money(num(i.due_today)),
        balance: money(i.balance),
        sent: i.sent_at ? "sent" : "not sent",
      },
    })),
    total_label: "Invoiced in this list",
    total_value: money(total(rows, (i) => num(i.grand_total))),
  };
}

async function datasetQuotes(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("quotes")
    .select("id, quote_number, title, customer_name, grand_total, status, valid_until, sent_at, accepted_at, invoice_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((q) => ({
    ...q,
    // Nothing in the app ever flips a quote to 'expired', so a lapsed quote
    // still reads sent/viewed. Derived here, and said out loud in the footnote.
    lapsed:
      Boolean(q.valid_until) &&
      (q.valid_until as string) < f.today &&
      ["draft", "sent", "viewed"].includes(q.status),
  }));
  rows = rows.filter((q) => inWindow(q.created_at.slice(0, 10), f));
  if (f.query) {
    rows = rows.filter(
      (q) => contains(q.customer_name, f.query) || contains(q.title, f.query) || contains(q.quote_number, f.query),
    );
  }
  if (f.status === "open") rows = rows.filter((q) => ["sent", "viewed"].includes(q.status));
  else if (f.status === "expired") rows = rows.filter((q) => q.lapsed || q.status === "expired");
  else if (["draft", "sent", "viewed", "accepted", "declined"].includes(f.status)) {
    rows = rows.filter((q) => q.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "number", label: "Quote" },
    { key: "customer", label: "Customer" },
    { key: "title", label: "Title", secondary: true },
    { key: "total", label: "Total", format: "money", align: "right" },
    { key: "status", label: "Status", format: "status" },
    { key: "valid", label: "Valid until", format: "date", secondary: true },
    { key: "converted", label: "Invoiced", format: "status", secondary: true },
  ];

  return {
    title: "Quotes",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary: "A quote past its valid-until date still stores its old status — 'expired' here is worked out from the date.",
    href: "/invoices?tab=quotes",
    area: "invoices",
    columns,
    rows: rowsToTable(rows, columns, (q) => ({
      id: q.id,
      href: "/invoices?tab=quotes",
      tone: (q.status === "accepted"
        ? "positive"
        : q.status === "declined"
          ? "danger"
          : q.lapsed
            ? "warning"
            : "info") as ArtifactTone,
      cells: {
        number: q.quote_number,
        customer: q.customer_name,
        title: q.title,
        total: money(num(q.grand_total)),
        status: q.lapsed ? `${q.status} (lapsed)` : q.status,
        valid: q.valid_until ?? "—",
        converted: q.invoice_id ? "yes" : "no",
      },
    })),
    total_label: "Quoted in this list",
    total_value: money(total(rows, (q) => num(q.grand_total))),
    footnote:
      "The total is everything quoted here, won or not — filter status='accepted' for the value actually won.",
  };
}

async function datasetNotices(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("notices")
    .select("id, notice_number, notice_date, to_name, subject, sent_at, recipient_email")
    .order("created_at", { ascending: false })
    .limit(500);
  if (f.from) q = q.gte("notice_date", f.from);
  if (f.to) q = q.lte("notice_date", f.to);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) {
    const wanted = normalizeNo(f.query);
    rows = rows.filter(
      (n) =>
        contains(n.to_name, f.query) ||
        contains(n.subject, f.query) ||
        (wanted.length > 0 && normalizeNo(n.notice_number) === wanted),
    );
  }
  if (f.status === "sent") rows = rows.filter((n) => n.sent_at);
  else if (f.status === "unsent") rows = rows.filter((n) => !n.sent_at);

  const columns: ArtifactColumn[] = [
    { key: "number", label: "Notice" },
    { key: "date", label: "Date", format: "date" },
    { key: "to", label: "To" },
    { key: "subject", label: "Subject" },
    { key: "sent", label: "Sent", format: "status" },
  ];

  return {
    title: "Notices",
    subtitle: f.month ? monthLabel(f.month) : "Newest first",
    summary: "Saved client notices. 'Sent' means an email send was recorded against the notice.",
    href: "/notices?tab=past",
    area: "notices",
    columns,
    rows: rowsToTable(rows, columns, (n) => ({
      id: n.id,
      href: "/notices?tab=past",
      tone: (n.sent_at ? "positive" : "neutral") as ArtifactTone,
      cells: {
        number: n.notice_number,
        date: n.notice_date,
        to: n.to_name,
        subject: n.subject,
        sent: n.sent_at ? "sent" : "not sent",
      },
    })),
  };
}

/** Every project's money, in the shape `settledAmount()` expects. */
async function loadProjectMoney(supabase: DB) {
  const [projRes, payRes, boardRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, client_id, total_value, deposit_paid, currency, status")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("payments").select("project_id, amount, status").limit(2000),
    supabase.from("company_payments").select("project_id, price_lkr, is_paid").limit(2000),
  ]);
  const error = projRes.error ?? payRes.error ?? boardRes.error;
  if (error) return { error: error.message, rows: [] as const };

  const payments = new Map<string, { amount: number; status: string | null }[]>();
  for (const p of payRes.data ?? []) {
    const list = payments.get(p.project_id) ?? [];
    list.push({ amount: num(p.amount), status: p.status });
    payments.set(p.project_id, list);
  }
  const board = new Map<string, { price_lkr: number; is_paid: boolean }[]>();
  for (const p of boardRes.data ?? []) {
    if (!p.project_id) continue;
    const list = board.get(p.project_id) ?? [];
    list.push({ price_lkr: num(p.price_lkr), is_paid: Boolean(p.is_paid) });
    board.set(p.project_id, list);
  }

  const rows = (projRes.data ?? []).map((p) => {
    const money = {
      total_value: num(p.total_value),
      deposit_paid: num(p.deposit_paid),
      payments: payments.get(p.id) ?? [],
      company_payments: board.get(p.id) ?? [],
    };
    return {
      id: p.id,
      name: p.name,
      client_id: p.client_id,
      status: p.status,
      totalValue: num(p.total_value),
      received: settledAmount(money),
      outstanding: balanceDue(money),
    };
  });
  return { error: null, rows };
}

async function datasetClientBalances(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [projects, clientsRes] = await Promise.all([
    loadProjectMoney(supabase),
    supabase.from("clients").select("id, name, company").limit(500),
  ]);
  if (projects.error) return projects.error;
  if (clientsRes.error) return clientsRes.error.message;

  const names = new Map((clientsRes.data ?? []).map((c) => [c.id, c.name]));
  const byClient = new Map<
    string,
    { name: string; clientId: string | null; projects: number; value: number; received: number; outstanding: number }
  >();
  for (const p of projects.rows) {
    const key = p.client_id ?? "__none__";
    const entry = byClient.get(key) ?? {
      name: p.client_id ? (names.get(p.client_id) ?? "Unknown client") : "No client attached",
      clientId: p.client_id,
      projects: 0,
      value: 0,
      received: 0,
      outstanding: 0,
    };
    entry.projects += 1;
    entry.value += p.totalValue;
    entry.received += p.received;
    entry.outstanding += p.outstanding;
    byClient.set(key, entry);
  }

  let rows = [...byClient.values()].sort(
    (a, b) => b.outstanding - a.outstanding || b.received - a.received,
  );
  if (f.query) rows = rows.filter((r) => contains(r.name, f.query));

  const columns: ArtifactColumn[] = [
    { key: "client", label: "Client" },
    { key: "projects", label: "Projects", format: "number", align: "right", secondary: true },
    { key: "value", label: "Contract value", format: "money", align: "right" },
    { key: "received", label: "Received", format: "money", align: "right" },
    { key: "outstanding", label: "Outstanding", format: "money", align: "right" },
  ];

  return {
    title: "Client balances",
    subtitle: "Lifetime, across every live project",
    summary:
      "Received uses the one true rule: the deposit is reconciled against the project's payment rows with max(), never added to them, so a deposit written up twice is counted once.",
    href: "/clients",
    area: "clients",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.clientId ?? r.name,
      href: "/clients",
      tone: (r.outstanding > 0 ? "warning" : "positive") as ArtifactTone,
      cells: {
        client: r.name,
        projects: r.projects,
        value: money(r.value),
        received: money(r.received),
        outstanding: money(r.outstanding),
      },
    })),
    total_label: "Total outstanding",
    total_value: money(total(rows, (r) => r.outstanding)),
    footnote: "Lifetime totals — not restricted to any month or date window.",
  };
}

async function datasetProjectMargins(supabase: DB, f: Filters): Promise<Dataset | string> {
  const projects = await loadProjectMoney(supabase);
  if (projects.error) return projects.error;

  let live = projects.rows;
  if (f.query) live = live.filter((p) => contains(p.name, f.query));
  if (!live.length) {
    return {
      title: "Project margins",
      href: "/projects",
      area: "projects",
      columns: [{ key: "project", label: "Project" }],
      rows: [],
    };
  }

  const ids = live.map((p) => p.id);
  const [costs, commissionRes, timeRes, rateRes] = await Promise.all([
    projectCostsByProject(supabase, ids),
    supabase.from("commissions").select("project_id, amount, percentage, basis").in("project_id", ids),
    supabase.from("time_entries").select("project_id, user_id, minutes").in("project_id", ids),
    supabase.from("profiles").select("id, hourly_cost").limit(200),
  ]);

  const rate = new Map((rateRes.data ?? []).map((p) => [p.id, num(p.hourly_cost)]));
  const labour = new Map<string, number>();
  for (const t of timeRes.data ?? []) {
    if (!t.project_id) continue;
    labour.set(
      t.project_id,
      (labour.get(t.project_id) ?? 0) + (num(t.minutes) / 60) * (rate.get(t.user_id) ?? 0),
    );
  }
  const commissions = new Map<string, { amount: number; percentage: number | null; basis: string | null }[]>();
  for (const c of commissionRes.data ?? []) {
    if (!c.project_id) continue;
    const list = commissions.get(c.project_id) ?? [];
    list.push({ amount: num(c.amount), percentage: c.percentage, basis: c.basis });
    commissions.set(c.project_id, list);
  }

  const rows = live
    .map((p) => {
      const margin = projectMargin({
        totalValue: p.totalValue,
        expenses: costs.get(p.id) ?? [],
        commissions: (commissions.get(p.id) ?? []).map((c) => ({
          amount: commissionEarned(c, p.received),
        })),
        labourCost: labour.get(p.id) ?? 0,
      });
      return { ...p, margin, meaningful: marginIsMeaningful(margin) };
    })
    .sort((a, b) => b.margin.revenue - a.margin.revenue);

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "revenue", label: "Revenue", format: "money", align: "right" },
    { key: "cost", label: "Cost", format: "money", align: "right" },
    { key: "profit", label: "Profit", format: "money", align: "right" },
    { key: "percent", label: "Margin", format: "percent", align: "right" },
    { key: "received", label: "Received", format: "money", align: "right", secondary: true },
  ];

  return {
    title: "Project margins",
    subtitle: f.query ? `Matching "${f.query}"` : "Highest revenue first",
    summary:
      "Billable extras sit on both sides, so only absorbed costs eat the margin. A percentage is shown only when there is both revenue and recorded cost.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: `/projects/${r.id}`,
      tone: (!r.meaningful
        ? "neutral"
        : r.margin.profit < 0
          ? "danger"
          : (r.margin.percent ?? 0) < 25
            ? "warning"
            : "positive") as ArtifactTone,
      cells: {
        project: r.name,
        revenue: money(r.margin.revenue),
        cost: money(r.margin.cost),
        profit: money(r.margin.profit),
        percent: r.meaningful ? r.margin.percent : null,
        received: money(r.received),
      },
    })),
    total_label: "Total profit",
    total_value: money(total(rows, (r) => r.margin.profit)),
    footnote:
      "Commission rows are restricted — a non-admin only sees their own, so their commission cost may read low. A blank margin means no costs have been recorded, not a perfect job.",
  };
}

async function financeQuery(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const dataset = str(args.dataset).toLowerCase();
  const f = readFilters(args, ctx);
  const supabase = ctx.supabase;

  let built: Dataset | string;
  switch (dataset) {
    case "payments_board": built = await datasetPaymentsBoard(supabase, f); break;
    case "project_payments": built = await datasetProjectPayments(supabase, f); break;
    case "expenses": built = await datasetExpenses(supabase, f); break;
    case "installments": built = await datasetInstallments(supabase, f); break;
    case "plans": built = await datasetPlans(supabase, f); break;
    case "cheques": built = await datasetCheques(supabase, f); break;
    case "recurring": built = await datasetRecurring(supabase, f); break;
    case "recurring_entries": built = await datasetRecurringEntries(supabase, f); break;
    case "invoices": built = await datasetInvoices(supabase, f); break;
    case "quotes": built = await datasetQuotes(supabase, f); break;
    case "notices": built = await datasetNotices(supabase, f); break;
    case "client_balances": built = await datasetClientBalances(supabase, f); break;
    case "project_margins": built = await datasetProjectMargins(supabase, f); break;
    default:
      return { content: { ok: false, error: `"${dataset}" is not a finance dataset.` } };
  }
  if (typeof built === "string") return { content: { ok: false, error: built } };

  const matched = built.rows.length;
  const shown = built.rows.slice(0, f.limit);
  if (!matched) {
    return {
      content: {
        ok: false,
        dataset,
        reason: `Nothing in ${built.title.toLowerCase()} matches that. Say so rather than estimating a figure.`,
        filters: { month: f.month, status: f.status || null, category: f.category || null, query: f.query || null },
      },
      event: { kind: "read", label: built.title, href: built.href },
      artifacts: [
        tableArtifact({
          title: built.title,
          subtitle: "No matching records",
          summary: built.summary,
          href: built.href,
          area: built.area,
          columns: built.columns,
          rows: [],
        }),
      ],
    };
  }

  return {
    content: {
      ok: true,
      dataset,
      currency: "LKR",
      matched,
      shown: shown.length,
      total_label: built.total_label ?? null,
      total_value: built.total_value ?? null,
      note: built.summary ?? null,
      // The model gets the same cells the artifact shows, capped — the full
      // list is already in the preview canvas beside the conversation.
      rows: shown.slice(0, 15).map((r) => r.cells),
    },
    event: { kind: "read", label: built.title, href: built.href },
    artifacts: [
      tableArtifact({
        title: built.title,
        subtitle: built.subtitle,
        summary: built.summary,
        href: built.href,
        area: built.area,
        columns: built.columns,
        rows: shown,
        ...(matched > shown.length ? { truncated: matched - shown.length } : {}),
        ...(built.total_label ? { total_label: built.total_label, total_value: built.total_value ?? 0, total_format: "money" as const } : {}),
        ...(built.footnote ? { footnote: built.footnote } : {}),
      }),
    ],
  };
}

// ---- get_finance_document ------------------------------------------------

/** Pick one row by document number (digits-only) or by a name contains-match. */
function pickDocument<T>(
  rows: T[],
  reference: string,
  numberOf: (row: T) => string,
  nameOf: (row: T) => string,
): T | null {
  if (!reference) return rows[0] ?? null;
  const wanted = normalizeNo(reference);
  if (wanted) {
    const exact = rows.find((r) => normalizeNo(numberOf(r)) === wanted);
    if (exact) return exact;
  }
  return rows.find((r) => contains(nameOf(r), reference)) ?? null;
}

async function getFinanceDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = str(args.kind).toLowerCase();
  const reference = str(args.reference);
  const supabase = ctx.supabase;

  if (kind === "invoice") {
    const { data, error } = await supabase
      .from("invoices")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { content: { ok: false, error: error.message } };
    const pool = reference ? (data ?? []) : (data ?? []).filter((r) => r.created_by === ctx.userId);
    const row =
      pickDocument(pool, reference, (r) => r.invoice_number, (r) => r.bill_to_name) ??
      (reference ? null : (data ?? [])[0] ?? null);
    if (!row) {
      return {
        content: {
          ok: false,
          reason: reference
            ? `No saved invoice matching "${reference}".`
            : "There are no saved invoices yet.",
        },
      };
    }

    const items = (row.items ?? []) as InvoiceItem[];
    const invoice: InvoiceCardData = {
      id: row.id,
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      bill_to_name: row.bill_to_name,
      bill_to_details: row.bill_to_details,
      items,
      grand_total: num(row.grand_total),
      due_today: num(row.due_today),
    };
    const balance = invoiceBalance(row);

    return {
      content: {
        ok: true,
        kind,
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        billed_to: row.bill_to_name,
        currency: "LKR",
        grand_total: money(num(row.grand_total)),
        amount_paid: money(num(row.amount_paid)),
        due_today: money(num(row.due_today)),
        balance_remaining: money(balance),
        sent: Boolean(row.sent_at),
        items: items.slice(0, 15).map((i) => ({
          item: i.item,
          description: i.description,
          qty: i.qty,
          rate: i.rate,
          total: num(i.total),
        })),
        note: "Balance = total − amount paid − due today, the same subtraction the printed invoice shows.",
      },
      event: { kind: "read", label: `Invoice ${row.invoice_number}`, href: "/invoices?tab=past" },
      artifacts: [
        {
          kind: "invoice",
          id: `invoice-${row.id}`,
          title: `Invoice ${row.invoice_number}`,
          subtitle: row.bill_to_name,
          href: "/invoices?tab=past",
          area: "invoices",
          invoice,
        },
        recordArtifact({
          title: `Invoice ${row.invoice_number} — the money`,
          subtitle: row.bill_to_name,
          href: "/invoices?tab=past",
          area: "invoices",
          fields: [
            { label: "Invoice date", value: row.invoice_date, format: "date" },
            { label: "Grand total", value: money(num(row.grand_total)), format: "money" },
            { label: "Amount paid", value: money(num(row.amount_paid)), format: "money" },
            { label: "Due today", value: money(num(row.due_today)), format: "money" },
            {
              label: "Balance remaining",
              value: money(balance),
              format: "money",
              tone: balance > 0 ? "warning" : "positive",
            },
            { label: "Pay into", value: row.bank_account ?? "default account" },
            { label: "Stamp", value: row.stamp ?? "none" },
            {
              label: "Sent",
              value: row.sent_at ? "yes" : "no",
              format: "status",
              tone: row.sent_at ? "positive" : "neutral",
            },
            { label: "Recipient", value: row.recipient_email ?? "—", format: "email" },
          ],
          actions: [
            {
              label: "Email this invoice",
              prompt: `Email invoice ${row.invoice_number} to the client`,
            },
          ],
        }),
      ],
    };
  }

  if (kind === "quote") {
    const { data, error } = await supabase
      .from("quotes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { content: { ok: false, error: error.message } };
    const row = pickDocument(
      data ?? [],
      reference,
      (r) => r.quote_number,
      (r) => `${r.customer_name} ${r.title}`,
    );
    if (!row) {
      return {
        content: {
          ok: false,
          reason: reference ? `No quote matching "${reference}".` : "There are no saved quotes yet.",
        },
      };
    }

    const items = (row.items ?? []) as InvoiceItem[];
    const itemColumns: ArtifactColumn[] = [
      { key: "item", label: "Item" },
      { key: "description", label: "Description", secondary: true },
      { key: "qty", label: "Qty", align: "right" },
      { key: "rate", label: "Rate", align: "right" },
      { key: "total", label: "Total", format: "money", align: "right" },
    ];
    const lapsed =
      Boolean(row.valid_until) &&
      (row.valid_until as string) < ctx.today &&
      ["draft", "sent", "viewed"].includes(row.status);

    return {
      content: {
        ok: true,
        kind,
        quote_number: row.quote_number,
        title: row.title,
        customer: row.customer_name,
        currency: row.currency,
        subtotal: money(num(row.subtotal)),
        discount: money(num(row.discount)),
        tax_rate: num(row.tax_rate),
        tax_amount: money(num(row.tax_amount)),
        grand_total: money(num(row.grand_total)),
        status: row.status,
        lapsed_by_date: lapsed,
        valid_until: row.valid_until,
        signed_by: row.signed_name,
        converted_to_invoice: Boolean(row.invoice_id),
        items: items.slice(0, 15).map((i) => ({ item: i.item, qty: i.qty, rate: i.rate, total: num(i.total) })),
        note: lapsed
          ? "Past its valid-until date, but nothing in the app flips a quote to expired, so it still stores its old status."
          : null,
      },
      event: { kind: "read", label: `Quote ${row.quote_number}`, href: "/invoices?tab=quotes" },
      artifacts: [
        recordArtifact({
          title: `Quote ${row.quote_number}`,
          subtitle: `${row.customer_name} — ${row.title}`,
          href: "/invoices?tab=quotes",
          area: "invoices",
          body: row.notes ?? undefined,
          fields: [
            { label: "Customer", value: row.customer_name },
            { label: "Email", value: row.customer_email ?? "—", format: "email" },
            { label: "Phone", value: row.customer_phone ?? "—", format: "phone" },
            {
              label: "Status",
              value: lapsed ? `${row.status} (lapsed)` : row.status,
              format: "status",
              tone: row.status === "accepted" ? "positive" : row.status === "declined" ? "danger" : "info",
            },
            { label: "Valid until", value: row.valid_until ?? "—", format: "date" },
            { label: "Subtotal", value: money(num(row.subtotal)), format: "money" },
            { label: "Discount", value: money(num(row.discount)), format: "money" },
            { label: `Tax (${num(row.tax_rate)}%)`, value: money(num(row.tax_amount)), format: "money" },
            { label: "Grand total", value: money(num(row.grand_total)), format: "money" },
            { label: "Sent", value: row.sent_at ?? "not sent", format: "datetime" },
            { label: "Signed by", value: row.signed_name ?? "—" },
            { label: "Converted to invoice", value: row.invoice_id ? "yes" : "no", format: "status" },
          ],
        }),
        tableArtifact({
          title: `Quote ${row.quote_number} — line items`,
          href: "/invoices?tab=quotes",
          area: "invoices",
          columns: itemColumns,
          rows: rowsToTable(items, itemColumns, (i, index) => ({
            id: String(index),
            cells: {
              item: i.item,
              description: i.description,
              qty: i.qty,
              rate: i.rate,
              total: money(num(i.total)),
            },
          })),
          total_label: "Grand total",
          total_value: money(num(row.grand_total)),
          total_format: "money",
        }),
      ],
    };
  }

  if (kind === "notice") {
    const { data, error } = await supabase
      .from("notices")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { content: { ok: false, error: error.message } };
    const row = pickDocument(
      data ?? [],
      reference,
      (r) => r.notice_number,
      (r) => `${r.to_name} ${r.subject}`,
    );
    if (!row) {
      return {
        content: {
          ok: false,
          reason: reference ? `No notice matching "${reference}".` : "There are no saved notices yet.",
        },
      };
    }

    return {
      content: {
        ok: true,
        kind,
        notice_number: row.notice_number,
        notice_date: row.notice_date,
        to: row.to_name,
        subject: row.subject,
        sent: Boolean(row.sent_at),
        recipient_email: row.recipient_email,
        body_preview: row.body.slice(0, 600),
      },
      event: { kind: "read", label: `Notice ${row.notice_number}`, href: "/notices?tab=past" },
      artifacts: [
        recordArtifact({
          title: `Notice ${row.notice_number}`,
          subtitle: `${row.to_name} — ${row.subject}`,
          href: "/notices?tab=past",
          area: "notices",
          body: row.body,
          fields: [
            { label: "Date", value: row.notice_date, format: "date" },
            { label: "To", value: row.to_name },
            { label: "Details", value: row.to_details || "—", format: "multiline" },
            { label: "Subject", value: row.subject },
            {
              label: "Sent",
              value: row.sent_at ?? "not sent",
              format: "datetime",
              tone: row.sent_at ? "positive" : "neutral",
            },
            { label: "Recipient", value: row.recipient_email ?? "—", format: "email" },
          ],
        }),
      ],
    };
  }

  return { content: { ok: false, error: `"${kind}" is not an invoice, quote or notice.` } };
}

// ---- member_money --------------------------------------------------------

const SELF_WORDS = new Set(["me", "myself", "i", "my", "mine", "my own"]);

async function memberMoney(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const asked = str(args.member);

  const { data: caller, error: callerError } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", ctx.userId)
    .maybeSingle();
  if (callerError) return { content: { ok: false, error: callerError.message } };

  let targetId = ctx.userId;
  let targetName = caller?.full_name ?? "you";
  if (asked && !SELF_WORDS.has(asked.toLowerCase())) {
    const safe = safeLike(asked);
    // Stripped to nothing, the pattern below would be a bare `%%` — it would
    // match every profile and silently answer about whichever one came first.
    if (!safe) {
      return { content: { ok: false, reason: `No team member matching "${asked}".` } };
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, username")
      .or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%`)
      .limit(1);
    if (error) return { content: { ok: false, error: error.message } };
    const match = data?.[0];
    if (!match) return { content: { ok: false, reason: `No team member matching "${asked}".` } };
    targetId = match.id;
    targetName = match.full_name || match.username;
  }

  // Commission and loan rows are visible only to their owner or an admin.
  // Without this check a member would get a silent, empty answer about a
  // colleague and the model would report it as fact.
  const isAdmin = caller?.role === "admin";
  if (targetId !== ctx.userId && !isAdmin) {
    return {
      content: {
        ok: false,
        reason: `Commission and loan records are private — only ${targetName} or an admin can see them. Tell the user plainly rather than guessing at a figure.`,
      },
    };
  }

  const [commissionRes, loanRes] = await Promise.all([
    supabase.from("commissions").select("id, project_id, amount, percentage, basis, status, note, created_at").eq("user_id", targetId),
    supabase
      .from("member_loans")
      .select("id, amount, currency, reason, issued_on, due_on, status, approval, approved_at, note")
      .eq("user_id", targetId)
      .order("issued_on", { ascending: false }),
  ]);
  if (commissionRes.error) return { content: { ok: false, error: commissionRes.error.message } };
  if (loanRes.error) return { content: { ok: false, error: loanRes.error.message } };

  const loanIds = (loanRes.data ?? []).map((l) => l.id);
  const repayRes = loanIds.length
    ? await supabase
        .from("member_loan_repayments")
        .select("id, loan_id, amount, paid_on, method, note")
        .in("loan_id", loanIds)
        .order("paid_on", { ascending: false })
    : { data: [], error: null };
  if (repayRes.error) return { content: { ok: false, error: repayRes.error.message } };

  const loans = attachRepayments(
    (loanRes.data ?? []) as Parameters<typeof attachRepayments>[0],
    (repayRes.data ?? []) as Parameters<typeof attachRepayments>[1],
  );
  const summary = summariseMemberMoney(commissionRes.data ?? [], loans);
  const projects = await projectNames(supabase, (commissionRes.data ?? []).map((c) => c.project_id));

  // /team/[id] calls requireAdmin(), so never send a member there.
  const href = isAdmin && targetId !== ctx.userId ? `/team/${targetId}` : "/profile";

  const metrics: ArtifactField[] = [
    { label: "Commission earned", value: money(summary.commissionEarned), format: "money", tone: "positive" },
    { label: "Already paid out", value: money(summary.commissionPaidOut), format: "money" },
    { label: "Commission owed", value: money(summary.commissionOwed), format: "money", tone: "info" },
    { label: "Loans outstanding", value: money(summary.loansOutstanding), format: "money", tone: summary.loansOutstanding > 0 ? "warning" : "neutral" },
    { label: "Loans repaid", value: money(summary.loansRepaid), format: "money" },
    {
      label: "Net payable now",
      value: money(summary.netPayable),
      format: "money",
      tone: summary.netPayable >= 0 ? "positive" : "danger",
    },
  ];
  if (summary.pendingCount > 0) {
    metrics.push({
      label: "Awaiting approval",
      value: money(summary.loansPending),
      format: "money",
      tone: "info",
    });
  }

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: `${targetName} — money`,
      subtitle: "Commission netted against outstanding advances",
      summary:
        "A loan is never subtracted from a commission row; it is subtracted at the point the numbers are shown, so a repayment restores the balance immediately. Loans awaiting approval are in no total.",
      href,
      area: "team",
      metrics,
    }),
  ];

  if (loans.length) {
    const loanColumns: ArtifactColumn[] = [
      { key: "issued", label: "Issued", format: "date" },
      { key: "amount", label: "Amount", format: "money", align: "right" },
      { key: "repaid", label: "Repaid", format: "money", align: "right" },
      { key: "balance", label: "Balance", format: "money", align: "right" },
      { key: "approval", label: "Approval", format: "status" },
      { key: "status", label: "Status", format: "status" },
      { key: "reason", label: "Reason", secondary: true },
    ];
    artifacts.push(
      tableArtifact({
        title: `${targetName} — loans`,
        href,
        area: "team",
        columns: loanColumns,
        rows: rowsToTable(loans, loanColumns, (l) => ({
          id: l.id,
          tone: (l.approval !== "approved"
            ? "info"
            : loanBalance(l) > 0
              ? "warning"
              : "positive") as ArtifactTone,
          cells: {
            issued: l.issued_on,
            amount: money(num(l.amount)),
            repaid: money(loanRepaid(l)),
            balance: money(loanBalance(l)),
            approval: l.approval,
            status: l.status,
            reason: l.reason ?? "—",
          },
        })),
        total_label: "Still owed",
        total_value: money(summary.loansOutstanding),
        total_format: "money",
      }),
    );
  }

  const repayments = repayRes.data ?? [];
  if (repayments.length) {
    artifacts.push(
      timelineArtifact({
        title: `${targetName} — repayments`,
        href,
        area: "team",
        entries: repayments.slice(0, 30).map((r) => ({
          when: r.paid_on,
          label: `Repaid ${money(num(r.amount))}`,
          detail: [r.method, r.note].filter(Boolean).join(" · ") || undefined,
          tone: "positive" as ArtifactTone,
        })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      member: targetName,
      is_self: targetId === ctx.userId,
      currency: "LKR",
      commission_earned: money(summary.commissionEarned),
      commission_paid_out: money(summary.commissionPaidOut),
      commission_owed: money(summary.commissionOwed),
      loans_issued: money(summary.loansIssued),
      loans_repaid: money(summary.loansRepaid),
      loans_outstanding: money(summary.loansOutstanding),
      loans_written_off: money(summary.loansWrittenOff),
      loans_awaiting_approval: money(summary.loansPending),
      net_payable: money(summary.netPayable),
      loans: loans.slice(0, 15).map((l) => ({
        issued_on: l.issued_on,
        amount: money(num(l.amount)),
        repaid: money(loanRepaid(l)),
        balance: money(loanBalance(l)),
        approval: l.approval,
        status: l.status,
      })),
      commissions: (commissionRes.data ?? []).slice(0, 15).map((c) => ({
        project: c.project_id ? (projects.get(c.project_id) ?? "—") : "—",
        amount: money(num(c.amount)),
        basis: c.basis,
        status: c.status,
      })),
      note: "Net payable can be negative — that means the advance has outrun what they have earned.",
    },
    event: { kind: "read", label: `${targetName} — money`, href },
    artifacts,
  };
}

// ---- record_expense ------------------------------------------------------

async function recordExpense(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const amount = Number(args.amount);
  const description = str(args.description);
  if (!description) return { content: { ok: false, error: "Say what the money went on." } };
  if (!Number.isFinite(amount) || amount <= 0)
    return { content: { ok: false, error: "Enter a valid amount." } };

  const rawCategory = str(args.category).toLowerCase();
  const category: ExpenseCategory = (EXPENSE_CATEGORIES as string[]).includes(rawCategory)
    ? (rawCategory as ExpenseCategory)
    : "other";
  const date = isDate(str(args.date)) ? str(args.date) : ctx.today;
  const taxRaw = Number(args.tax_amount);
  const tax = Number.isFinite(taxRaw) && taxRaw > 0 ? Math.min(taxRaw, amount) : 0;

  let project: { id: string; name: string } | null = null;
  if (str(args.project)) {
    project = await findProjectRow(ctx.supabase, args.project);
    if (!project)
      return { content: { ok: false, reason: `No project matching "${str(args.project)}".` } };
  }

  // Through the page's own action, so the project boards are revalidated and
  // a cost lands on that project's margin the same way a click makes it.
  const { saveExpense } = await import("@/app/(app)/finance/actions");
  const res = await saveExpense({
    expense_date: date,
    category,
    description,
    vendor: str(args.vendor) || null,
    amount,
    tax_amount: tax,
    payment_method: str(args.payment_method) || null,
    project_id: project?.id ?? null,
  });
  if (!res.ok) return { content: { ok: false, error: res.error } };

  return {
    content: {
      ok: true,
      amount: money(amount),
      currency: "LKR",
      category,
      description,
      vendor: str(args.vendor) || null,
      date,
      tax_amount: money(tax),
      project: project?.name ?? null,
      note: project
        ? "Logged and attached to the project, where it is absorbed and eats that project's margin."
        : "Logged as general overhead — no project attached.",
    },
    event: {
      kind: "created",
      label: `Expense — ${description}`,
      href: project ? `/projects/${project.id}` : "/finance",
    },
  };
}

// ---- mark_money_received -------------------------------------------------

type Candidate = { id: string; label: string; amount: number; when: string };

/** Narrow to one open item; anything else is reported, never guessed at. */
function chooseOne(
  candidates: Candidate[],
  amount: number | null,
): { pick: Candidate } | { ambiguous: Candidate[] } | null {
  let pool = candidates;
  if (amount !== null && pool.length > 1) {
    const exact = pool.filter((c) => Math.abs(c.amount - amount) < 0.01);
    if (exact.length) pool = exact;
  }
  if (!pool.length) return null;
  if (pool.length > 1) return { ambiguous: pool.slice(0, 8) };
  return { pick: pool[0] };
}

function ambiguousResult(kind: string, list: Candidate[]): ToolResult {
  return {
    content: {
      ok: false,
      reason: `That matches ${list.length} open ${kind} items. Nothing was changed — ask the user which one, or pass the exact amount.`,
      candidates: list.map((c) => ({ label: c.label, amount: money(c.amount), when: c.when })),
    },
  };
}

async function markMoneyReceived(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const kind = str(args.kind).toLowerCase();
  const reference = str(args.reference);
  if (!reference) return { content: { ok: false, error: "Say which one — a name, a number or a plan." } };
  const amountRaw = Number(args.amount);
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : null;

  if (kind === "installment") {
    const [instRes, planRes] = await Promise.all([
      supabase
        .from("payment_installments")
        .select("id, plan_id, seq, amount, due_date, status")
        .eq("status", "pending")
        .order("due_date")
        .limit(500),
      supabase.from("payment_plans").select("id, title, contact_name").limit(500),
    ]);
    if (instRes.error) return { content: { ok: false, error: instRes.error.message } };
    if (planRes.error) return { content: { ok: false, error: planRes.error.message } };

    const plans = new Map((planRes.data ?? []).map((p) => [p.id, p]));
    const candidates: Candidate[] = (instRes.data ?? [])
      .filter((i) => {
        const plan = plans.get(i.plan_id);
        return contains(plan?.title, reference) || contains(plan?.contact_name, reference);
      })
      .map((i) => ({
        id: i.id,
        label: `${plans.get(i.plan_id)?.title ?? "Plan"} — installment ${i.seq}`,
        amount: num(i.amount),
        when: i.due_date,
      }));

    const chosen = chooseOne(candidates, amount);
    if (!chosen) return { content: { ok: false, reason: `No pending installment matches "${reference}".` } };
    if ("ambiguous" in chosen) return ambiguousResult("installment", chosen.ambiguous);

    const { setInstallmentPaid } = await import("@/app/(app)/finance/actions");
    const res = await setInstallmentPaid(chosen.pick.id, true);
    if (!res.ok) return { content: { ok: false, error: res.error } };
    return {
      content: {
        ok: true,
        kind,
        settled: chosen.pick.label,
        amount: money(chosen.pick.amount),
        currency: "LKR",
        note: "Marked paid. The plan completes itself once every installment is settled, and the payment_received automations fired.",
      },
      event: { kind: "updated", label: `Paid — ${chosen.pick.label}`, href: "/finance" },
    };
  }

  if (kind === "cheque") {
    const { data, error } = await supabase
      .from("cheques")
      .select("id, party_name, cheque_number, bank, amount, due_date, status")
      .eq("status", "pending")
      .order("due_date")
      .limit(500);
    if (error) return { content: { ok: false, error: error.message } };

    const wanted = normalizeNo(reference);
    const candidates: Candidate[] = (data ?? [])
      .filter(
        (c) =>
          contains(c.party_name, reference) ||
          contains(c.bank, reference) ||
          (wanted.length > 0 && normalizeNo(c.cheque_number ?? "") === wanted),
      )
      .map((c) => ({
        id: c.id,
        label: `${c.party_name}${c.cheque_number ? ` — ${c.cheque_number}` : ""}`,
        amount: num(c.amount),
        when: c.due_date,
      }));

    const chosen = chooseOne(candidates, amount);
    if (!chosen) return { content: { ok: false, reason: `No pending cheque matches "${reference}".` } };
    if ("ambiguous" in chosen) return ambiguousResult("cheque", chosen.ambiguous);

    const asked = str(args.cheque_status).toLowerCase();
    const status: ChequeStatus = (CHEQUE_SETTLE_STATUSES as string[]).includes(asked)
      ? (asked as ChequeStatus)
      : "cleared";
    const { setChequeStatus } = await import("@/app/(app)/finance/actions");
    const res = await setChequeStatus(chosen.pick.id, status);
    if (!res.ok) return { content: { ok: false, error: res.error } };
    return {
      content: {
        ok: true,
        kind,
        cheque: chosen.pick.label,
        amount: money(chosen.pick.amount),
        currency: "LKR",
        status,
      },
      event: { kind: "updated", label: `Cheque ${status} — ${chosen.pick.label}`, href: "/finance" },
    };
  }

  if (kind === "recurring") {
    const month = resolveMonth(args.month, ctx);
    const [incomeRes, entryRes] = await Promise.all([
      supabase.from("recurring_income").select("id, label").limit(300),
      supabase
        .from("recurring_income_entries")
        .select("id, income_id, period, due_date, amount, status")
        .eq("period", `${month}-01`)
        .eq("status", "pending")
        .limit(500),
    ]);
    if (incomeRes.error) return { content: { ok: false, error: incomeRes.error.message } };
    if (entryRes.error) return { content: { ok: false, error: entryRes.error.message } };

    const labels = new Map((incomeRes.data ?? []).map((r) => [r.id, r.label]));
    const candidates: Candidate[] = (entryRes.data ?? [])
      .filter((e) => contains(labels.get(e.income_id), reference))
      .map((e) => ({
        id: e.id,
        label: `${labels.get(e.income_id) ?? "Arrangement"} — ${monthLabel(month)}`,
        amount: num(e.amount),
        when: e.due_date,
      }));

    const chosen = chooseOne(candidates, null);
    if (!chosen)
      return {
        content: {
          ok: false,
          reason: `No pending ${monthLabel(month)} month matches "${reference}". It may already be marked received, or not generated yet.`,
        },
      };
    if ("ambiguous" in chosen) return ambiguousResult("recurring", chosen.ambiguous);

    const { setIncomeEntryStatus } = await import("@/app/(app)/finance/actions");
    const res = await setIncomeEntryStatus(
      chosen.pick.id,
      "received",
      amount !== null ? { amount } : undefined,
    );
    if (!res.ok) return { content: { ok: false, error: res.error } };
    return {
      content: {
        ok: true,
        kind,
        arrangement: chosen.pick.label,
        month,
        amount: money(amount ?? chosen.pick.amount),
        currency: "LKR",
        note:
          amount !== null && Math.abs(amount - chosen.pick.amount) > 0.01
            ? "Recorded what actually arrived, which differs from the standing amount."
            : null,
      },
      event: { kind: "updated", label: `Received — ${chosen.pick.label}`, href: "/finance" },
    };
  }

  if (kind === "payments_board") {
    const { data, error } = await supabase
      .from("company_payments")
      .select("id, company_name, price_lkr, status, is_paid, created_at")
      .eq("is_paid", false)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return { content: { ok: false, error: error.message } };

    const candidates: Candidate[] = (data ?? [])
      .filter((p) => contains(p.company_name, reference))
      .map((p) => ({
        id: p.id,
        label: p.company_name,
        amount: num(p.price_lkr),
        when: p.created_at.slice(0, 10),
      }));

    const chosen = chooseOne(candidates, amount);
    if (!chosen)
      return { content: { ok: false, reason: `No unpaid Payments-board row matches "${reference}".` } };
    if ("ambiguous" in chosen) return ambiguousResult("payments-board", chosen.ambiguous);

    const { toggleCompanyPaymentPaid } = await import("@/app/(app)/payments/actions");
    const res = await toggleCompanyPaymentPaid(chosen.pick.id, true);
    if (!res.ok) return { content: { ok: false, error: res.error } };
    return {
      content: {
        ok: true,
        kind,
        company: chosen.pick.label,
        amount: money(chosen.pick.amount),
        currency: "LKR",
        note: "Marked paid on the Payments board; a project-linked row also moves that project's balance.",
      },
      event: { kind: "updated", label: `Paid — ${chosen.pick.label}`, href: "/payments" },
    };
  }

  return { content: { ok: false, error: `"${kind}" is not something this tool can settle.` } };
}

// ---- Executor ------------------------------------------------------------

/**
 * Run one of this module's tools. Returns null when `name` belongs to a
 * different module, so the registry can try the next one.
 */
export async function executeFinanceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "finance_overview":
      return financeOverview(args, ctx);
    case "finance_query":
      return financeQuery(args, ctx);
    case "get_finance_document":
      return getFinanceDocument(args, ctx);
    case "member_money":
      return memberMoney(args, ctx);
    case "record_expense":
      return recordExpense(args, ctx);
    case "mark_money_received":
      return markMoneyReceived(args, ctx);
    default:
      return null;
  }
}
