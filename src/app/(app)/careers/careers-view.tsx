"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Briefcase,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Users,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type { ApplicationStage, CareerApplication, CareerVacancy } from "@/lib/types";

import {
  createVacancy,
  deleteVacancy,
  publish,
  rateApplication,
  saveApplicationNotes,
  setApplicationStage,
  syncNow,
  unpublish,
  updateVacancy,
} from "./actions";

const STAGES: { key: ApplicationStage; label: string; tone: string }[] = [
  { key: "new", label: "New", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  { key: "screening", label: "Screening", tone: "bg-amber-50 text-amber-700 ring-amber-200" },
  { key: "interview", label: "Interview", tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  { key: "offer", label: "Offer", tone: "bg-primary-50 text-primary-700 ring-primary-200" },
  { key: "hired", label: "Hired", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  { key: "rejected", label: "Rejected", tone: "bg-rose-50 text-rose-700 ring-rose-200" },
  { key: "withdrawn", label: "Withdrawn", tone: "bg-slate-100 text-slate-600 ring-slate-200" },
];

const stageMeta = (stage: string) =>
  STAGES.find((s) => s.key === stage) ?? STAGES[STAGES.length - 1];

const EMPLOYMENT_TYPES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Freelance",
  "Remote",
];

type Tab = "applications" | "vacancies";

/**
 * Careers.
 *
 * Two halves of one job. Vacancies are written here and published to the
 * website, so the careers page is edited in the workspace rather than in a
 * database console. Applications come the other way and land in a pipeline
 * the website has no concept of — stage, rating, notes, who is reviewing.
 */
export function CareersView({
  vacancies,
  applications,
  lastSyncAt,
  syncError,
  careersUrl,
  sourceReady,
}: {
  vacancies: CareerVacancy[];
  applications: CareerApplication[];
  lastSyncAt: string | null;
  syncError: string | null;
  careersUrl: string;
  sourceReady: boolean;
}) {
  useRealtimeSync("careers_applications");
  const router = useRouter();

  const [tab, setTab] = React.useState<Tab>("applications");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [stageFilter, setStageFilter] = React.useState<ApplicationStage | "all">("all");
  const [vacancyFilter, setVacancyFilter] = React.useState<string>("all");
  const [openApplication, setOpenApplication] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<CareerVacancy | "new" | null>(null);

  const run = async (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    message: string,
  ) => {
    setBusy(key);
    try {
      const result = await fn();
      if (!result.ok) {
        toast.error(result.error ?? "That did not work.");
        return false;
      }
      toast.success(message);
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  };

  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of applications) out[a.stage] = (out[a.stage] ?? 0) + 1;
    return out;
  }, [applications]);

  const filtered = applications.filter(
    (a) =>
      (stageFilter === "all" || a.stage === stageFilter) &&
      (vacancyFilter === "all" || a.vacancy_id === vacancyFilter),
  );

  const liveCount = vacancies.filter((v) => v.status === "published").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Careers"
        description="Write a role here and it goes live on the website. Every application comes back into this pipeline."
        actions={
          <div className="flex flex-wrap gap-2">
            <a
              href={careersUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              <ExternalLink className="h-4 w-4" /> View careers page
            </a>
            <Button
              variant="secondary"
              loading={busy === "sync"}
              onClick={() =>
                run("sync", syncNow, "Pulled the latest from the website.")
              }
            >
              <RefreshCw className="h-4 w-4" /> Sync now
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> New role
            </Button>
          </div>
        }
      />

      {!sourceReady && (
        <Alert variant="error">
          <strong>The website connection is not configured.</strong> Add{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">
            WEBSITE_SUPABASE_URL
          </code>{" "}
          and{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">
            WEBSITE_SUPABASE_SERVICE_ROLE_KEY
          </code>
          . Roles can still be drafted here, but nothing can be published and no
          applications will arrive.
        </Alert>
      )}

      {syncError && (
        <Alert variant="error">
          <strong>The last sync had a problem.</strong> {syncError}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setTab("applications")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
              tab === "applications"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-50",
            )}
          >
            <Users className="h-4 w-4" /> Applications ({applications.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("vacancies")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
              tab === "vacancies"
                ? "bg-primary-500 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-50",
            )}
          >
            <Briefcase className="h-4 w-4" /> Roles ({liveCount} live)
          </button>
        </div>
        {lastSyncAt && (
          <span className="text-xs text-slate-400">
            Last pulled {formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}
          </span>
        )}
      </div>

      {tab === "applications" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip
              active={stageFilter === "all"}
              onClick={() => setStageFilter("all")}
              label={`All (${applications.length})`}
            />
            {STAGES.map((s) => (
              <FilterChip
                key={s.key}
                active={stageFilter === s.key}
                onClick={() => setStageFilter(s.key)}
                label={`${s.label} (${counts[s.key] ?? 0})`}
              />
            ))}
            {vacancies.length > 0 && (
              <Select
                value={vacancyFilter}
                onChange={(e) => setVacancyFilter(e.target.value)}
                className="ml-auto w-auto"
              >
                <option value="all">Every role</option>
                {vacancies.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title={
                applications.length === 0
                  ? "No applications yet"
                  : "Nothing matches that filter"
              }
              description={
                applications.length === 0
                  ? "Applications submitted on the website are pulled in every 15 minutes. Use Sync now to check immediately."
                  : "Try a different stage or role."
              }
            />
          ) : (
            <div className="space-y-2">
              {filtered.map((app) => (
                <ApplicationRow
                  key={app.id}
                  app={app}
                  open={openApplication === app.id}
                  onToggle={() =>
                    setOpenApplication(openApplication === app.id ? null : app.id)
                  }
                  busy={busy}
                  run={run}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "vacancies" && (
        <div className="space-y-3">
          {vacancies.length === 0 ? (
            <EmptyState
              icon={<Briefcase className="h-6 w-6" />}
              title="No roles yet"
              description="Write one here and publish it — it appears on the website's careers page immediately."
              action={
                <Button onClick={() => setEditing("new")}>
                  <Plus className="h-4 w-4" /> New role
                </Button>
              }
            />
          ) : (
            vacancies.map((v) => {
              const applicantCount = applications.filter((a) => a.vacancy_id === v.id).length;
              return (
                <div
                  key={v.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">{v.title}</h3>
                        <StatusBadge status={v.status} />
                        <Badge>{v.employment_type}</Badge>
                        {v.department && <Badge>{v.department}</Badge>}
                        {v.location && <Badge>{v.location}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        {applicantCount} application{applicantCount === 1 ? "" : "s"}
                        {v.headcount > 1 && ` · ${v.headcount} openings`}
                        {v.salary_range && ` · ${v.salary_range}`}
                        {v.closes_on && ` · closes ${v.closes_on}`}
                        {v.published_at &&
                          ` · live since ${format(new Date(v.published_at), "d MMM yyyy")}`}
                      </p>
                      {v.sync_error && (
                        <p className="mt-1 text-xs text-rose-600">
                          Last publish failed: {v.sync_error}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(v)}
                        aria-label="Edit role"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {v.status === "published" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={busy === `unpub-${v.id}`}
                          onClick={() =>
                            run(
                              `unpub-${v.id}`,
                              () => unpublish(v.id),
                              "Taken off the website.",
                            )
                          }
                        >
                          <EyeOff className="h-4 w-4" /> Take down
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          loading={busy === `pub-${v.id}`}
                          disabled={!sourceReady}
                          onClick={() =>
                            run(`pub-${v.id}`, () => publish(v.id), "Live on the website.")
                          }
                        >
                          <Eye className="h-4 w-4" /> Publish
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === `del-${v.id}`}
                        onClick={() =>
                          run(`del-${v.id}`, () => deleteVacancy(v.id), "Role deleted.")
                        }
                        aria-label="Delete role"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {v.description && (
                    <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">
                      {v.description}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {editing && (
        <VacancyModal
          vacancy={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-sm font-medium transition",
        active
          ? "bg-primary-500 text-white"
          : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
      )}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "published"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : status === "failed"
        ? "bg-rose-50 text-rose-700 ring-rose-200"
        : status === "archived"
          ? "bg-slate-100 text-slate-600 ring-slate-200"
          : "bg-amber-50 text-amber-700 ring-amber-200";
  const label = status === "published" ? "live on site" : status;
  return <Badge className={cn("ring-1", tone)}>{label}</Badge>;
}

function ApplicationRow({
  app,
  open,
  onToggle,
  busy,
  run,
}: {
  app: CareerApplication;
  open: boolean;
  onToggle: () => void;
  busy: string | null;
  run: (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    message: string,
  ) => Promise<boolean>;
}) {
  const [notes, setNotes] = React.useState(app.notes ?? "");
  const meta = stageMeta(app.stage);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{app.name || "(no name)"}</span>
            <Badge className={cn("ring-1", meta.tone)}>{meta.label}</Badge>
            <Badge>{app.vacancy_title}</Badge>
            {app.rating && (
              <span className="inline-flex items-center gap-0.5 text-xs text-amber-500">
                {Array.from({ length: app.rating }).map((_, i) => (
                  <Star key={i} className="h-3 w-3 fill-current" />
                ))}
              </span>
            )}
            {app.currently_employed && <Badge>currently employed</Badge>}
          </div>
          <p className="mt-1 truncate text-xs text-slate-400">
            {app.email}
            {app.phone && ` · ${app.phone}`}
            {app.earliest_start_date && ` · can start ${app.earliest_start_date}`}
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-400">
          {formatDistanceToNow(new Date(app.applied_at), { addSuffix: true })}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-slate-100 p-4">
          <div className="flex flex-wrap gap-2">
            {app.cv_url && (
              <a
                href={app.cv_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                <FileText className="h-4 w-4" /> Open CV
              </a>
            )}
            <a
              href={`mailto:${app.email}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              <Mail className="h-4 w-4" /> Email
            </a>
            {app.phone && (
              <a
                href={`tel:${app.phone}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                <Phone className="h-4 w-4" /> Call
              </a>
            )}
          </div>

          {app.personal_statement && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                Personal statement
              </p>
              <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
                {app.personal_statement}
              </p>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              Move to
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  disabled={busy === `stage-${app.id}` || s.key === app.stage}
                  onClick={() =>
                    run(
                      `stage-${app.id}`,
                      () => setApplicationStage(app.id, s.key),
                      `Moved to ${s.label}.`,
                    )
                  }
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium ring-1 transition disabled:opacity-40",
                    s.key === app.stage
                      ? s.tone
                      : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              Rating
            </p>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={`Rate ${n} out of 5`}
                  onClick={() =>
                    run(
                      `rate-${app.id}`,
                      () => rateApplication(app.id, app.rating === n ? null : n),
                      "Rating saved.",
                    )
                  }
                  className="text-amber-400 hover:scale-110"
                >
                  <Star
                    className={cn(
                      "h-5 w-5",
                      app.rating && n <= app.rating ? "fill-current" : "opacity-30",
                    )}
                  />
                </button>
              ))}
            </div>
          </div>

          <Field label="Notes" hint="Only visible here — never shown to the candidate.">
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes !== (app.notes ?? "")) {
                  void run(
                    `notes-${app.id}`,
                    () => saveApplicationNotes(app.id, notes),
                    "Notes saved.",
                  );
                }
              }}
              placeholder="What stood out, what to ask them…"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function VacancyModal({
  vacancy,
  onClose,
  onSaved,
}: {
  vacancy: CareerVacancy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    title: vacancy?.title ?? "",
    department: vacancy?.department ?? "",
    location: vacancy?.location ?? "",
    employment_type: vacancy?.employment_type ?? "Full-time",
    description: vacancy?.description ?? "",
    requirements: vacancy?.requirements ?? "",
    salary_range: vacancy?.salary_range ?? "",
    headcount: String(vacancy?.headcount ?? 1),
    internal_notes: vacancy?.internal_notes ?? "",
    closes_on: vacancy?.closes_on ?? "",
  });
  const [saving, setSaving] = React.useState(false);

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    if (!form.title.trim()) {
      toast.error("Give the role a title.");
      return;
    }
    setSaving(true);
    try {
      const result = vacancy
        ? await updateVacancy(vacancy.id, form)
        : await createVacancy(form);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        vacancy
          ? "republished" in result && result.republished
            ? "Saved and updated on the website."
            : "Saved."
          : "Role created as a draft — publish it when you're ready.",
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={vacancy ? "Edit role" : "New role"}
      description={
        vacancy?.status === "published"
          ? "This role is live — saving updates the website straight away."
          : "Saved as a draft. Nothing reaches the website until you publish it."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={save}>
            {vacancy ? "Save" : "Create"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Job title" required>
          <Input
            value={form.title}
            onChange={set("title")}
            placeholder="AI Automation Engineer"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Department">
            <Input value={form.department} onChange={set("department")} placeholder="Engineering" />
          </Field>
          <Field label="Location">
            <Input value={form.location} onChange={set("location")} placeholder="Colombo / Remote" />
          </Field>
          <Field label="Type">
            <Select value={form.employment_type} onChange={set("employment_type")}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Openings">
            <Input type="number" min={1} max={99} value={form.headcount} onChange={set("headcount")} />
          </Field>
        </div>

        <Field label="Description" hint="Shown on the careers page.">
          <Textarea
            rows={6}
            value={form.description}
            onChange={set("description")}
            placeholder="What the role is, who they'll work with, what a good week looks like…"
          />
        </Field>

        <Field label="Requirements" hint="Shown on the careers page.">
          <Textarea
            rows={5}
            value={form.requirements}
            onChange={set("requirements")}
            placeholder="One per line."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Salary range" hint="Internal only — not published.">
            <Input value={form.salary_range} onChange={set("salary_range")} placeholder="LKR 250k–350k" />
          </Field>
          <Field label="Closes on" hint="Internal only — not published.">
            <Input type="date" value={form.closes_on} onChange={set("closes_on")} />
          </Field>
        </div>

        <Field label="Internal notes" hint="Never leaves the CRM.">
          <Textarea
            rows={2}
            value={form.internal_notes}
            onChange={set("internal_notes")}
            placeholder="Budget approved by…, replacing…, priority…"
          />
        </Field>
      </div>
    </Modal>
  );
}
