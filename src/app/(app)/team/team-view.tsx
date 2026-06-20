"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Calendar,
  ChevronRight,
  Copy,
  Mail,
  MoreVertical,
  Send,
  Shield,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { COMMISSION_STATUS_META } from "@/lib/constants";
import { cn, formatCurrency } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { Commission, Invitation, Profile, UserRole } from "@/lib/types";

import {
  createInvite,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from "./actions";

type MemberCommission = Commission & {
  project?: { id: string; name: string } | null;
};

export function TeamView({
  members,
  invitations,
  commissions,
  currentUserId,
  appBaseUrl,
}: {
  members: Profile[];
  invitations: Invitation[];
  commissions: MemberCommission[];
  currentUserId: string;
  appBaseUrl: string;
}) {
  useRealtimeSyncTables(["profiles", "invitations"]);
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<UserRole>("member");
  const [sending, startSend] = React.useTransition();
  const [lastInvite, setLastInvite] = React.useState<{
    url: string;
    emailSent: boolean;
  } | null>(null);
  const [toRemove, setToRemove] = React.useState<Profile | null>(null);
  const [selected, setSelected] = React.useState<Profile | null>(null);

  // Group commissions by member so each profile shows its own allocations.
  const commissionsByUser = React.useMemo(() => {
    const map = new Map<string, MemberCommission[]>();
    for (const c of commissions) {
      const list = map.get(c.user_id);
      if (list) list.push(c);
      else map.set(c.user_id, [c]);
    }
    return map;
  }, [commissions]);

  const pending = invitations.filter((i) => i.status === "pending");
  const adminCount = members.filter((m) => m.role === "admin").length;
  const base =
    appBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  function invite() {
    if (!email.trim()) {
      toast.error("Enter an email address.");
      return;
    }
    startSend(async () => {
      const res = await createInvite(email, role);
      if (res.ok) {
        setLastInvite({ url: res.inviteUrl, emailSent: res.emailSent });
        setEmail("");
        toast.success(
          res.emailSent ? "Invite sent" : "Invite created — copy the link below",
        );
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team & Access"
        description="Invite people, manage roles, and control who's in the workspace."
      />

      {/* Stats — only the admin sees these numbers */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Members"
          value={members.length}
        />
        <StatCard
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Admins"
          value={adminCount}
        />
        <StatCard
          icon={<Mail className="h-5 w-5" />}
          label="Pending invites"
          value={pending.length}
        />
      </div>

      {/* Invite */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <UserPlus className="h-4 w-4 text-primary-500" /> Invite a teammate
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          They&apos;ll get a link to join. Credentials are generated automatically.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Input
            type="email"
            placeholder="name@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="sm:w-40"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
          <Button onClick={invite} loading={sending}>
            <Send className="h-4 w-4" /> Send invite
          </Button>
        </div>

        {lastInvite && (
          <div className="mt-4">
            <Alert variant={lastInvite.emailSent ? "success" : "info"}>
              {lastInvite.emailSent
                ? "Invitation email sent. You can also share this link:"
                : "Email wasn't sent (Resend not configured). Share this link manually:"}
            </Alert>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <span className="truncate text-xs text-slate-500">
                {lastInvite.url}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(lastInvite.url);
                  toast.success("Link copied");
                }}
                className="ml-auto shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pending invites */}
      {pending.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="border-b border-slate-100 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Pending invitations
            </h2>
          </div>
          <ul className="divide-y divide-slate-50">
            {pending.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/60"
              >
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
                  <Mail className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {inv.email}
                  </p>
                  <p className="text-xs text-slate-400">
                    {inv.role} · invited{" "}
                    {formatDistanceToNow(new Date(inv.created_at), {
                      addSuffix: true,
                    })}
                  </p>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${base}/join/${inv.token}`);
                    toast.success("Invite link copied");
                  }}
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Copy invite link"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <button
                  onClick={async () => {
                    const res = await revokeInvite(inv.id);
                    if (res.ok) {
                      toast.success("Invite revoked");
                      router.refresh();
                    } else toast.error(res.error);
                  }}
                  className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  aria-label="Revoke invite"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Members */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Members ({members.length})
          </h2>
        </div>
        <ul className="divide-y divide-slate-50">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/60"
            >
              <button
                type="button"
                onClick={() => setSelected(m)}
                className="-my-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1.5 text-left transition hover:opacity-80"
                title="View member details"
              >
                <Avatar name={m.full_name} src={m.avatar_url} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    <span className="truncate">{m.full_name || m.username}</span>
                    {m.id === currentUserId && (
                      <span className="text-xs font-normal text-slate-400">
                        (you)
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    @{m.username} · {m.email}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
              </button>
              {(() => {
                const total = (commissionsByUser.get(m.id) ?? []).reduce(
                  (s, c) => s + Number(c.amount),
                  0,
                );
                return total > 0 ? (
                  <span className="hidden shrink-0 items-center gap-1 text-xs font-medium text-slate-500 sm:flex">
                    <Wallet className="h-3.5 w-3.5 text-slate-400" />
                    {formatCurrency(total)}
                  </span>
                ) : null;
              })()}
              <Badge
                className={cn(
                  m.role === "admin"
                    ? "bg-primary-50 text-primary-700 ring-primary-200"
                    : "bg-slate-100 text-slate-600 ring-slate-200",
                )}
              >
                {m.role === "admin" ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <Shield className="h-3 w-3" />
                )}
                {m.role}
              </Badge>
              <Dropdown
                trigger={
                  <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                    <MoreVertical className="h-4 w-4" />
                  </button>
                }
              >
                {m.role === "member" ? (
                  <DropdownItem
                    icon={<ShieldCheck className="h-4 w-4" />}
                    onClick={async () => {
                      const res = await updateMemberRole(m.id, "admin");
                      if (res.ok) {
                        toast.success("Promoted to admin");
                        router.refresh();
                      } else toast.error(res.error);
                    }}
                  >
                    Make admin
                  </DropdownItem>
                ) : (
                  <DropdownItem
                    icon={<Shield className="h-4 w-4" />}
                    onClick={async () => {
                      const res = await updateMemberRole(m.id, "member");
                      if (res.ok) {
                        toast.success("Changed to member");
                        router.refresh();
                      } else toast.error(res.error);
                    }}
                  >
                    Make member
                  </DropdownItem>
                )}
                <DropdownItem
                  destructive
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setToRemove(m)}
                >
                  Remove from workspace
                </DropdownItem>
              </Dropdown>
            </li>
          ))}
        </ul>
      </div>

      <MemberDetailModal
        member={selected}
        commissions={selected ? commissionsByUser.get(selected.id) ?? [] : []}
        isYou={selected?.id === currentUserId}
        onClose={() => setSelected(null)}
      />

      <ConfirmDialog
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        title="Remove member"
        description={`Remove ${toRemove?.full_name || toRemove?.username}? Their account will be deleted.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!toRemove) return;
          const res = await removeMember(toRemove.id);
          if (res.ok) {
            toast.success("Member removed");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-500">
        {icon}
      </span>
      <div>
        <p className="text-2xl font-semibold text-slate-900">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
      </div>
    </div>
  );
}

function MemberDetailModal({
  member,
  commissions,
  isYou,
  onClose,
}: {
  member: Profile | null;
  commissions: MemberCommission[];
  isYou: boolean;
  onClose: () => void;
}) {
  const totals = React.useMemo(() => {
    const sum = (pred: (c: MemberCommission) => boolean) =>
      commissions.filter(pred).reduce((s, c) => s + Number(c.amount), 0);
    return {
      total: sum(() => true),
      paid: sum((c) => c.status === "paid"),
      outstanding: sum((c) => c.status !== "paid"),
    };
  }, [commissions]);

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title="Member details"
      size="lg"
    >
      {member && (
        <div className="space-y-6">
          {/* Identity */}
          <div className="flex items-center gap-4">
            <Avatar name={member.full_name} src={member.avatar_url} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-slate-900">
                  {member.full_name || member.username}
                </h3>
                {isYou && (
                  <span className="text-xs font-normal text-slate-400">(you)</span>
                )}
                <Badge
                  className={cn(
                    member.role === "admin"
                      ? "bg-primary-50 text-primary-700 ring-primary-200"
                      : "bg-slate-100 text-slate-600 ring-slate-200",
                  )}
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
                <p className="text-sm text-slate-500">{member.title}</p>
              )}
              <p className="truncate text-xs text-slate-400">
                @{member.username} · {member.email}
              </p>
            </div>
          </div>

          {/* Meta */}
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-500">
            <Calendar className="h-4 w-4 text-slate-400" />
            Joined {format(new Date(member.created_at), "MMM d, yyyy")}
          </div>

          {/* Commission summary */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="Total" value={formatCurrency(totals.total)} accent />
            <SummaryCard label="Paid out" value={formatCurrency(totals.paid)} />
            <SummaryCard
              label="Outstanding"
              value={formatCurrency(totals.outstanding)}
            />
          </div>

          {/* Commission list */}
          <div className="rounded-2xl border border-slate-200/80">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <Wallet className="h-4 w-4 text-primary-500" />
              <h4 className="text-sm font-semibold text-slate-900">
                Commissions
              </h4>
              <span className="text-xs text-slate-400">
                ({commissions.length})
              </span>
            </div>
            {commissions.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                No commissions allocated yet.
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-slate-50 overflow-y-auto">
                {commissions.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {c.project?.name ?? "—"}
                      </p>
                      <p className="text-xs text-slate-400">
                        {format(new Date(c.created_at), "MMM d, yyyy")}
                        {c.percentage != null && ` · ${c.percentage}%`}
                      </p>
                    </div>
                    <Badge className={COMMISSION_STATUS_META[c.status].badge}>
                      {COMMISSION_STATUS_META[c.status].label}
                    </Badge>
                    <p className="w-24 shrink-0 text-right text-sm font-semibold text-slate-900">
                      {formatCurrency(Number(c.amount))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
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
      className={cn(
        "rounded-xl border p-3.5",
        accent
          ? "border-primary-200 bg-primary-50/60"
          : "border-slate-200/80 bg-white",
      )}
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold",
          accent ? "text-primary-700" : "text-slate-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}
