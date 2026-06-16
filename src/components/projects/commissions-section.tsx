"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreVertical, Pencil, Plus, Trash2, Wallet } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { COMMISSION_STATUS_META } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type {
  Commission,
  CommissionStatus,
  MemberLite,
} from "@/lib/types";

import {
  deleteCommission,
  saveCommission,
  type CommissionInput,
} from "@/app/(app)/projects/actions";

export type CommissionRow = Commission & {
  recipient?: Pick<MemberLite, "id" | "full_name" | "username" | "avatar_url"> | null;
};

export function CommissionsSection({
  projectId,
  currency,
  isAdmin,
  members,
  commissions,
}: {
  projectId: string;
  currency: string;
  isAdmin: boolean;
  members: MemberLite[];
  commissions: CommissionRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<Commission | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Commission | null>(null);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
            <Wallet className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Commissions</h2>
            <p className="text-xs text-slate-400">
              {isAdmin
                ? "Allocate commissions to team members."
                : "Commissions allocated to you."}
            </p>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Allocate
          </Button>
        )}
      </div>

      {commissions.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          {isAdmin
            ? "No commissions allocated yet."
            : "You have no commissions on this project."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-50">
          {commissions.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/60"
            >
              <Avatar
                name={c.recipient?.full_name ?? "User"}
                src={c.recipient?.avatar_url}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">
                  {c.recipient?.full_name || c.recipient?.username || "—"}
                </p>
                {c.note && (
                  <p className="truncate text-xs text-slate-400">{c.note}</p>
                )}
              </div>
              <div className="text-right">
                <p className="font-semibold text-slate-900">
                  {formatCurrency(Number(c.amount), currency)}
                </p>
                {c.percentage != null && (
                  <p className="text-xs text-slate-400">{c.percentage}%</p>
                )}
              </div>
              <Badge className={COMMISSION_STATUS_META[c.status].badge}>
                {COMMISSION_STATUS_META[c.status].label}
              </Badge>
              {isAdmin && (
                <Dropdown
                  trigger={
                    <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  }
                >
                  <DropdownItem
                    icon={<Pencil className="h-4 w-4" />}
                    onClick={() => setEditing(c)}
                  >
                    Edit
                  </DropdownItem>
                  <DropdownItem
                    destructive
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setToDelete(c)}
                  >
                    Delete
                  </DropdownItem>
                </Dropdown>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <CommissionModal
          open={creating || !!editing}
          projectId={projectId}
          members={members}
          commission={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete commission"
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteCommission(toDelete.id, projectId);
          if (res.ok) {
            toast.success("Commission removed");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </section>
  );
}

function CommissionModal({
  open,
  projectId,
  members,
  commission,
  onClose,
}: {
  open: boolean;
  projectId: string;
  members: MemberLite[];
  commission: Commission | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<CommissionInput>({
    project_id: projectId,
    user_id: "",
    amount: 0,
  });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      commission
        ? {
            id: commission.id,
            project_id: projectId,
            user_id: commission.user_id,
            amount: Number(commission.amount),
            percentage: commission.percentage,
            status: commission.status,
            note: commission.note ?? "",
          }
        : { project_id: projectId, user_id: "", amount: 0, status: "pending" },
    );
  }, [open, commission, projectId]);

  function set<K extends keyof CommissionInput>(k: K, v: CommissionInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await saveCommission(form);
      if (res.ok) {
        toast.success(commission ? "Commission updated" : "Commission allocated");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={commission ? "Edit commission" : "Allocate commission"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {commission ? "Save" : "Allocate"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Recipient" required>
          <Select
            value={form.user_id}
            onChange={(e) => set("user_id", e.target.value)}
          >
            <option value="">Select a team member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.username}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.amount || ""}
              onChange={(e) => set("amount", Number(e.target.value))}
            />
          </Field>
          <Field label="Percentage" hint="Optional">
            <Input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={form.percentage ?? ""}
              onChange={(e) =>
                set("percentage", e.target.value ? Number(e.target.value) : null)
              }
            />
          </Field>
        </div>
        <Field label="Status">
          <Select
            value={form.status ?? "pending"}
            onChange={(e) => set("status", e.target.value as CommissionStatus)}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="paid">Paid</option>
          </Select>
        </Field>
        <Field label="Note">
          <Textarea
            rows={2}
            value={form.note ?? ""}
            onChange={(e) => set("note", e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
