"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Camera, HandCoins, KeyRound, Wallet } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { COMMISSION_STATUS_META, STORAGE_BUCKETS } from "@/lib/constants";
import {
  loanBadge,
  loanBalance,
  loanRepaid,
  summariseMemberMoney,
  type LoanWithRepayments,
} from "@/lib/loans";
import { formatPhone } from "@/lib/sms-utils";
import { uploadFile } from "@/lib/upload";
import { cn, formatCurrency } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { Commission, Profile } from "@/lib/types";

import { changePassword, updateProfile } from "./actions";
import { PushToggle } from "./push-toggle";
import {
  TrustedDevicesCard,
  type TrustedDeviceInfo,
} from "./trusted-devices-card";

type CommissionRow = Commission & {
  project?: { id: string; name: string } | null;
};

export function ProfileView({
  profile,
  commissions,
  loans,
  trustedDevices,
  phoneMask,
}: {
  profile: Profile;
  commissions: CommissionRow[];
  /** 0088 — advances taken against this commission, and what's left to repay. */
  loans: LoanWithRepayments[];
  /** null for admins — they're exempt from the device lock. */
  trustedDevices: TrustedDeviceInfo[] | null;
  phoneMask: string | null;
}) {
  // A loan recorded (or a repayment logged) by an admin should show up here
  // without the person having to reload the page to find out.
  useRealtimeSyncTables(["commissions", "member_loans", "member_loan_repayments"]);

  const router = useRouter();
  const [fullName, setFullName] = React.useState(profile.full_name);
  const [title, setTitle] = React.useState(profile.title ?? "");
  const [phone, setPhone] = React.useState(
    profile.phone ? formatPhone(profile.phone) : "",
  );
  const [savingProfile, startSaveProfile] = React.useTransition();
  const [uploading, setUploading] = React.useState(false);

  const [password, setPassword] = React.useState("");
  const [savingPw, startSavePw] = React.useTransition();

  const money = React.useMemo(
    () => summariseMemberMoney(commissions, loans),
    [commissions, loans],
  );
  const openLoans = loans.filter(
    (l) => l.approval === "approved" && l.status === "outstanding",
  );

  function saveProfile() {
    startSaveProfile(async () => {
      const res = await updateProfile({ full_name: fullName, title, phone });
      if (res.ok) {
        toast.success("Profile updated");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadFile(
        STORAGE_BUCKETS.avatars,
        file,
        profile.id,
      );
      const res = await updateProfile({ avatar_url: publicUrl });
      if (res.ok) {
        toast.success("Photo updated");
        router.refresh();
      } else toast.error(res.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function savePassword() {
    startSavePw(async () => {
      const res = await changePassword(password);
      if (res.ok) {
        toast.success("Password changed");
        setPassword("");
      } else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Profile"
        description="Manage your account and view your commissions."
      />

      {/* Identity card */}
      <div className="flex flex-col items-start gap-5 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)] sm:flex-row sm:items-center">
        <div className="relative">
          <Avatar name={profile.full_name} src={profile.avatar_url} size="xl" />
          <label className="absolute -bottom-1 -right-1 grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-primary-600 text-white shadow-md hover:bg-primary-700">
            <Camera className="h-4 w-4" />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onAvatar}
              disabled={uploading}
            />
          </label>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-slate-900">
              {profile.full_name || profile.username}
            </h2>
            <Badge
              className={
                profile.role === "admin"
                  ? "bg-primary-50 text-primary-700 ring-primary-200"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
              }
            >
              {profile.role}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-slate-400">
            @{profile.username} · {profile.email}
          </p>
        </div>
      </div>

      {/* Commission summary — loans come off it, so they're shown together */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Total commission"
          value={formatCurrency(money.commissionEarned)}
        />
        <SummaryCard label="Paid out" value={formatCurrency(money.commissionPaidOut)} />
        <SummaryCard
          label="Loan to repay"
          value={
            money.loansOutstanding > 0
              ? `− ${formatCurrency(money.loansOutstanding)}`
              : formatCurrency(0)
          }
          tone={money.loansOutstanding > 0 ? "amber" : undefined}
          hint={
            money.pendingCount > 0
              ? `${formatCurrency(money.loansPending)} requested, awaiting approval`
              : money.loansIssued > 0
                ? `${formatCurrency(money.loansRepaid)} of ${formatCurrency(money.loansIssued)} repaid`
                : undefined
          }
        />
        <SummaryCard
          label={money.netPayable < 0 ? "You owe the company" : "Due to you"}
          value={formatCurrency(Math.abs(money.netPayable))}
          hint="Commission still owed, less what's left on your loan"
          accent={money.netPayable >= 0}
          tone={money.netPayable < 0 ? "rose" : undefined}
        />
      </div>

      {/* Loans — read-only: only an admin can record one or a repayment */}
      {loans.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
              <HandCoins className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                My loans &amp; advances
              </h3>
              <p className="text-xs text-slate-400">
                {openLoans.length > 0
                  ? `${formatCurrency(money.loansOutstanding)} still to repay — it's held back from your commission until it's cleared.`
                  : "All settled — nothing is being held back."}
                {money.pendingCount > 0 &&
                  ` · ${formatCurrency(money.loansPending)} requested and awaiting approval.`}
              </p>
            </div>
          </div>
          <ul className="divide-y divide-slate-50">
            {loans.map((loan) => {
              const amount = Number(loan.amount);
              const repaid = loanRepaid(loan);
              const balance = loanBalance(loan);
              const live = loan.approval === "approved";
              const pct =
                amount > 0 ? Math.min(100, Math.round((repaid / amount) * 100)) : 0;
              const meta = loanBadge(loan);
              return (
                <li key={loan.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-slate-900">
                        {formatCurrency(amount, loan.currency)}
                      </span>
                      <Badge className={meta.badge}>{meta.label}</Badge>
                    </div>
                    {live && (
                      <span
                        className={cn(
                          "text-sm font-semibold",
                          balance > 0 ? "text-amber-600" : "text-emerald-600",
                        )}
                      >
                        {balance > 0
                          ? `${formatCurrency(balance, loan.currency)} to repay`
                          : "Cleared"}
                      </span>
                    )}
                  </div>
                  {loan.reason && (
                    <p className="mt-0.5 text-sm text-slate-600">{loan.reason}</p>
                  )}
                  <p className="mt-0.5 text-xs text-slate-400">
                    {live ? "Taken" : "Requested"}{" "}
                    {format(new Date(loan.issued_on), "MMM d, yyyy")}
                    {live && loan.due_on
                      ? ` · due back ${format(new Date(loan.due_on), "MMM d, yyyy")}`
                      : ""}
                  </p>
                  {/* A request isn't money yet — no progress to draw. */}
                  {live ? (
                    <>
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            pct >= 100 ? "bg-emerald-500" : "bg-amber-500",
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-slate-400">
                        {formatCurrency(repaid, loan.currency)} of{" "}
                        {formatCurrency(amount, loan.currency)} repaid
                        {loan.repayments.length > 0
                          ? ` · last on ${format(new Date(loan.repayments[0].paid_on), "MMM d, yyyy")}`
                          : ""}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-slate-400">
                      {loan.approval === "pending"
                        ? "Waiting for approval — nothing is being held back from your commission yet."
                        : "Declined — nothing was held back from your commission."}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Settings */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h3 className="text-sm font-semibold text-slate-900">
              Account details
            </h3>
            <div className="mt-4 space-y-4">
              <Field label="Full name">
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </Field>
              <Field label="Title / role">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Designer"
                />
              </Field>
              <Field
                label="Phone number"
                hint="You'll get an SMS alert when you're assigned a task or tagged. Sri Lankan number, e.g. 0712345678."
              >
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0712345678"
                  inputMode="tel"
                />
              </Field>
              <Button onClick={saveProfile} loading={savingProfile}>
                Save changes
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <KeyRound className="h-4 w-4 text-slate-400" /> Change password
            </h3>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <Input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <Button
                variant="outline"
                onClick={savePassword}
                loading={savingPw}
                disabled={!password}
              >
                Update
              </Button>
            </div>
          </div>

          {trustedDevices && (
            <TrustedDevicesCard
              devices={trustedDevices}
              phoneMask={phoneMask}
            />
          )}

          <PushToggle />
        </div>

        {/* Commissions list */}
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
              <Wallet className="h-5 w-5" />
            </span>
            <h3 className="text-sm font-semibold text-slate-900">
              My commissions
            </h3>
          </div>
          {commissions.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-slate-400">
              No commissions yet. When an admin allocates one, it shows up here.
            </p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {commissions.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {c.project?.name ?? "General"}
                    </p>
                    <p className="text-xs text-slate-400">
                      {format(new Date(c.created_at), "MMM d, yyyy")}
                      {c.percentage != null ? ` · ${c.percentage}%` : ""}
                    </p>
                  </div>
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(Number(c.amount))}
                  </span>
                  <Badge className={COMMISSION_STATUS_META[c.status].badge}>
                    {COMMISSION_STATUS_META[c.status].label}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  accent,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  tone?: "amber" | "rose";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-5",
        tone === "amber"
          ? "border-amber-200 bg-amber-50/60"
          : tone === "rose"
            ? "border-rose-200 bg-rose-50/60"
            : accent
              ? "border-primary-200 bg-primary-50"
              : "border-slate-200/80 bg-white shadow-[var(--shadow-card)]",
      )}
    >
      <p className="text-sm text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold",
          tone === "amber"
            ? "text-amber-700"
            : tone === "rose"
              ? "text-rose-700"
              : accent
                ? "text-primary-700"
                : "text-slate-900",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
