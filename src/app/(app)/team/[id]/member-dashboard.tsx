"use client";

/**
 * A member's own page (0088).
 *
 * Clicking a profile card on the Team board lands here: everything about one
 * person's money in one place — what they've earned, what's been paid out,
 * what they've borrowed against it, and what we'd hand over today. Loans are
 * issued and repaid from this page; both immediately move the balance,
 * because the balance is derived from them (see @/lib/loans).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format, isBefore, startOfToday } from "date-fns";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeft,
  BadgePercent,
  Banknote,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  HandCoins,
  Mail,
  MonitorSmartphone,
  MoreVertical,
  Pencil,
  Phone,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  Undo2,
  Wallet,
  XCircle,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { COMMISSION_STATUS_META } from "@/lib/constants";
import {
  loanBadge,
  loanBalance,
  loanRepaid,
  summariseMemberMoney,
  type LoanWithRepayments,
} from "@/lib/loans";
import { formatPhone } from "@/lib/sms-utils";
import { cn, formatCurrency } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { Commission, MemberLoanApproval, Profile } from "@/lib/types";

import { setMemberHourlyCost } from "@/app/(app)/projects/plan-actions";

import { ActivityModal } from "../activity-modal";
import type { MemberDevice } from "../team-view";
import {
  deleteLoanRepayment,
  deleteMemberLoan,
  saveLoanRepayment,
  saveMemberLoan,
  setMemberLoanApproval,
  setMemberLoanWrittenOff,
} from "./actions";

type CommissionRow = Commission & {
  project?: { id: string; name: string } | null;
};

export function MemberDashboard({
  member,
  commissions,
  loans,
  devices,
  deviceStatus,
  isOnline,
  isYou,
}: {
  member: Profile;
  commissions: CommissionRow[];
  loans: LoanWithRepayments[];
  devices: MemberDevice[];
  /** Where they stand against the two-device lock (0079); null for admins. */
  deviceStatus: string | null;
  isOnline: boolean;
  isYou: boolean;
}) {
  useRealtimeSyncTables([
    "commissions",
    "member_loans",
    "member_loan_repayments",
  ]);

  const router = useRouter();
  const [loanForm, setLoanForm] = React.useState<
    { mode: "new" } | { mode: "edit"; loan: LoanWithRepayments } | null
  >(null);
  const [repayFor, setRepayFor] = React.useState<LoanWithRepayments | null>(
    null,
  );
  const [loanToDelete, setLoanToDelete] =
    React.useState<LoanWithRepayments | null>(null);
  const [showActivity, setShowActivity] = React.useState(false);

  const money = React.useMemo(
    () => summariseMemberMoney(commissions, loans),
    [commissions, loans],
  );

  const openLoans = loans.filter(
    (l) => l.approval === "approved" && l.status === "outstanding",
  );
  const pendingLoans = loans.filter((l) => l.approval === "pending");

  return (
    <div className="space-y-6">
      <Link
        href="/team"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Team
      </Link>

      {/* Identity ------------------------------------------------ */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="relative">
              <Avatar name={member.full_name} src={member.avatar_url} size="xl" />
              {isOnline && (
                <span
                  className="absolute bottom-0.5 right-0.5 block h-4 w-4 rounded-full bg-emerald-500 ring-[3px] ring-white"
                  title="Online now"
                />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-slate-900">
                  {member.full_name || member.username}
                </h1>
                {isYou && (
                  <span className="text-xs text-slate-400">(you)</span>
                )}
                <Badge
                  className={
                    member.role === "admin"
                      ? "bg-primary-50 text-primary-700 ring-primary-200"
                      : "bg-slate-100 text-slate-600 ring-slate-200"
                  }
                >
                  {member.role === "admin" ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <Shield className="h-3 w-3" />
                  )}
                  {member.role}
                </Badge>
              </div>
              {member.title && (
                <p className="mt-0.5 text-sm text-slate-500">{member.title}</p>
              )}
              <p className="mt-0.5 text-xs text-slate-400">@{member.username}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {member.role === "member" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowActivity(true)}
              >
                <Activity className="h-4 w-4" /> Activity
              </Button>
            )}
            <Button size="sm" onClick={() => setLoanForm({ mode: "new" })}>
              <HandCoins className="h-4 w-4" /> Give a loan
            </Button>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <Chip icon={<Mail className="h-4 w-4 text-slate-400" />}>
            {member.email}
          </Chip>
          <Chip icon={<Phone className="h-4 w-4 text-slate-400" />}>
            {member.phone ? formatPhone(member.phone) : "No phone on file"}
          </Chip>
          <Chip icon={<Calendar className="h-4 w-4 text-slate-400" />}>
            Joined {format(new Date(member.created_at), "MMM d, yyyy")}
          </Chip>
          {member.role === "member" && (
            <Chip icon={<Shield className="h-4 w-4 text-slate-400" />}>
              {devices.length}/2 trusted devices
            </Chip>
          )}
        </div>
      </div>

      {/* Money --------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MoneyCard
          icon={<Wallet className="h-4 w-4" />}
          label="Commission earned"
          value={formatCurrency(money.commissionEarned)}
          hint={`${commissions.length} allocation${commissions.length === 1 ? "" : "s"}`}
        />
        <MoneyCard
          icon={<BadgePercent className="h-4 w-4" />}
          label="Already paid out"
          value={formatCurrency(money.commissionPaidOut)}
          hint={`${formatCurrency(money.commissionOwed)} still owed`}
        />
        <MoneyCard
          icon={<HandCoins className="h-4 w-4" />}
          label="Loan outstanding"
          value={
            money.loansOutstanding > 0
              ? `− ${formatCurrency(money.loansOutstanding)}`
              : formatCurrency(0)
          }
          hint={
            money.pendingCount > 0
              ? `${formatCurrency(money.loansPending)} requested, not yet approved`
              : money.loansIssued > 0
                ? `${formatCurrency(money.loansRepaid)} of ${formatCurrency(money.loansIssued)} repaid`
                : "No advances taken"
          }
          accent={money.loansOutstanding > 0 ? "amber" : undefined}
        />
        <MoneyCard
          icon={<Banknote className="h-4 w-4" />}
          label={money.netPayable < 0 ? "Owes the company" : "Net payable now"}
          value={formatCurrency(Math.abs(money.netPayable))}
          hint="Commission still owed, less the outstanding loan"
          accent={money.netPayable < 0 ? "rose" : "primary"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Loans ------------------------------------------------- */}
        <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
                <HandCoins className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Loans &amp; advances
                </h2>
                <p className="text-xs text-slate-400">
                  {openLoans.length > 0
                    ? `${formatCurrency(money.loansOutstanding)} still to come back`
                    : "Nothing outstanding"}
                  {pendingLoans.length > 0 &&
                    ` · ${pendingLoans.length} awaiting your approval`}
                </p>
              </div>
            </div>
            <Button size="sm" onClick={() => setLoanForm({ mode: "new" })}>
              <Plus className="h-4 w-4" /> Loan
            </Button>
          </div>

          {loans.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm text-slate-500">No loans on record.</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-slate-400">
                When you advance money to {member.full_name || member.username},
                record it here — it comes straight off their commission balance
                until they pay it back.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {loans.map((loan) => (
                <LoanRow
                  key={loan.id}
                  loan={loan}
                  memberName={member.full_name || member.username}
                  onEdit={() => setLoanForm({ mode: "edit", loan })}
                  onRepay={() => setRepayFor(loan)}
                  onDelete={() => setLoanToDelete(loan)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Commissions ------------------------------------------- */}
        <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
              <Wallet className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Commissions
              </h2>
              <p className="text-xs text-slate-400">
                Allocated from projects — untouched by loans.
              </p>
            </div>
          </div>
          {commissions.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-slate-400">
              No commissions allocated yet.
            </p>
          ) : (
            <ul className="max-h-[520px] divide-y divide-slate-50 overflow-y-auto">
              {commissions.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {c.project?.name ?? "General"}
                    </p>
                    <p className="text-xs text-slate-400">
                      {format(new Date(c.created_at), "MMM d, yyyy")}
                      {c.percentage != null ? ` · ${c.percentage}%` : ""}
                      {c.note ? ` · ${c.note}` : ""}
                    </p>
                  </div>
                  <Badge className={COMMISSION_STATUS_META[c.status].badge}>
                    {COMMISSION_STATUS_META[c.status].label}
                  </Badge>
                  <span className="w-24 shrink-0 text-right text-sm font-semibold text-slate-900">
                    {formatCurrency(Number(c.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Cost rate (PLAN-5) --------------------------------------- */}
      <CostRateCard member={member} />

      {/* Device lock (members only — admins are exempt) ----------- */}
      {member.role === "member" && (
        <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
              <MonitorSmartphone className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Trusted devices
              </h2>
              <p className="text-xs text-slate-400">
                {devices.length}/2 registered
              </p>
            </div>
          </div>
          <div className="px-5 py-4">
            {deviceStatus && (
              <p className="text-xs text-slate-500">{deviceStatus}</p>
            )}
            {!member.phone && devices.length < 2 && (
              <p className="mt-1 text-xs font-medium text-amber-600">
                No phone on file — SMS device codes can&apos;t be delivered.
              </p>
            )}
            {devices.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                  >
                    <span className="text-sm font-medium text-slate-800">
                      {d.label}
                    </span>
                    <span className="text-xs text-slate-400">
                      Registered {format(new Date(d.created_at), "MMM d, yyyy")}
                      {d.last_used_at &&
                        ` · used ${format(new Date(d.last_used_at), "MMM d")}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <LoanModal
        open={!!loanForm}
        userId={member.id}
        loan={loanForm?.mode === "edit" ? loanForm.loan : null}
        onClose={() => setLoanForm(null)}
      />

      <RepaymentModal
        loan={repayFor}
        userId={member.id}
        onClose={() => setRepayFor(null)}
      />

      <ActivityModal
        member={showActivity ? member : null}
        devices={devices}
        onClose={() => setShowActivity(false)}
      />

      <ConfirmDialog
        open={!!loanToDelete}
        onClose={() => setLoanToDelete(null)}
        title="Delete loan"
        description={
          loanToDelete
            ? `Delete the ${formatCurrency(Number(loanToDelete.amount))} loan and its ${loanToDelete.repayments.length} repayment record(s)? Their commission balance goes back up by ${formatCurrency(loanBalance(loanToDelete))}.`
            : undefined
        }
        onConfirm={async () => {
          if (!loanToDelete) return;
          const res = await deleteMemberLoan(loanToDelete.id, member.id);
          if (res.ok) {
            toast.success("Loan deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

/**
 * What an hour of this person's time costs the agency (PLAN-5, 0092).
 *
 * Only ever entered here, on the admin-only member page, and only ever read
 * back inside a project's margin — never shown to the member it belongs to.
 * Without it, logged time still shows as hours; it just prices at zero.
 */
function CostRateCard({ member }: { member: Profile }) {
  const router = useRouter();
  const [value, setValue] = React.useState(
    member.hourly_cost != null ? String(member.hourly_cost) : "",
  );
  const [saving, setSaving] = React.useState(false);

  async function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.error("Enter a valid hourly cost.");
      return;
    }
    setSaving(true);
    const res = await setMemberHourlyCost(member.id, parsed);
    setSaving(false);
    if (res.ok) {
      toast.success("Cost rate saved");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
          <Clock className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Cost rate</h2>
          <p className="text-xs text-slate-400">
            Turns their logged time into a real cost on project margin
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <div className="w-full max-w-[220px]">
          <Field
            label="Cost per hour (LKR)"
            hint="What an hour of their time costs us — not their pay. Never shown to them."
          >
            <Input
              type="number"
              min={0}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 1200"
            />
          </Field>
        </div>
        <Button variant="outline" onClick={save} loading={saving}>
          Save
        </Button>
      </div>
    </section>
  );
}

function Chip({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
      {icon}
      {children}
    </span>
  );
}

function MoneyCard({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: "amber" | "primary" | "rose";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-5 shadow-[var(--shadow-card)]",
        accent === "primary"
          ? "border-primary-200 bg-primary-50/60"
          : accent === "amber"
            ? "border-amber-200 bg-amber-50/50"
            : accent === "rose"
              ? "border-rose-200 bg-rose-50/50"
              : "border-slate-200/80 bg-white",
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-2xl font-semibold",
          accent === "primary"
            ? "text-primary-700"
            : accent === "amber"
              ? "text-amber-700"
              : accent === "rose"
                ? "text-rose-700"
                : "text-slate-900",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One loan                                                            */
/* ------------------------------------------------------------------ */

function LoanRow({
  loan,
  memberName,
  onEdit,
  onRepay,
  onDelete,
}: {
  loan: LoanWithRepayments;
  memberName: string;
  onEdit: () => void;
  onRepay: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const amount = Number(loan.amount);
  const repaid = loanRepaid(loan);
  const balance = loanBalance(loan);
  const pct = amount > 0 ? Math.min(100, Math.round((repaid / amount) * 100)) : 0;
  const live = loan.approval === "approved";
  const overdue =
    live &&
    loan.status === "outstanding" &&
    !!loan.due_on &&
    isBefore(new Date(loan.due_on), startOfToday());

  const meta = loanBadge(loan);

  async function decide(approval: MemberLoanApproval) {
    const res = await setMemberLoanApproval(loan.id, loan.user_id, approval);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (approval === "approved") {
      // Say whether the text actually left, rather than letting the admin
      // assume it did when there's no number on file.
      if (res.texted) toast.success(`Approved — ${memberName} has been texted`);
      else
        toast.success("Approved", {
          description: `No SMS went out — check ${memberName} has a phone number on their profile.`,
        });
    } else {
      toast.success(approval === "declined" ? "Declined" : "Back to awaiting approval");
    }
    router.refresh();
  }

  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900">
              {formatCurrency(amount, loan.currency)}
            </span>
            <Badge className={meta.badge}>{meta.label}</Badge>
            {overdue && (
              <Badge className="bg-rose-50 text-rose-600 ring-rose-200">
                Overdue
              </Badge>
            )}
          </div>
          {loan.reason && (
            <p className="mt-0.5 text-sm text-slate-600">{loan.reason}</p>
          )}
          <p className="mt-0.5 text-xs text-slate-400">
            Issued {format(new Date(loan.issued_on), "MMM d, yyyy")}
            {loan.due_on
              ? ` · due ${format(new Date(loan.due_on), "MMM d, yyyy")}`
              : ""}
            {loan.note ? ` · ${loan.note}` : ""}
          </p>
        </div>

        <Dropdown
          trigger={
            <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <MoreVertical className="h-4 w-4" />
            </button>
          }
        >
          {loan.approval !== "approved" && (
            <DropdownItem
              icon={<CheckCircle2 className="h-4 w-4" />}
              onClick={() => decide("approved")}
            >
              Approve &amp; text them
            </DropdownItem>
          )}
          {loan.approval === "pending" && (
            <DropdownItem
              icon={<XCircle className="h-4 w-4" />}
              onClick={() => decide("declined")}
            >
              Decline
            </DropdownItem>
          )}
          {loan.approval === "approved" && loan.status !== "written_off" && (
            <DropdownItem
              icon={<Banknote className="h-4 w-4" />}
              onClick={onRepay}
            >
              Record a repayment
            </DropdownItem>
          )}
          <DropdownItem icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
            Edit loan
          </DropdownItem>
          {loan.approval === "approved" && (
          <DropdownItem
            icon={
              loan.status === "written_off" ? (
                <Undo2 className="h-4 w-4" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )
            }
            onClick={async () => {
              const next = loan.status !== "written_off";
              const res = await setMemberLoanWrittenOff(
                loan.id,
                loan.user_id,
                next,
              );
              if (res.ok) {
                toast.success(
                  next
                    ? "Written off — it no longer reduces their commission"
                    : "Back on the books",
                );
                router.refresh();
              } else toast.error(res.error);
            }}
          >
            {loan.status === "written_off"
              ? "Put back on the books"
              : "Write it off"}
          </DropdownItem>
          )}
          <DropdownItem
            destructive
            icon={<Trash2 className="h-4 w-4" />}
            onClick={onDelete}
          >
            Delete
          </DropdownItem>
        </Dropdown>
      </div>

      {/* Where it stands. Until it's granted there's nothing to track, so
        * say what's actually true instead of drawing an empty bar. */}
      {live ? (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct >= 100 ? "bg-emerald-500" : "bg-amber-500",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="text-slate-400">
              {formatCurrency(repaid, loan.currency)} repaid
            </span>
            <span
              className={cn(
                "font-medium",
                balance > 0 ? "text-amber-600" : "text-emerald-600",
              )}
            >
              {loan.status === "written_off"
                ? "Absorbed by the company"
                : balance > 0
                  ? `${formatCurrency(balance, loan.currency)} still deducted from ${memberName}'s commission`
                  : "Fully repaid — commission released"}
            </span>
          </div>
        </div>
      ) : loan.approval === "pending" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-indigo-50/70 px-3.5 py-2.5 ring-1 ring-indigo-100">
          <p className="text-xs text-indigo-800">
            Waiting on you. Nothing is deducted from {memberName}&rsquo;s
            commission yet.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => decide("declined")}>
              Decline
            </Button>
            <Button size="sm" onClick={() => decide("approved")}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-400">
          Declined — never deducted from {memberName}&rsquo;s commission.
        </p>
      )}

      {loan.repayments.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
            />
            {loan.repayments.length} repayment
            {loan.repayments.length === 1 ? "" : "s"}
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5">
              {loan.repayments.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs"
                >
                  <span className="font-semibold text-slate-800">
                    {formatCurrency(Number(r.amount), loan.currency)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">
                    {format(new Date(r.paid_on), "MMM d, yyyy")}
                    {r.method ? ` · ${r.method}` : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label="Delete repayment"
                    className="grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    onClick={async () => {
                      const res = await deleteLoanRepayment(r.id, loan.user_id);
                      if (res.ok) {
                        toast.success("Repayment removed");
                        router.refresh();
                      } else toast.error(res.error);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Issue / edit a loan                                                 */
/* ------------------------------------------------------------------ */

function LoanModal({
  open,
  userId,
  loan,
  onClose,
}: {
  open: boolean;
  userId: string;
  loan: LoanWithRepayments | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [issuedOn, setIssuedOn] = React.useState("");
  const [dueOn, setDueOn] = React.useState("");
  const [note, setNote] = React.useState("");
  const [approval, setApproval] = React.useState<MemberLoanApproval>("pending");

  React.useEffect(() => {
    if (!open) return;
    setAmount(loan ? String(Number(loan.amount)) : "");
    setReason(loan?.reason ?? "");
    setIssuedOn(loan?.issued_on ?? new Date().toISOString().slice(0, 10));
    setDueOn(loan?.due_on ?? "");
    setNote(loan?.note ?? "");
    // A new loan starts as a request: recording one must never move anyone's
    // money until somebody has actually said yes.
    setApproval(loan?.approval ?? "pending");
  }, [open, loan]);

  const value = Number(amount) || 0;
  // Saving as approved is what fires the text, so only promise it when this
  // save is the one doing the approving.
  const willNotify = approval === "approved" && loan?.approval !== "approved";

  async function submit() {
    if (value <= 0) {
      toast.error("Enter a valid loan amount.");
      return;
    }
    setPending(true);
    const res = await saveMemberLoan({
      id: loan?.id,
      user_id: userId,
      amount: value,
      currency: loan?.currency ?? "LKR",
      reason,
      issued_on: issuedOn || null,
      due_on: dueOn || null,
      note,
      approval,
    });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (willNotify && !res.texted) {
      toast.success("Approved", {
        description:
          "No SMS went out — check they have a phone number on their profile.",
      });
    } else {
      toast.success(
        willNotify
          ? "Approved — they've been texted"
          : loan
            ? "Loan updated"
            : "Loan request recorded",
      );
    }
    router.refresh();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={loan ? "Edit loan" : "Give a loan"}
      description="Money advanced against commission they've earned or will earn."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {loan ? "Save changes" : "Record loan"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Amount" required>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="What it's for" hint="Shown to them on their profile.">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Advance for medical bill"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Issued on">
            <Input
              type="date"
              value={issuedOn}
              onChange={(e) => setIssuedOn(e.target.value)}
            />
          </Field>
          <Field label="Due back by" hint="Optional.">
            <Input
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Approval"
          hint={
            approval === "approved"
              ? "Approved money is deducted from their commission straight away."
              : approval === "declined"
                ? "Kept on the record, never deducted."
                : "Logged as a request — it changes none of their numbers yet."
          }
        >
          <Select
            value={approval}
            onChange={(e) =>
              setApproval(e.target.value as MemberLoanApproval)
            }
          >
            <option value="pending">Pending approval</option>
            <option value="approved">Approved</option>
            {loan && <option value="declined">Declined</option>}
          </Select>
        </Field>

        <Field label="Internal note">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {value > 0 && willNotify && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700 ring-1 ring-amber-200">
            On save, {formatCurrency(value)} comes off their commission balance
            and they get a text saying the loan was approved. It goes back on as
            they repay it.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Record a repayment                                                  */
/* ------------------------------------------------------------------ */

function RepaymentModal({
  loan,
  userId,
  onClose,
}: {
  loan: LoanWithRepayments | null;
  userId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [paidOn, setPaidOn] = React.useState("");
  const [method, setMethod] = React.useState("");
  const [note, setNote] = React.useState("");

  const balance = loan ? loanBalance(loan) : 0;

  React.useEffect(() => {
    if (!loan) return;
    // Default to clearing the loan — the common case is "they paid it off".
    setAmount(String(loanBalance(loan)));
    setPaidOn(new Date().toISOString().slice(0, 10));
    setMethod("");
    setNote("");
  }, [loan]);

  const value = Number(amount) || 0;
  const remaining = Math.max(0, balance - value);

  async function submit() {
    if (!loan) return;
    if (value <= 0) {
      toast.error("Enter a valid repayment amount.");
      return;
    }
    setPending(true);
    const res = await saveLoanRepayment({
      loan_id: loan.id,
      user_id: userId,
      amount: value,
      paid_on: paidOn || null,
      method,
      note,
    });
    setPending(false);
    if (res.ok) {
      toast.success(
        remaining === 0
          ? "Loan settled — commission released"
          : "Repayment recorded",
      );
      router.refresh();
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={!!loan}
      onClose={onClose}
      title="Record a repayment"
      description={
        loan
          ? `${formatCurrency(balance, loan.currency)} outstanding on the ${formatCurrency(Number(loan.amount), loan.currency)} loan.`
          : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Record repayment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Paid on">
            <Input
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </Field>
        </div>

        <Field label="How" hint="Cash, bank transfer, withheld from payout…">
          <Input
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            placeholder="Cash"
          />
        </Field>

        <Field label="Note">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {value > 0 && (
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-xs text-emerald-700 ring-1 ring-emerald-200">
            {formatCurrency(value)} goes back onto their commission balance.
            {remaining > 0
              ? ` ${formatCurrency(remaining)} would still be outstanding.`
              : " The loan is settled in full."}
          </p>
        )}
      </div>
    </Modal>
  );
}
