"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Camera, KeyRound, Wallet } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { COMMISSION_STATUS_META, STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { formatCurrency } from "@/lib/utils";
import type { Commission, Profile } from "@/lib/types";

import { changePassword, updateProfile } from "./actions";

type CommissionRow = Commission & {
  project?: { id: string; name: string } | null;
};

export function ProfileView({
  profile,
  commissions,
}: {
  profile: Profile;
  commissions: CommissionRow[];
}) {
  const router = useRouter();
  const [fullName, setFullName] = React.useState(profile.full_name);
  const [title, setTitle] = React.useState(profile.title ?? "");
  const [savingProfile, startSaveProfile] = React.useTransition();
  const [uploading, setUploading] = React.useState(false);

  const [password, setPassword] = React.useState("");
  const [savingPw, startSavePw] = React.useTransition();

  const totals = React.useMemo(() => {
    const sum = (pred: (c: CommissionRow) => boolean) =>
      commissions.filter(pred).reduce((s, c) => s + Number(c.amount), 0);
    return {
      total: sum(() => true),
      paid: sum((c) => c.status === "paid"),
      pending: sum((c) => c.status !== "paid"),
    };
  }, [commissions]);

  function saveProfile() {
    startSaveProfile(async () => {
      const res = await updateProfile({ full_name: fullName, title });
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

      {/* Commission summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total commission" value={formatCurrency(totals.total)} accent />
        <SummaryCard label="Paid out" value={formatCurrency(totals.paid)} />
        <SummaryCard label="Outstanding" value={formatCurrency(totals.pending)} />
      </div>

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
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? "rounded-2xl border border-primary-200 bg-primary-50 p-5"
          : "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
      }
    >
      <p className="text-sm text-slate-500">{label}</p>
      <p
        className={
          accent
            ? "mt-1 text-2xl font-semibold text-primary-700"
            : "mt-1 text-2xl font-semibold text-slate-900"
        }
      >
        {value}
      </p>
    </div>
  );
}
