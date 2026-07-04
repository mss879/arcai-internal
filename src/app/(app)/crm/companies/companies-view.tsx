"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Building2, Globe, Mail, Phone, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { formatCurrency } from "@/lib/utils";
import type { Company } from "@/lib/types";

import { deleteCompany, saveCompany } from "../actions";

type LeadLite = {
  id: string;
  title: string;
  company_id: string | null;
  value: number | null;
  currency: string;
  status: string;
};

export function CompaniesView({
  companies,
  leads,
}: {
  companies: Company[];
  leads: LeadLite[];
}) {
  const [editing, setEditing] = React.useState<Company | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Company | null>(null);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteCompany(toDelete.id);
    if (res.ok) toast.success("Company removed (its leads stay, unlinked).");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/crm"
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Companies"
          description="Organizations your contacts and deals group under — B2B view of the CRM."
        />
        <span className="ml-auto">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New company
          </Button>
        </span>
      </div>

      {companies.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" />}
          title="No companies yet"
          description="Create organizations and link leads to them from the lead form — deals then roll up per company here."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Add a company
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {companies.map((company) => {
            const companyLeads = leads.filter((l) => l.company_id === company.id);
            const openValue = companyLeads
              .filter((l) => l.status === "open")
              .reduce((s, l) => s + Number(l.value ?? 0), 0);
            return (
              <div
                key={company.id}
                className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => setEditing(company)}
                    className="text-left text-sm font-semibold text-slate-900 hover:text-primary-600"
                  >
                    {company.name}
                  </button>
                  <button
                    onClick={() => setToDelete(company)}
                    className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                    aria-label="Delete company"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-slate-400">
                  {company.industry && <p>{company.industry}</p>}
                  {company.website && (
                    <p className="flex items-center gap-1">
                      <Globe className="h-3 w-3" /> {company.website}
                    </p>
                  )}
                  {company.email && (
                    <p className="flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {company.email}
                    </p>
                  )}
                  {company.phone && (
                    <p className="flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {company.phone}
                    </p>
                  )}
                </div>
                <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  {companyLeads.length} deal{companyLeads.length === 1 ? "" : "s"}
                  {openValue > 0 && (
                    <>
                      {" · "}
                      <strong className="text-slate-700">{formatCurrency(openValue)}</strong> open
                    </>
                  )}
                </div>
                {companyLeads.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {companyLeads.slice(0, 4).map((l) => (
                      <Link
                        key={l.id}
                        href={`/crm/lead/${l.id}`}
                        className="block truncate text-xs font-medium text-slate-600 hover:text-primary-600"
                      >
                        → {l.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CompanyModal
        open={creating || editing !== null}
        company={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title={`Delete ${toDelete?.name}?`}
        description="Leads linked to it are kept but unlinked."
      />
    </div>
  );
}

function CompanyModal({
  open,
  company,
  onClose,
}: {
  open: boolean;
  company: Company | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [city, setCity] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(company?.name ?? "");
    setWebsite(company?.website ?? "");
    setEmail(company?.email ?? "");
    setPhone(company?.phone ?? "");
    setCity(company?.city ?? "");
    setIndustry(company?.industry ?? "");
    setNotes(company?.notes ?? "");
  }, [open, company]);

  async function handleSave() {
    setSaving(true);
    const res = await saveCompany({
      id: company?.id,
      name,
      website,
      email,
      phone,
      city,
      industry,
      notes,
    });
    setSaving(false);
    if (res.ok) {
      toast.success(company ? "Company updated." : "Company added.");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={company ? "Edit company" : "New company"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!name.trim()}>
            {company ? "Save" : "Add company"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Website">
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} />
          </Field>
          <Field label="Industry">
            <Input value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
          </Field>
        </div>
        <Field label="City">
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
