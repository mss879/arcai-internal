"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Banknote,
  CalendarClock,
  Download,
  FileSpreadsheet,
  Landmark,
  Plus,
  Receipt,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  Cheque,
  ChequeStatus,
  Expense,
  ExpenseCategory,
  Payment,
  PaymentInstallment,
  PaymentPlan,
} from "@/lib/types";

import {
  createPaymentPlan,
  deleteCheque,
  deleteExpense,
  deletePaymentPlan,
  saveCheque,
  saveExpense,
  setChequeStatus,
  setInstallmentPaid,
  type ChequeInput,
  type ExpenseInput,
} from "./actions";

type Tab = "overview" | "installments" | "cheques" | "expenses" | "tax";
type ClientLite = { id: string; name: string; company: string | null };

const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "salaries", label: "Salaries" },
  { value: "rent", label: "Rent" },
  { value: "software", label: "Software & tools" },
  { value: "ads", label: "Advertising" },
  { value: "hosting", label: "Hosting & domains" },
  { value: "equipment", label: "Equipment" },
  { value: "transport", label: "Transport" },
  { value: "utilities", label: "Utilities" },
  { value: "fees", label: "Bank & gov. fees" },
  { value: "other", label: "Other" },
];

const CHEQUE_STATUS_META: Record<ChequeStatus, { label: string; badge: string }> = {
  pending: { label: "Pending", badge: "bg-amber-50 text-amber-600 ring-amber-200" },
  deposited: { label: "Deposited", badge: "bg-primary-50 text-primary-600 ring-primary-200" },
  cleared: { label: "Cleared", badge: "bg-emerald-50 text-emerald-600 ring-emerald-200" },
  bounced: { label: "Bounced", badge: "bg-rose-50 text-rose-600 ring-rose-200" },
  cancelled: { label: "Cancelled", badge: "bg-slate-100 text-slate-600 ring-slate-200" },
};

