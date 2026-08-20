"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Activity,
  Calendar,
  Copy,
  Mail,
  MessageSquareText,
  MonitorSmartphone,
  MoreVertical,
  Pencil,
  Phone,
  Send,
  Shield,
  ShieldCheck,
  Smartphone,
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
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { COMMISSION_STATUS_META } from "@/lib/constants";
import { formatPhone } from "@/lib/sms-utils";
import { cn, formatCurrency } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { Commission, Invitation, Profile, UserRole } from "@/lib/types";

import {
  createInvite,
  removeMember,
  resetMemberDevices,
  revokeInvite,
  updateMemberProfile,
  updateMemberRole,
} from "./actions";
import { ActivityModal } from "./activity-modal";
import { PingModal } from "./ping-modal";

type MemberCommission = Commission & {
  project?: { id: string; name: string } | null;
};

export type MemberDevice = {
  id: string;
  user_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
};

type MemberGrace = { user_id: string; started_at: string };

/** Keep in sync with GRACE_HOURS in src/lib/device-trust.ts (server-only). */
const DEVICE_GRACE_HOURS = 48;

export function TeamView({
  members,
  invitations,
  commissions,
  trustedDevices,
  deviceGrace,
  onlineUserIds,
  currentUserId,
  currentUserName,
  appBaseUrl,
}: {
  members: Profile[];
  invitations: Invitation[];
  commissions: MemberCommission[];
  trustedDevices: MemberDevice[];
  deviceGrace: MemberGrace[];
  onlineUserIds: string[];
  currentUserId: string;
  currentUserName: string;
  appBaseUrl: string;
}) {
  // login_sessions heartbeats keep the "online now" dots fresh.
  useRealtimeSyncTables(["profiles", "invitations", "trusted_devices", "login_sessions"]);
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
  const [toEdit, setToEdit] = React.useState<Profile | null>(null);
  const [toResetDevices, setToResetDevices] = React.useState<Profile | null>(
    null,
  );
  const [activityFor, setActivityFor] = React.useState<Profile | null>(null);
  const [toMessage, setToMessage] = React.useState<Profile | null>(null);

  const onlineSet = React.useMemo(() => new Set(onlineUserIds), [onlineUserIds]);

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

  const devicesByUser = React.useMemo(() => {
    const map = new Map<string, MemberDevice[]>();
    for (const d of trustedDevices) {
      const list = map.get(d.user_id);
      if (list) list.push(d);
      else map.set(d.user_id, [d]);
    }
    return map;
  }, [trustedDevices]);

  const graceByUser = React.useMemo(() => {
    const map = new Map<string, MemberGrace>();
    for (const g of deviceGrace) map.set(g.user_id, g);
    return map;
  }, [deviceGrace]);

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

      {/* Members — a profile card each */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          Members ({members.length})
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {members.map((m) => {
            const commissionTotal = (commissionsByUser.get(m.id) ?? []).reduce(
              (s, c) => s + Number(c.amount),
              0,
            );
            const deviceCount = (devicesByUser.get(m.id) ?? []).length;
            // Presence is only tracked for members (the activity heartbeat).
            const online = m.role === "member" && onlineSet.has(m.id);
            // hover/focus-within raise the card so its ⋮ menu, which can hang
            // past the card's bottom edge, isn't painted under the next card.
            return (
              <div
                key={m.id}
                className="relative flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition hover:z-10 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] focus-within:z-10"
              >
                <div className="absolute right-2.5 top-2.5">
                  <Dropdown
                    trigger={
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    }
                  >
                    <DropdownItem
                      icon={<Pencil className="h-4 w-4" />}
                      onClick={() => setToEdit(m)}
                    >
                      Edit profile
                    </DropdownItem>
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
                    {online && (
                      <DropdownItem
                        icon={<MessageSquareText className="h-4 w-4" />}
                        onClick={() => setToMessage(m)}
                      >
                        Send pop-up message
                      </DropdownItem>
                    )}
                    {m.role === "member" && (
                      <DropdownItem
                        icon={<Activity className="h-4 w-4" />}
                        onClick={() => setActivityFor(m)}
                      >
                        Activity
                      </DropdownItem>
                    )}
                    {m.role === "member" && (
                      <DropdownItem
                        icon={<Smartphone className="h-4 w-4" />}
                        onClick={() => setToResetDevices(m)}
                      >
                        Reset trusted devices
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
                </div>

                {/* Identity — the whole block opens the member's details */}
                <button
                  type="button"
                  onClick={() => setSelected(m)}
                  className="flex w-full flex-col items-center px-2 text-center"
                  title="View member details"
                >
                  <span className="relative">
                    <Avatar name={m.full_name} src={m.avatar_url} size="xl" />
                    {online && (
                      <span
                        className="absolute bottom-0.5 right-0.5 block h-4 w-4 rounded-full bg-emerald-500 ring-[3px] ring-white"
                        title="Online now"
                      />
                    )}
                  </span>
                  <p className="mt-3 flex max-w-full items-center gap-1.5">
                    <span className="truncate text-base font-semibold text-slate-900">
                      {m.full_name || m.username}
                    </span>
                    {m.id === currentUserId && (
                      <span className="shrink-0 text-xs font-normal text-slate-400">
                        (you)
                      </span>
                    )}
                  </p>
                  <p className="max-w-full truncate text-xs text-slate-400">
                    @{m.username}
                    {m.title ? ` · ${m.title}` : ""}
                  </p>
                  <Badge
                    className={cn(
                      "mt-2.5",
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
                </button>

                {/* Contact */}
                <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-3.5 text-xs text-slate-500">
                  <p className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{m.email}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    {m.phone ? (
                      formatPhone(m.phone)
                    ) : (
                      <span className="text-slate-400">No phone on file</span>
                    )}
                  </p>
                </div>

                {/* Footer stats */}
                <div className="mt-auto grid grid-cols-2 gap-3 border-t border-slate-100 pt-3.5">
                  <div>
                    <p className="flex items-center gap-1 text-[11px] text-slate-400">
                      <Wallet className="h-3 w-3" /> Commission
                    </p>
                    <p className="mt-0.5 text-sm font-semibold text-slate-900">
                      {formatCurrency(commissionTotal)}
                    </p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-[11px] text-slate-400">
                      <MonitorSmartphone className="h-3 w-3" /> Devices
                    </p>
                    <p className="mt-0.5 text-sm font-semibold text-slate-900">
                      {m.role === "admin" ? (
                        <span className="text-slate-400">Exempt</span>
                      ) : (
                        `${deviceCount}/2`
                      )}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <MemberDetailModal
        member={selected}
        commissions={selected ? commissionsByUser.get(selected.id) ?? [] : []}
        devices={selected ? devicesByUser.get(selected.id) ?? [] : []}
        graceStartedAt={
          selected ? graceByUser.get(selected.id)?.started_at ?? null : null
        }
        isYou={selected?.id === currentUserId}
        onClose={() => setSelected(null)}
      />

      <EditMemberModal member={toEdit} onClose={() => setToEdit(null)} />

      <ActivityModal
        member={activityFor}
        devices={activityFor ? devicesByUser.get(activityFor.id) ?? [] : []}
        onClose={() => setActivityFor(null)}
      />

      <PingModal
        member={toMessage}
        adminName={currentUserName}
        onClose={() => setToMessage(null)}
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

      <ConfirmDialog
        open={!!toResetDevices}
        onClose={() => setToResetDevices(null)}
        title="Reset trusted devices"
        description={`Reset ${
          toResetDevices?.full_name || toResetDevices?.username
        }'s trusted devices? Their registered devices will be removed and they'll get a fresh 48-hour window to register new ones.`}
        confirmLabel="Reset devices"
        onConfirm={async () => {
          if (!toResetDevices) return;
          const res = await resetMemberDevices(toResetDevices.id);
          if (res.ok) {
            toast.success("Trusted devices reset");
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

/** Admin edit of another member's details (name, title, phone for SMS alerts). */
function EditMemberModal({
  member,
  onClose,
}: {
  member: Profile | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [fullName, setFullName] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [saving, startSave] = React.useTransition();

  React.useEffect(() => {
    if (!member) return;
    setFullName(member.full_name ?? "");
    setTitle(member.title ?? "");
    setPhone(member.phone ? formatPhone(member.phone) : "");
  }, [member]);

  function save() {
    if (!member) return;
    startSave(async () => {
      const res = await updateMemberProfile(member.id, {
        full_name: fullName,
        title,
        phone,
      });
      if (res.ok) {
        toast.success("Profile updated");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={member ? `Edit ${member.full_name || member.username}` : ""}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!fullName.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      {member && (
        <div className="space-y-4">
          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
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
            hint="They'll get an SMS alert when assigned a task or tagged. Sri Lankan number, e.g. 0712345678."
          >
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0712345678"
              inputMode="tel"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function MemberDetailModal({
  member,
  commissions,
  devices,
  graceStartedAt,
  isYou,
  onClose,
}: {
  member: Profile | null;
  commissions: MemberCommission[];
  devices: MemberDevice[];
  graceStartedAt: string | null;
  isYou: boolean;
  onClose: () => void;
}) {
  const deviceStatus = React.useMemo(() => {
    if (!member || member.role !== "member") return null;
    if (devices.length >= 2) return "Locked to their 2 registered devices.";
    if (devices.length === 1)
      return "1 of 2 devices registered — the second joins via SMS code at login.";
    if (!graceStartedAt)
      return "Registration window hasn't started — begins at their next sign-in.";
    const deadline = new Date(
      new Date(graceStartedAt).getTime() + DEVICE_GRACE_HOURS * 3_600_000,
    );
    if (Date.now() < deadline.getTime())
      return `Must trust a device by ${format(deadline, "MMM d, h:mm a")}.`;
    return "Locked out — reset devices to grant a new 48-hour window.";
  }, [member, devices, graceStartedAt]);

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
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-500">
              <Calendar className="h-4 w-4 text-slate-400" />
              Joined {format(new Date(member.created_at), "MMM d, yyyy")}
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-500">
              <Phone className="h-4 w-4 text-slate-400" />
              {member.phone
                ? formatPhone(member.phone)
                : "No phone — SMS alerts off"}
            </div>
          </div>

          {/* Trusted devices (members only — admins are exempt) */}
          {member.role === "member" && (
            <div className="rounded-2xl border border-slate-200/80">
              <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
                <MonitorSmartphone className="h-4 w-4 text-primary-500" />
                <h4 className="text-sm font-semibold text-slate-900">
                  Trusted devices
                </h4>
                <span className="text-xs text-slate-400">
                  ({devices.length}/2)
                </span>
              </div>
              <div className="px-4 py-3">
                {deviceStatus && (
                  <p className="text-xs text-slate-500">{deviceStatus}</p>
                )}
                {!member.phone && devices.length < 2 && (
                  <p className="mt-1 text-xs font-medium text-amber-600">
                    No phone on file — SMS device codes can&apos;t be
                    delivered.
                  </p>
                )}
                {devices.length > 0 && (
                  <ul className="mt-2.5 space-y-1.5">
                    {devices.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
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
            </div>
          )}

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
