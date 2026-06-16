"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2,
  Mail,
  MapPin,
  MoreVertical,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { CLIENT_STATUS_META } from "@/lib/constants";
import type { Client, ClientStatus } from "@/lib/types";

import { deleteClient, saveClient, type ClientInput } from "./actions";

export function ClientsView({ clients }: { clients: Client[] }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<Client | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Client | null>(null);

  const filtered = clients.filter((c) => {
    const q = query.toLowerCase();
    return (
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.company?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.city?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description="Your shared client directory. Anyone on the team can add and edit."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add client
          </Button>
        }
      />

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients…"
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={query ? "No matching clients" : "No clients yet"}
          description={
            query
              ? "Try a different search term."
              : "Add your first client to get started."
          }
          action={
            !query && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Add client
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3.5 font-semibold">Client</th>
                <th className="px-5 py-3.5 font-semibold">Contact</th>
                <th className="hidden px-5 py-3.5 font-semibold md:table-cell">
                  Location
                </th>
                <th className="px-5 py-3.5 font-semibold">Status</th>
                <th className="px-5 py-3.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((c) => (
                <tr key={c.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Avatar name={c.name} size="sm" />
                      <div>
                        <p className="font-medium text-slate-900">{c.name}</p>
                        {c.company && (
                          <p className="flex items-center gap-1 text-xs text-slate-400">
                            <Building2 className="h-3 w-3" />
                            {c.company}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500">
                    <div className="space-y-0.5">
                      {c.email && (
                        <p className="flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-slate-400" />
                          {c.email}
                        </p>
                      )}
                      {c.phone && (
                        <p className="flex items-center gap-1.5">
                          <Phone className="h-3.5 w-3.5 text-slate-400" />
                          {c.phone}
                        </p>
                      )}
                      {!c.email && !c.phone && (
                        <span className="text-slate-300">—</span>
                      )}
                    </div>
                  </td>
                  <td className="hidden px-5 py-3.5 text-slate-500 md:table-cell">
                    {c.city ? (
                      <span className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-slate-400" />
                        {c.city}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge className={CLIENT_STATUS_META[c.status].badge}>
                      {CLIENT_STATUS_META[c.status].label}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Dropdown
                      trigger={
                        <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ClientFormModal
        open={creating || !!editing}
        client={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => router.refresh()}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete client"
        description={`Remove ${toDelete?.name}? This can't be undone.`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteClient(toDelete.id);
          if (res.ok) {
            toast.success("Client deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}

function ClientFormModal({
  open,
  client,
  onClose,
  onSaved,
}: {
  open: boolean;
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<ClientInput>({ name: "" });

  React.useEffect(() => {
    if (open) {
      setForm(
        client
          ? {
              id: client.id,
              name: client.name,
              company: client.company ?? "",
              email: client.email ?? "",
              phone: client.phone ?? "",
              city: client.city ?? "",
              status: client.status,
              notes: client.notes ?? "",
            }
          : { name: "", status: "active" },
      );
    }
  }, [open, client]);

  function set<K extends keyof ClientInput>(key: K, value: ClientInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    startTransition(async () => {
      const res = await saveClient(form);
      if (res.ok) {
        toast.success(client ? "Client updated" : "Client added");
        onSaved();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={client ? "Edit client" : "Add client"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {client ? "Save changes" : "Add client"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Acme Inc. / John Doe"
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company">
            <Input
              value={form.company ?? ""}
              onChange={(e) => set("company", e.target.value)}
            />
          </Field>
          <Field label="City">
            <Input
              value={form.city ?? ""}
              onChange={(e) => set("city", e.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email ?? ""}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={form.phone ?? ""}
              onChange={(e) => set("phone", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Status">
          <Select
            value={form.status ?? "active"}
            onChange={(e) => set("status", e.target.value as ClientStatus)}
          >
            <option value="active">Active</option>
            <option value="lead">Lead</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Anything worth remembering…"
          />
        </Field>
      </div>
    </Modal>
  );
}