export function FinanceView({
  plans,
  installments,
  cheques,
  expenses,
  paidPayments,
  clients,
}: {
  plans: PaymentPlan[];
  installments: PaymentInstallment[];
  cheques: Cheque[];
  expenses: Expense[];
  paidPayments: Payment[];
  clients: ClientLite[];
}) {
  useRealtimeSync("payment_plans");
  useRealtimeSync("payment_installments");
  useRealtimeSync("cheques");
  useRealtimeSync("expenses");
  const [tab, setTab] = React.useState<Tab>("overview");

  const pendingInstallments = installments.filter((i) => i.status === "pending");
  const pendingCheques = cheques.filter((c) => c.status === "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Money & Finance"
        description="Installment plans with auto-reminders, cheque tracking, expenses and a real profit snapshot — plus a one-click tax export."
      />

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<Landmark className="h-4 w-4" />}>
          Overview
        </TabButton>
        <TabButton
          active={tab === "installments"}
          onClick={() => setTab("installments")}
          icon={<CalendarClock className="h-4 w-4" />}
          count={pendingInstallments.length}
        >
          Installments
        </TabButton>
        <TabButton
          active={tab === "cheques"}
          onClick={() => setTab("cheques")}
          icon={<Banknote className="h-4 w-4" />}
          count={pendingCheques.length}
        >
          Cheques
        </TabButton>
        <TabButton
          active={tab === "expenses"}
          onClick={() => setTab("expenses")}
          icon={<Receipt className="h-4 w-4" />}
        >
          Expenses
        </TabButton>
        <TabButton active={tab === "tax"} onClick={() => setTab("tax")} icon={<FileSpreadsheet className="h-4 w-4" />}>
          Tax export
        </TabButton>
      </div>

      {tab === "overview" && (
        <OverviewTab
          installments={installments}
          cheques={cheques}
          expenses={expenses}
          paidPayments={paidPayments}
        />
      )}
      {tab === "installments" && (
        <InstallmentsTab plans={plans} installments={installments} clients={clients} />
      )}
      {tab === "cheques" && <ChequesTab cheques={cheques} clients={clients} />}
      {tab === "expenses" && <ExpensesTab expenses={expenses} />}
      {tab === "tax" && (
        <TaxTab installments={installments} plans={plans} expenses={expenses} paidPayments={paidPayments} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---- Overview ----------------------------------------------------------------

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function OverviewTab({
  installments,
  cheques,
  expenses,
  paidPayments,
}: {
  installments: PaymentInstallment[];
  cheques: Cheque[];
  expenses: Expense[];
  paidPayments: Payment[];
}) {
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);

  // Money in = paid project payments + paid installments.
  const inflows = [
    ...paidPayments.map((p) => ({
      date: (p.paid_at ?? p.created_at).slice(0, 10),
      amount: Number(p.amount),
    })),
    ...installments
      .filter((i) => i.status === "paid")
      .map((i) => ({ date: (i.paid_at ?? i.due_date).slice(0, 10), amount: Number(i.amount) })),
  ];
  const outflows = expenses.map((e) => ({ date: e.expense_date, amount: Number(e.amount) }));

  const inThisMonth = inflows.filter((f) => monthKey(f.date) === thisMonth).reduce((s, f) => s + f.amount, 0);
  const outThisMonth = outflows.filter((f) => monthKey(f.date) === thisMonth).reduce((s, f) => s + f.amount, 0);

  const pendingInstallmentsTotal = installments
    .filter((i) => i.status === "pending")
    .reduce((s, i) => s + Number(i.amount), 0);
  const pendingChequesIn = cheques
    .filter((c) => c.status === "pending" && c.direction === "received")
    .reduce((s, c) => s + Number(c.amount), 0);

  // Last 6 months in/out.
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const series = months.map((m) => ({
    month: m,
    label: new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "short" }),
    inflow: inflows.filter((f) => monthKey(f.date) === m).reduce((s, f) => s + f.amount, 0),
    outflow: outflows.filter((f) => monthKey(f.date) === m).reduce((s, f) => s + f.amount, 0),
  }));
  const maxVal = Math.max(1, ...series.flatMap((s) => [s.inflow, s.outflow]));

  // Expenses by category (this month).
  const byCategory = new Map<string, number>();
  for (const e of expenses.filter((e) => monthKey(e.expense_date) === thisMonth)) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + Number(e.amount));
  }
  const categoryRows = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Money in — this month"
          value={formatCurrency(inThisMonth)}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <StatCard
          label="Money out — this month"
          value={formatCurrency(outThisMonth)}
          icon={<TrendingDown className="h-4 w-4 text-rose-500" />}
        />
        <StatCard
          label="Profit — this month"
          value={formatCurrency(inThisMonth - outThisMonth)}
          tone={inThisMonth - outThisMonth >= 0 ? "text-emerald-600" : "text-rose-600"}
        />
        <StatCard
          label="Still to collect"
          value={formatCurrency(pendingInstallmentsTotal + pendingChequesIn)}
          hint="pending installments + cheques"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-slate-900">Money in vs out — last 6 months</h3>
          <div className="mt-4 flex items-end gap-3 sm:gap-5">
            {series.map((s) => (
              <div key={s.month} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex h-40 w-full items-end justify-center gap-1.5">
                  <div
                    className="w-1/3 max-w-7 rounded-t-md bg-emerald-400"
                    style={{ height: `${(s.inflow / maxVal) * 100}%` }}
                    title={`In ${formatCurrency(s.inflow)}`}
                  />
                  <div
                    className="w-1/3 max-w-7 rounded-t-md bg-rose-300"
                    style={{ height: `${(s.outflow / maxVal) * 100}%` }}
                    title={`Out ${formatCurrency(s.outflow)}`}
                  />
                </div>
                <span className="text-xs font-medium text-slate-400">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Money in
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-rose-300" /> Money out
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-slate-900">Expenses this month</h3>
          {categoryRows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No expenses logged this month.</p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {categoryRows.map(([cat, amount]) => (
                <div key={cat}>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium capitalize text-slate-600">{cat}</span>
                    <span className="text-slate-500">{formatCurrency(amount)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                    <div
                      className="h-1.5 rounded-full bg-primary-400"
                      style={{ width: `${(amount / (outThisMonth || 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
        {icon}
        {label}
      </p>
      <p className={cn("mt-1 text-xl font-bold text-slate-900", tone)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

// ---- Installments --------------------------------------------------------------

function InstallmentsTab({
  plans,
  installments,
  clients,
}: {
  plans: PaymentPlan[];
  installments: PaymentInstallment[];
  clients: ClientLite[];
}) {
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<PaymentPlan | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deletePaymentPlan(toDelete.id);
    if (res.ok) toast.success("Plan deleted.");
    else toast.error(res.error);
  }

  async function togglePaid(inst: PaymentInstallment) {
    const res = await setInstallmentPaid(inst.id, inst.status !== "paid");
    if (!res.ok) toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New payment plan
        </Button>
      </div>

      {plans.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="No payment plans yet"
          description="Split a big-ticket project into installments. Each one gets an automatic SMS reminder before it's due and a chase if it goes overdue."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Create a plan
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => {
            const rows = installments.filter((i) => i.plan_id === plan.id);
            const paid = rows.filter((i) => i.status === "paid");
            const paidTotal = paid.reduce((s, i) => s + Number(i.amount), 0);
            return (
              <div
                key={plan.id}
                className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{plan.title}</h3>
                  <Badge
                    className={
                      plan.status === "completed"
                        ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                        : plan.status === "cancelled"
                          ? "bg-slate-100 text-slate-600 ring-slate-200"
                          : "bg-primary-50 text-primary-600 ring-primary-200"
                    }
                  >
                    {plan.status}
                  </Badge>
                  <span className="text-xs text-slate-400">
                    {plan.contact_name}
                    {plan.phone ? ` · ${plan.phone}` : ""}
                    {plan.remind_days_before != null
                      ? ` · SMS ${plan.remind_days_before}d before due`
                      : " · reminders off"}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-700">
                      {formatCurrency(paidTotal)} / {formatCurrency(Number(plan.total))}
                    </span>
                    <button
                      onClick={() => setToDelete(plan)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                      aria-label="Delete plan"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </div>

                <div className="mt-2 h-1.5 rounded-full bg-slate-100">
                  <div
                    className="h-1.5 rounded-full bg-emerald-400 transition-all"
                    style={{
                      width: `${Math.min(100, (paidTotal / (Number(plan.total) || 1)) * 100)}%`,
                    }}
                  />
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((inst) => {
                    const overdue = inst.status === "pending" && inst.due_date < today;
                    return (
                      <button
                        key={inst.id}
                        onClick={() => togglePaid(inst)}
                        className={cn(
                          "flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors",
                          inst.status === "paid"
                            ? "border-emerald-200 bg-emerald-50/60"
                            : overdue
                              ? "border-rose-200 bg-rose-50/60 hover:border-rose-300"
                              : "border-slate-200 bg-white hover:border-slate-300",
                        )}
                        title={inst.status === "paid" ? "Mark as pending" : "Mark as paid"}
                      >
                        <span>
                          <span className="block text-xs font-medium text-slate-500">
                            #{inst.seq} · due {inst.due_date}
                            {overdue && <span className="ml-1 font-semibold text-rose-500">overdue</span>}
                          </span>
                          <span className="text-sm font-semibold text-slate-800">
                            {formatCurrency(Number(inst.amount))}
                          </span>
                        </span>
                        <Badge
                          className={
                            inst.status === "paid"
                              ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                              : "bg-amber-50 text-amber-600 ring-amber-200"
                          }
                        >
                          {inst.status}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <NewPlanModal open={creating} onClose={() => setCreating(false)} clients={clients} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete this payment plan?"
        description="All its installments and reminder schedules are removed."
      />
    </div>
  );
}

function NewPlanModal({
  open,
  onClose,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  clients: ClientLite[];
}) {
  const [title, setTitle] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [total, setTotal] = React.useState("");
  const [count, setCount] = React.useState("3");
  const [firstDue, setFirstDue] = React.useState("");
  const [intervalDays, setIntervalDays] = React.useState("30");
  const [remind, setRemind] = React.useState("2");
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  function pickClient(id: string) {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    if (c) setContactName(c.name);
  }

  const totalNum = Number(total) || 0;
  const n = Math.max(1, Math.min(24, Number(count) || 1));
  const per = totalNum > 0 ? Math.round((totalNum / n) * 100) / 100 : 0;

  async function handleCreate() {
    if (!firstDue) {
      toast.error("Pick the first due date.");
      return;
    }
    setSubmitting(true);
    const insts = Array.from({ length: n }).map((_, i) => {
      const due = new Date(`${firstDue}T00:00:00`);
      due.setDate(due.getDate() + i * (Number(intervalDays) || 30));
      // Last installment absorbs rounding.
      const amount = i === n - 1 ? Math.round((totalNum - per * (n - 1)) * 100) / 100 : per;
      return { amount, due_date: due.toISOString().slice(0, 10) };
    });
    const res = await createPaymentPlan({
      title,
      client_id: clientId || null,
      contact_name: contactName,
      phone: phone || null,
      total: totalNum,
      remind_days_before: remind === "" ? null : Math.max(0, Number(remind)),
      notes: notes || null,
      installments: insts,
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Payment plan created — reminders are scheduled.");
      onClose();
      setTitle("");
      setTotal("");
      setFirstDue("");
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New payment plan"
      description="Splits the total into equal installments. SMS reminders go out automatically before each due date."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={submitting}
            disabled={!title.trim() || !contactName.trim() || totalNum <= 0 || !firstDue}
          >
            Create plan
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Plan title" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. E-commerce site — Silva Motors"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client" hint="Optional — fills the name.">
            <Select value={clientId} onChange={(e) => pickClient(e.target.value)}>
              <option value="">Manual contact</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contact name" required>
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone" hint="For SMS reminders, e.g. 0712345678">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
          </Field>
          <Field label="Total amount (Rs.)" required>
            <Input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Installments">
            <Input
              type="number"
              min={1}
              max={24}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </Field>
          <Field label="First due date" required>
            <Input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Field label="Every (days)">
            <Input
              type="number"
              min={1}
              value={intervalDays}
              onChange={(e) => setIntervalDays(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Remind (days before due)"
          hint="Blank turns SMS reminders off. Overdue chases still send once."
        >
          <Input
            type="number"
            min={0}
            value={remind}
            onChange={(e) => setRemind(e.target.value)}
            className="max-w-32"
          />
        </Field>
        {totalNum > 0 && (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {n} × {formatCurrency(per)} — last installment adjusts for rounding.
          </p>
        )}
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

// ---- Cheques -------------------------------------------------------------------

function ChequesTab({ cheques, clients }: { cheques: Cheque[]; clients: ClientLite[] }) {
  const [editing, setEditing] = React.useState<Cheque | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Cheque | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  // Snapshot once per mount so the due-soon check stays pure during render.
  const [soonCutoff] = React.useState(() =>
    new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
  );

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteCheque(toDelete.id);
    if (res.ok) toast.success("Cheque removed.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Log cheque
        </Button>
      </div>

      {cheques.length === 0 ? (
        <EmptyState
          icon={<Banknote className="h-6 w-6" />}
          title="No cheques logged"
          description="Track post-dated cheques you've received or issued. Everyone gets an alert on the due date so nothing bounces unnoticed."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Log your first cheque
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {cheques.map((cheque) => {
            const meta = CHEQUE_STATUS_META[cheque.status];
            const dueSoon =
              cheque.status === "pending" && cheque.due_date <= soonCutoff;
            return (
              <div
                key={cheque.id}
                className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]"
              >
                <Badge className={meta.badge}>{meta.label}</Badge>
                <Badge
                  className={
                    cheque.direction === "received"
                      ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                      : "bg-slate-100 text-slate-600 ring-slate-200"
                  }
                >
                  {cheque.direction === "received" ? "In" : "Out"}
                </Badge>
                <button onClick={() => setEditing(cheque)} className="text-left">
                  <span className="text-sm font-semibold text-slate-900 hover:text-primary-600">
                    {cheque.party_name}
                  </span>
                </button>
                <span className="text-sm font-semibold text-slate-700">
                  {formatCurrency(Number(cheque.amount))}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    dueSoon ? "font-semibold text-amber-600" : "text-slate-400",
                    cheque.status === "pending" && cheque.due_date < today && "font-semibold text-rose-500",
                  )}
                >
                  due {cheque.due_date}
                </span>
                {cheque.bank && <span className="text-xs text-slate-400">· {cheque.bank}</span>}
                {cheque.cheque_number && (
                  <span className="text-xs text-slate-400">· #{cheque.cheque_number}</span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Select
                    value={cheque.status}
                    onChange={async (e) => {
                      const res = await setChequeStatus(cheque.id, e.target.value as ChequeStatus);
                      if (!res.ok) toast.error(res.error);
                    }}
                    className="h-8 w-32 py-1 text-xs"
                  >
                    {Object.entries(CHEQUE_STATUS_META).map(([value, m]) => (
                      <option key={value} value={value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                  <button
                    onClick={() => setToDelete(cheque)}
                    className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                    aria-label="Delete cheque"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <ChequeModal
        open={creating || editing !== null}
        cheque={editing}
        clients={clients}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Remove this cheque?"
        description="It disappears from tracking and alerts."
      />
    </div>
  );
}

function ChequeModal({
  open,
  cheque,
  clients,
  onClose,
}: {
  open: boolean;
  cheque: Cheque | null;
  clients: ClientLite[];
  onClose: () => void;
}) {
  const [direction, setDirection] = React.useState<"received" | "issued">("received");
  const [partyName, setPartyName] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [bank, setBank] = React.useState("");
  const [chequeNumber, setChequeNumber] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setDirection(cheque?.direction ?? "received");
    setPartyName(cheque?.party_name ?? "");
    setClientId(cheque?.client_id ?? "");
    setBank(cheque?.bank ?? "");
    setChequeNumber(cheque?.cheque_number ?? "");
    setAmount(cheque ? String(cheque.amount) : "");
    setDueDate(cheque?.due_date ?? "");
    setNotes(cheque?.notes ?? "");
  }, [open, cheque]);

  async function handleSave() {
    setSubmitting(true);
    const input: ChequeInput = {
      id: cheque?.id,
      direction,
      party_name: partyName,
      client_id: clientId || null,
      bank: bank || null,
      cheque_number: chequeNumber || null,
      amount: Number(amount) || 0,
      due_date: dueDate,
      notes: notes || null,
    };
    const res = await saveCheque(input);
    setSubmitting(false);
    if (res.ok) {
      toast.success(cheque ? "Cheque updated." : "Cheque logged — due-date alert set.");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cheque ? "Edit cheque" : "Log a cheque"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={submitting}
            disabled={!partyName.trim() || !dueDate || !(Number(amount) > 0)}
          >
            {cheque ? "Save changes" : "Log cheque"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Direction">
          <Select
            value={direction}
            onChange={(e) => setDirection(e.target.value as "received")}
          >
            <option value="received">Received (money coming in)</option>
            <option value="issued">Issued (we wrote it)</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={direction === "received" ? "From" : "To"} required>
            <Input value={partyName} onChange={(e) => setPartyName(e.target.value)} />
          </Field>
          <Field label="Link client">
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">None</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount (Rs.)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Cheque date" required>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Bank">
            <Input value={bank} onChange={(e) => setBank(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cheque number">
            <Input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
          </Field>
          <Field label="Notes">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ---- Expenses -------------------------------------------------------------------

function ExpensesTab({ expenses }: { expenses: Expense[] }) {
  const [editing, setEditing] = React.useState<Expense | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Expense | null>(null);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteExpense(toDelete.id);
    if (res.ok) toast.success("Expense removed.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Add expense
        </Button>
      </div>

      {expenses.length === 0 ? (
        <EmptyState
          icon={<Receipt className="h-6 w-6" />}
          title="No expenses yet"
          description="Log everything going out — salaries, ads, hosting — and the Overview tab shows your real profit, not just sales."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Add your first expense
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {expenses.map((exp) => (
            <div
              key={exp.id}
              className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]"
            >
              <Badge className="bg-slate-100 capitalize text-slate-600 ring-slate-200">
                {exp.category}
              </Badge>
              <button onClick={() => setEditing(exp)} className="text-left">
                <span className="text-sm font-medium text-slate-800 hover:text-primary-600">
                  {exp.description}
                </span>
              </button>
              {exp.vendor && <span className="text-xs text-slate-400">· {exp.vendor}</span>}
              <span className="text-xs text-slate-400">· {exp.expense_date}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">
                  {formatCurrency(Number(exp.amount))}
                </span>
                <button
                  onClick={() => setToDelete(exp)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete expense"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <ExpenseModal
        open={creating || editing !== null}
        expense={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete this expense?"
        description="It's removed from the profit snapshot and tax export."
      />
    </div>
  );
}

function ExpenseModal({
  open,
  expense,
  onClose,
}: {
  open: boolean;
  expense: Expense | null;
  onClose: () => void;
}) {
  const [expenseDate, setExpenseDate] = React.useState("");
  const [category, setCategory] = React.useState<ExpenseCategory>("other");
  const [description, setDescription] = React.useState("");
  const [vendor, setVendor] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [taxAmount, setTaxAmount] = React.useState("0");
  const [method, setMethod] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setExpenseDate(expense?.expense_date ?? new Date().toISOString().slice(0, 10));
    setCategory(expense?.category ?? "other");
    setDescription(expense?.description ?? "");
    setVendor(expense?.vendor ?? "");
    setAmount(expense ? String(expense.amount) : "");
    setTaxAmount(expense ? String(expense.tax_amount) : "0");
    setMethod(expense?.payment_method ?? "");
  }, [open, expense]);

  async function handleSave() {
    setSubmitting(true);
    const input: ExpenseInput = {
      id: expense?.id,
      expense_date: expenseDate,
      category,
      description,
      vendor: vendor || null,
      amount: Number(amount) || 0,
      tax_amount: Number(taxAmount) || 0,
      payment_method: method || null,
    };
    const res = await saveExpense(input);
    setSubmitting(false);
    if (res.ok) {
      toast.success(expense ? "Expense updated." : "Expense added.");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={expense ? "Edit expense" : "Add expense"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={submitting}
            disabled={!description.trim() || !(Number(amount) > 0)}
          >
            {expense ? "Save changes" : "Add expense"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Description" required>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Meta ads — July"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount (Rs.)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="of which VAT/tax">
            <Input value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Date">
            <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor">
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </Field>
          <Field label="Paid via">
            <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Card / cash / bank" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ---- Tax export ------------------------------------------------------------------

function TaxTab({
  installments,
  plans,
  expenses,
  paidPayments,
}: {
  installments: PaymentInstallment[];
  plans: PaymentPlan[];
  expenses: Expense[];
  paidPayments: Payment[];
}) {
  const year = new Date().getFullYear();
  const [from, setFrom] = React.useState(`${year}-01-01`);
  const [to, setTo] = React.useState(new Date().toISOString().slice(0, 10));

  const planTitle = new Map(plans.map((p) => [p.id, p.title]));

  const rows = React.useMemo(() => {
    const inRange = (d: string) => d >= from && d <= to;
    const out: {
      date: string;
      type: "income" | "expense";
      description: string;
      category: string;
      amount: number;
      tax: number;
    }[] = [];

    for (const p of paidPayments) {
      const date = (p.paid_at ?? p.created_at).slice(0, 10);
      if (!inRange(date)) continue;
      out.push({
        date,
        type: "income",
        description: p.notes || "Project payment",
        category: "project",
        amount: Number(p.amount),
        tax: 0,
      });
    }
    for (const i of installments) {
      if (i.status !== "paid") continue;
      const date = (i.paid_at ?? i.due_date).slice(0, 10);
      if (!inRange(date)) continue;
      out.push({
        date,
        type: "income",
        description: `Installment #${i.seq} — ${planTitle.get(i.plan_id) ?? "plan"}`,
        category: "installment",
        amount: Number(i.amount),
        tax: 0,
      });
    }
    for (const e of expenses) {
      if (!inRange(e.expense_date)) continue;
      out.push({
        date: e.expense_date,
        type: "expense",
        description: e.description,
        category: e.category,
        amount: Number(e.amount),
        tax: Number(e.tax_amount),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, paidPayments, installments, expenses]);

  const income = rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0);
  const spend = rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0);
  const vatPaid = rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.tax, 0);

  function downloadCsv() {
    const header = "Date,Type,Description,Category,Amount (LKR),VAT/Tax (LKR)";
    const lines = rows.map((r) =>
      [
        r.date,
        r.type,
        `"${r.description.replace(/"/g, '""')}"`,
        r.category,
        r.amount.toFixed(2),
        r.tax.toFixed(2),
      ].join(","),
    );
    const summary = [
      "",
      `"Total income",,,,${income.toFixed(2)},`,
      `"Total expenses",,,,${spend.toFixed(2)},${vatPaid.toFixed(2)}`,
      `"Net profit",,,,${(income - spend).toFixed(2)},`,
    ];
    const blob = new Blob([[header, ...lines, ...summary].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arcai-tax-export-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Export downloaded — hand it straight to your accountant.");
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <h3 className="text-sm font-semibold text-slate-900">Accountant-ready export</h3>
        <p className="mt-1 text-sm text-slate-500">
          Every income and expense line in the period, with VAT amounts, as a CSV your accountant
          can open in Excel.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button onClick={downloadCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4" />
            Download CSV ({rows.length} rows)
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Income in period" value={formatCurrency(income)} />
        <StatCard label="Expenses in period" value={formatCurrency(spend)} />
        <StatCard label="VAT paid on expenses" value={formatCurrency(vatPaid)} />
      </div>

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2.5 font-semibold">Date</th>
                <th className="px-4 py-2.5 font-semibold">Description</th>
                <th className="px-4 py-2.5 font-semibold">Category</th>
                <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td className="px-4 py-2.5 text-slate-500">{r.date}</td>
                  <td className="px-4 py-2.5 text-slate-700">{r.description}</td>
                  <td className="px-4 py-2.5 capitalize text-slate-500">{r.category}</td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right font-medium",
                      r.type === "income" ? "text-emerald-600" : "text-rose-500",
                    )}
                  >
                    {r.type === "income" ? "+" : "−"}
                    {formatCurrency(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && (
            <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-400">
              Showing 50 of {rows.length} rows — the CSV contains everything.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
