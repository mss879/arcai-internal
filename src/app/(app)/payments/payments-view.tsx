"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Check,
  Clock,
  FolderKanban,
  MoreVertical,
  Plus,
  Search,
  Trash2,
  Wallet,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn, formatCurrency } from "@/lib/utils";
import type { CompanyPayment, MemberLite } from "@/lib/types";

import {
  createCompanyPayment,
  deleteCompanyPayment,
  toggleCompanyPaymentPaid,
} from "./actions";
import { ProjectDebtsTable } from "./project-debts";
import {
  buildProjectMoney,
  sumBalance,
  sumReceived,
  type PaymentsProject,
  type ProjectMoney,
} from "./project-money";

/** The bare project columns a board row carries on its own join. */
type BoardRowProject = {
  id: string;
  name: string;
};

type PaymentWithCreator = CompanyPayment & {
  creator?: Pick<MemberLite, "full_name" | "username" | "avatar_url"> | null;
  project?: BoardRowProject | null;
};

type Tab = "projects" | "board";

export function PaymentsView({
  payments,
  projects = [],
}: {
  payments: PaymentWithCreator[];
  projects?: PaymentsProject[];
}) {
  // Both halves of this page move: `projects` and `payments` carry the project
  // truth, `company_payments` is the board. The Projects board subscribes to
  // exactly these three — the two screens now refresh together.
  useRealtimeSyncTables(["projects", "payments", "company_payments"]);

  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("projects");
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  // Bumped on every open so the form remounts with fresh state — cheaper and
  // quieter than resetting four fields from an effect.
  const [formKey, setFormKey] = React.useState(0);
  const [toDelete, setToDelete] = React.useState<CompanyPayment | null>(null);
  const [boardTab, setBoardTab] = React.useState<"pending" | "upcoming">(
    "pending",
  );

  const openForm = React.useCallback(() => {
    setFormKey((k) => k + 1);
    setCreating(true);
  }, []);

  // The single source of project money on this page. Every received, balance
  // and paid-% below reads out of this map, and the map is built entirely from
  // settledAmount() / balanceDue() / paidPercent() / buildLedger().
  const moneyByProject = React.useMemo(
    () => buildProjectMoney(projects),
    [projects],
  );

  const owed = React.useMemo(
    () =>
      [...moneyByProject.values()].filter((m) => m.balance > 0),
    [moneyByProject],
  );

  const liveOwed = owed.filter((m) => m.live);
  const closedOwed = owed.filter((m) => !m.live);
  const liveOutstanding = sumBalance(liveOwed);
  const closedOutstanding = sumBalance(closedOwed);
  const receivedOnProjects = sumReceived([...moneyByProject.values()]);

  // Board money. `status` says WHEN it is expected (pending = due now,
  // upcoming = later); `is_paid` is the only settled flag — a row can be
  // upcoming AND paid, so the two are counted independently.
  const boardPending = sumPrice(
    payments.filter((p) => p.status === "pending" && !p.is_paid),
  );
  const boardUpcoming = sumPrice(
    payments.filter((p) => p.status === "upcoming" && !p.is_paid),
  );
  const boardUnpaid = boardPending + boardUpcoming;
  const boardPaid = sumPrice(payments.filter((p) => p.is_paid));

  const q = query.trim().toLowerCase();

  const owedFiltered = React.useMemo(() => {
    if (!q) return owed;
    return owed.filter(
      (m) =>
        m.project.name.toLowerCase().includes(q) ||
        (m.clientName ?? "").toLowerCase().includes(q) ||
        (m.project.client?.company ?? "").toLowerCase().includes(q),
    );
  }, [owed, q]);

  const boardFiltered = payments.filter((p) => {
    const matchesTab = p.status === boardTab;
    const matchesQuery =
      !q ||
      p.company_name.toLowerCase().includes(q) ||
      (p.project?.name ?? "").toLowerCase().includes(q);
    return matchesTab && matchesQuery;
  });

  const pendingCount = payments.filter((p) => p.status === "pending").length;
  const upcomingCount = payments.filter((p) => p.status === "upcoming").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="What clients owe, read straight from Projects — plus the board for money with no project behind it. All figures in Sri Lankan Rupees (LKR)."
        actions={
          <Button onClick={openForm}>
            <Plus className="h-4 w-4" /> Record payment
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Wallet className="h-6 w-6" />}
          tone="amber"
          label="Owed on live projects"
          value={formatCurrency(liveOutstanding)}
          caption={
            closedOutstanding > 0
              ? `${liveOwed.length} live project${liveOwed.length === 1 ? "" : "s"} · a further ${formatCurrency(closedOutstanding)} sits on completed or cancelled work`
              : `Across ${liveOwed.length} live project${liveOwed.length === 1 ? "" : "s"}`
          }
        />
        <StatTile
          icon={<Check className="h-6 w-6" />}
          tone="emerald"
          label="Received on projects"
          value={formatCurrency(receivedOnProjects)}
          caption="Deposits, project payments and linked board rows — each counted once."
        />
        <StatTile
          icon={<Clock className="h-6 w-6" />}
          tone="indigo"
          label="Board: due now"
          value={formatCurrency(boardPending)}
          caption="Unpaid “Pending” rows typed on the board below."
        />
        <StatTile
          icon={<CalendarClock className="h-6 w-6" />}
          tone="primary"
          label="Board: expected later"
          value={formatCurrency(boardUpcoming)}
          caption="Unpaid “Upcoming” rows — expected, not yet due. Never bill from this."
        />
      </div>

      {/* The two ledgers overlap on purpose, and the overlap is the trap this
          page used to fall into. Say it once, in plain words, above both. */}
      <p className="rounded-xl border border-slate-200/80 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
        <span className="font-semibold text-slate-700">
          These are two different ledgers.
        </span>{" "}
        The project figures come from each project&rsquo;s own record — its
        deposit, its payment rows and any board payment linked to it,
        reconciled so nothing is counted twice. The board figures are the
        hand-typed rows below. A board row that is linked to a project is
        already inside that project&rsquo;s received total, so adding the
        project number and the board number together double-counts it.
      </p>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex shrink-0 self-start rounded-xl border border-slate-200 bg-white p-1">
          <TabButton
            active={tab === "projects"}
            onClick={() => setTab("projects")}
            count={owed.length}
          >
            Owed on projects
          </TabButton>
          <TabButton
            active={tab === "board"}
            onClick={() => setTab("board")}
            count={payments.length}
          >
            Payments board
          </TabButton>
        </div>

        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "projects"
                ? "Search by client or project…"
                : "Search by company or project…"
            }
            className="pl-9"
          />
        </div>
      </div>

      {tab === "projects" ? (
        q && owedFiltered.length === 0 ? (
          <EmptyState
            icon={<Search className="h-6 w-6" />}
            title="No matching project"
            description="Try a different search term, or switch to the Payments board for money with no project behind it."
          />
        ) : (
          <ProjectDebtsTable rows={owedFiltered} />
        )
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-slate-200/80 bg-white px-4 py-3 text-xs text-slate-500 shadow-[var(--shadow-card)]">
            <span>
              Unpaid on this board{" "}
              <strong className="font-semibold text-slate-800 tabular-nums">
                {formatCurrency(boardUnpaid)}
              </strong>
            </span>
            <span className="text-slate-300">·</span>
            <span>
              Pending{" "}
              <strong className="font-semibold text-amber-600 tabular-nums">
                {formatCurrency(boardPending)}
              </strong>
            </span>
            <span className="text-slate-300">·</span>
            <span>
              Upcoming{" "}
              <strong className="font-semibold text-primary-600 tabular-nums">
                {formatCurrency(boardUpcoming)}
              </strong>
            </span>
            <span className="text-slate-300">·</span>
            <span>
              Marked paid{" "}
              <strong className="font-semibold text-emerald-600 tabular-nums">
                {formatCurrency(boardPaid)}
              </strong>
            </span>
          </div>

          <div className="inline-flex shrink-0 rounded-xl border border-slate-200 bg-white p-1">
            <TabButton
              active={boardTab === "pending"}
              onClick={() => setBoardTab("pending")}
              count={pendingCount}
            >
              Pending
            </TabButton>
            <TabButton
              active={boardTab === "upcoming"}
              onClick={() => setBoardTab("upcoming")}
              count={upcomingCount}
            >
              Upcoming
            </TabButton>
          </div>

          {boardFiltered.length === 0 ? (
            <EmptyState
              icon={
                boardTab === "pending" ? (
                  <Clock className="h-6 w-6" />
                ) : (
                  <Building2 className="h-6 w-6" />
                )
              }
              title={
                query
                  ? "No matching payments"
                  : boardTab === "pending"
                    ? "No pending payments yet"
                    : "No upcoming payments yet"
              }
              description={
                query
                  ? "Try a different search term."
                  : boardTab === "pending"
                    ? "Record your first pending company payment to get started."
                    : "Record your first upcoming company payment to get started."
              }
              action={
                !query && (
                  <Button onClick={openForm}>
                    <Plus className="h-4 w-4" /> Record payment
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-3.5 font-semibold">Company name</th>
                      <th className="px-5 py-3.5 font-semibold">Price (LKR)</th>
                      <th className="px-5 py-3.5 font-semibold">
                        Project / Balance left
                      </th>
                      <th className="px-5 py-3.5 font-semibold">Recorded by</th>
                      <th className="px-5 py-3.5 font-semibold">Date</th>
                      <th className="px-5 py-3.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {boardFiltered.map((p) => (
                      <BoardRow
                        key={p.id}
                        payment={p}
                        money={
                          p.project_id
                            ? (moneyByProject.get(p.project_id) ?? null)
                            : null
                        }
                        onToggled={() => router.refresh()}
                        onDelete={() => setToDelete(p)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <PaymentFormModal
        key={formKey}
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => router.refresh()}
        projects={projects}
        moneyByProject={moneyByProject}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete payment record"
        description={`Remove the payment of ${toDelete ? formatCurrency(Number(toDelete.price_lkr)) : ""} for ${toDelete?.company_name}? This cannot be undone.`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteCompanyPayment(toDelete.id);
          if (res.ok) {
            toast.success("Payment record deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
          setToDelete(null);
        }}
      />
    </div>
  );
}

function sumPrice(rows: { price_lkr: number | string }[]): number {
  return rows.reduce((sum, r) => sum + Number(r.price_lkr), 0);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const TILE_TONES = {
  amber: "bg-amber-50 text-amber-600",
  emerald: "bg-emerald-50 text-emerald-600",
  indigo: "bg-indigo-50 text-indigo-600",
  primary: "bg-primary-50 text-primary-600",
} as const;

function StatTile({
  icon,
  tone,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TILE_TONES;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-4">
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl",
            TILE_TONES[tone],
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-400">{label}</p>
          <h3 className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
            {value}
          </h3>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {caption}
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition",
        active
          ? "bg-primary-600 text-white shadow-sm"
          : "text-slate-500 hover:text-slate-800",
      )}
    >
      {children}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-xs font-semibold",
          active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-600",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function BoardRow({
  payment: p,
  money,
  onToggled,
  onDelete,
}: {
  payment: PaymentWithCreator;
  /** The linked project's money, or null when standalone or archived. */
  money: ProjectMoney | null;
  onToggled: () => void;
  onDelete: () => void;
}) {
  // buildLedger() gives a board row the company_payments id, so the very same
  // duplicate flag the project page shows lights up here.
  const isDuplicate = money?.duplicateRowIds.has(p.id) ?? false;

  return (
    <tr className="group hover:bg-slate-50/60">
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              const res = await toggleCompanyPaymentPaid(p.id, !p.is_paid);
              if (res.ok) {
                toast.success(
                  `Payment marked as ${!p.is_paid ? "Paid" : "Unpaid"}`,
                );
                onToggled();
              } else {
                toast.error(res.error);
              }
            }}
            className={cn(
              "grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md border-2 transition",
              p.is_paid
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-slate-300 text-transparent hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-500",
            )}
            aria-label="Toggle status"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </button>

          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
              p.is_paid
                ? "bg-emerald-50 text-emerald-600"
                : p.status === "pending"
                  ? "bg-amber-50 text-amber-600"
                  : "bg-primary-50 text-primary-600",
            )}
          >
            <Building2 className="h-4 w-4" />
          </span>
          <span className="font-medium text-slate-900">{p.company_name}</span>
        </div>
      </td>

      <td className="px-5 py-3.5 font-semibold tabular-nums text-slate-900">
        {formatCurrency(Number(p.price_lkr))}
      </td>

      <td className="px-5 py-3.5">
        {p.project_id && p.project ? (
          <div className="min-w-0">
            <Link
              href={`/projects/${p.project.id}`}
              className="flex items-center gap-1.5 truncate font-medium text-primary-700 hover:underline"
            >
              <FolderKanban className="h-3.5 w-3.5 shrink-0" />
              {p.project.name}
            </Link>
            {money ? (
              <p
                className={cn(
                  "mt-0.5 text-xs font-semibold tabular-nums",
                  money.balance > 0 ? "text-amber-600" : "text-emerald-600",
                )}
              >
                {money.balance > 0
                  ? `${formatCurrency(money.balance, money.currency)} left`
                  : "Fully paid"}
              </p>
            ) : (
              // The row's own join ignores deleted_at, so an archived project
              // still names itself here. It has no balance on this page —
              // saying "Fully paid" would be a lie.
              <p className="mt-0.5 text-xs text-slate-400">
                Archived project — balance shown on the project itself
              </p>
            )}
            {isDuplicate && (
              <span
                className="mt-1 inline-flex items-center gap-1 rounded-lg bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                title="The project's own ledger has a payment of the same amount within three days of this row. One of the two is probably a double entry."
              >
                <AlertTriangle className="h-3 w-3" />
                Possible double entry
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-300">Not linked to a project</span>
        )}
      </td>

      <td className="px-5 py-3.5">
        {p.creator ? (
          <div className="flex items-center gap-2">
            <Avatar
              name={p.creator.full_name}
              src={p.creator.avatar_url}
              size="xs"
            />
            <span className="text-xs text-slate-600">
              {p.creator.full_name}
            </span>
          </div>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>

      <td className="px-5 py-3.5 text-slate-500">
        {new Date(p.created_at).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}
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
            destructive
            icon={<Trash2 className="h-4 w-4" />}
            onClick={onDelete}
          >
            Delete
          </DropdownItem>
        </Dropdown>
      </td>
    </tr>
  );
}

function PaymentFormModal({
  open,
  onClose,
  onSaved,
  projects,
  moneyByProject,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  projects: PaymentsProject[];
  moneyByProject: Map<string, ProjectMoney>;
}) {
  const [pending, startTransition] = React.useTransition();
  const [companyName, setCompanyName] = React.useState("");
  const [priceLkr, setPriceLkr] = React.useState("");
  const [status, setStatus] = React.useState<"pending" | "upcoming">("pending");
  const [projectId, setProjectId] = React.useState("");

  const selected = projectId ? (moneyByProject.get(projectId) ?? null) : null;

  function submit() {
    if (!companyName.trim()) {
      toast.error("Please enter a company name.");
      return;
    }
    const parsedPrice = parseFloat(priceLkr);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      toast.error("Please enter a valid positive price.");
      return;
    }

    startTransition(async () => {
      const res = await createCompanyPayment({
        company_name: companyName,
        price_lkr: parsedPrice,
        status,
        project_id: projectId || null,
      });
      if (res.ok) {
        toast.success("Payment recorded successfully");
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
      title="Record payment"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Project"
          hint="Link this payment to the project it settles — that's what keeps the project balance exact."
        >
          <Select
            value={projectId}
            onChange={(e) => {
              const id = e.target.value;
              setProjectId(id);
              // Borrow the project's name so the row still reads well in the
              // list, and offer balanceDue() as the obvious amount — the same
              // figure the project page shows.
              const money = moneyByProject.get(id);
              if (money) {
                if (!companyName.trim()) setCompanyName(money.project.name);
                if (!priceLkr.trim() && money.balance > 0) {
                  setPriceLkr(String(money.balance));
                }
              }
            }}
          >
            <option value="">No project (standalone payment)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        {selected && (
          <div className="rounded-xl border border-slate-200/80 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Balance left on this project
                </p>
                <p className="text-[11px] text-slate-400">
                  {formatCurrency(selected.received, selected.currency)}{" "}
                  received of{" "}
                  {formatCurrency(selected.totalValue, selected.currency)} —
                  the same figure the project page shows
                </p>
              </div>
              <p
                className={cn(
                  "text-base font-extrabold tabular-nums",
                  selected.balance > 0 ? "text-amber-600" : "text-emerald-600",
                )}
              >
                {formatCurrency(selected.balance, selected.currency)}
              </p>
            </div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-200/70">
              <div
                className={cn(
                  "h-full rounded-full",
                  selected.percent >= 100 ? "bg-emerald-500" : "bg-primary-500",
                )}
                style={{ width: `${selected.percent}%` }}
              />
            </div>
          </div>
        )}

        <Field label="Company name" required>
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Enter company name"
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Price (LKR)" required hint="Rupees (Rs.)">
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                Rs.
              </span>
              <Input
                type="number"
                min="0"
                step="any"
                value={priceLkr}
                onChange={(e) => setPriceLkr(e.target.value)}
                placeholder="0.00"
                className="pl-10"
              />
            </div>
          </Field>

          <Field label="Status" required hint="When the money is expected">
            <Select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as "pending" | "upcoming")
              }
            >
              <option value="pending">Pending (due now)</option>
              <option value="upcoming">Upcoming (due later)</option>
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
