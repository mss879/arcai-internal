"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  Download,
  ExternalLink,
  FileSignature,
  FileText,
  FolderKanban,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Phone,
  Receipt,
  Target,
  TrendingUp,
  Users,
  Wallet,
  AlertTriangle,
  MonitorSmartphone,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChainCard, type ChainLink } from "@/components/projects/chain-card";
import type { TimelineItem, TimelineKind } from "@/lib/client-timeline";
import {
  CLIENT_STATUS_META,
  DELIVERY_STAGE_META,
  PROJECT_STATUS_META,
} from "@/lib/constants";
import type { Client, ClientStatus, DeliveryStage, ProjectStatus } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { ClientFormModal } from "@/app/(app)/clients/clients-view";
import { ComposeEmailModal } from "@/components/email/compose-email-modal";
import { Input } from "@/components/ui/input";
import { firstNameOf } from "@/lib/email-templates";
import { toast } from "sonner";

import { sendStatementByWhatsApp } from "./actions";

/**
 * The client's page (0112) — every record about one client in one place.
 *
 * The server builds the view model; this only decides which tab is on
 * screen. Tabs are kept mounted so nothing re-fetches when you flip between
 * them, the same way the project page does it.
 */

export type ClientView = {
  client: {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
    status: ClientStatus;
    notes: string | null;
    createdAt: string;
    portalLastLoginAt: string | null;
    portalLoginCount: number;
  };
  isAdmin: boolean;
  baseUrl: string;
  summary: {
    projects: number;
    open: number;
    totalValue: number;
    received: number;
    balance: number;
    currency: string;
  };
  projects: {
    id: string;
    name: string;
    status: string;
    stage: string | null;
    dueDate: string | null;
    currency: string;
    totalValue: number;
    received: number;
    balance: number;
    progress: number;
    shareToken: string | null;
    portalPasscode: string | null;
    portalRevoked: boolean;
    portalLastSentAt: string | null;
    liveUrl: string | null;
    previewUrl: string | null;
    launchedAt: string | null;
    createdAt: string;
  }[];
  leads: {
    id: string;
    title: string;
    status: string;
    value: number | null;
    currency: string;
    createdAt: string;
    wonAt: string | null;
  }[];
  quotes: {
    id: string;
    number: string;
    title: string;
    total: number;
    currency: string;
    status: string;
    shareToken: string;
    createdAt: string;
    acceptedAt: string | null;
    invoiced: boolean;
  }[];
  proposals: {
    id: string;
    projectName: string;
    total: number;
    date: string;
    projectId: string | null;
  }[];
  invoices: {
    id: string;
    number: string;
    date: string;
    total: number;
    dueToday: number;
    amountPaid: number | null;
    stamp: string | null;
    shareToken: string | null;
    projectId: string | null;
    currency: string | null;
  }[];
  plans: {
    id: string;
    title: string;
    total: number;
    currency: string;
    status: string;
    projectId: string | null;
    installments: {
      id: string;
      seq: number;
      amount: number;
      dueDate: string;
      status: string;
      paidAt: string | null;
    }[];
  }[];
  meetings: {
    id: string;
    title: string;
    at: string;
    durationMinutes: number;
    locationType: string;
    location: string | null;
    meetingUrl: string | null;
  }[];
  bookings: {
    id: string;
    date: string;
    start: string;
    end: string;
    status: string;
    notes: string | null;
  }[];
  waContacts: {
    id: string;
    waId: string;
    displayName: string | null;
    lastMessageAt: string | null;
    doNotContact: boolean;
  }[];
  conversations: {
    id: string;
    channel: "whatsapp" | "sms";
    direction: "in" | "out";
    body: string;
    at: string;
    status: string;
    actor: string;
  }[];
  churn: {
    id: string;
    severity: string;
    reason: string;
    status: string;
    createdAt: string;
  }[];
  timeline: TimelineItem[];
  chain: ChainLink[];
  /** 0117 — the code they share, and who they have introduced. */
  referrals: {
    code: string | null;
    link: string | null;
    introduced: {
      id: string;
      status: string;
      leadTitle: string | null;
      createdAt: string;
      rewardNote: string | null;
    }[];
  };
  /** T4.6 — the statement link (0117). Null before the migration. */
  statement: { token: string | null };
};

type Tab = "overview" | "projects" | "money" | "conversations" | "meetings" | "timeline";

const TIMELINE_ICON: Record<TimelineKind, React.ReactNode> = {
  lead: <Target className="h-3.5 w-3.5" />,
  delivery: <FolderKanban className="h-3.5 w-3.5" />,
  sms: <MessageSquareText className="h-3.5 w-3.5" />,
  whatsapp: <MessageCircle className="h-3.5 w-3.5" />,
  quote: <FileText className="h-3.5 w-3.5" />,
  proposal: <FileSignature className="h-3.5 w-3.5" />,
  invoice: <Receipt className="h-3.5 w-3.5" />,
  payment: <Wallet className="h-3.5 w-3.5" />,
  meeting: <CalendarClock className="h-3.5 w-3.5" />,
  booking: <CalendarClock className="h-3.5 w-3.5" />,
  // 0115
  email: <Mail className="h-3.5 w-3.5" />,
  comment: <MonitorSmartphone className="h-3.5 w-3.5" />,
  change_request: <AlertTriangle className="h-3.5 w-3.5" />,
};

const TIMELINE_TONE: Record<TimelineKind, string> = {
  lead: "bg-sky-500",
  delivery: "bg-primary-500",
  sms: "bg-cyan-500",
  whatsapp: "bg-emerald-500",
  quote: "bg-violet-500",
  proposal: "bg-fuchsia-500",
  invoice: "bg-amber-500",
  payment: "bg-emerald-600",
  meeting: "bg-orange-400",
  booking: "bg-orange-400",
  email: "bg-amber-400",
  comment: "bg-violet-400",
  change_request: "bg-rose-500",
};

function when(iso: string | null | undefined, pattern = "d MMM yyyy"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format(d, pattern);
}

export function ClientDetail({ view }: { view: ClientView }) {
  useRealtimeSyncTables(["clients", "projects", "quotes", "invoices", "payments"]);
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const [emailOpen, setEmailOpen] = React.useState(false);

  const { client, summary } = view;
  const statusMeta = CLIENT_STATUS_META[client.status];
  const waId = view.waContacts[0]?.waId ?? null;
  const waHref = waId
    ? `https://wa.me/${waId}`
    : client.phone
      ? `https://wa.me/${client.phone.replace(/[^\d]/g, "")}`
      : null;

  // The Client row the edit modal expects: the view model plus the columns it
  // doesn't show, so a save can never blank a field it never had.
  const editRow: Client = {
    id: client.id,
    name: client.name,
    company: client.company,
    email: client.email,
    phone: client.phone,
    city: client.city,
    status: client.status,
    notes: client.notes,
    portal_last_login_at: client.portalLastLoginAt,
    portal_login_count: client.portalLoginCount,
    phone_norm: null,
    // 0117 — present on the row type; the edit form never touches them.
    statement_token: "",
    referral_code: null,
    created_by: null,
    created_at: client.createdAt,
  };

  const unread = view.conversations.length;
  const nextBooking = view.bookings.find((b) => b.status !== "cancelled");

  return (
    <div className="space-y-6">
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Clients
      </Link>

      {/* ---- Header ---- */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <Avatar name={client.name} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-slate-900">{client.name}</h1>
                <Badge className={statusMeta.badge}>{statusMeta.label}</Badge>
                {view.churn.some((c) => c.status === "open") && (
                  <Badge className="bg-rose-50 text-rose-600 ring-rose-200">Churn risk</Badge>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                {client.company && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="h-3.5 w-3.5 text-slate-400" /> {client.company}
                  </span>
                )}
                {client.city && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-slate-400" /> {client.city}
                  </span>
                )}
                {client.email && (
                  <a
                    href={`mailto:${client.email}`}
                    className="inline-flex items-center gap-1 hover:text-primary-700"
                  >
                    <Mail className="h-3.5 w-3.5 text-slate-400" /> {client.email}
                  </a>
                )}
                {client.phone && (
                  <a
                    href={`tel:${client.phone}`}
                    className="inline-flex items-center gap-1 hover:text-primary-700"
                  >
                    <Phone className="h-3.5 w-3.5 text-slate-400" /> {client.phone}
                  </a>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Client since {when(client.createdAt)}
                {client.portalLoginCount > 0
                  ? ` · used their portal ${client.portalLoginCount}× (last ${when(client.portalLastLoginAt)})`
                  : " · never logged in to their portal"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {waHref && (
              <a href={waHref} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm">
                  <MessageCircle className="h-3.5 w-3.5 text-emerald-600" /> WhatsApp
                </Button>
              </a>
            )}
            {client.phone && (
              <a href={`sms:${client.phone}`}>
                <Button variant="outline" size="sm">
                  <MessageSquareText className="h-3.5 w-3.5" /> SMS
                </Button>
              </a>
            )}
            {client.email && (
              <Button variant="outline" size="sm" onClick={() => setEmailOpen(true)}>
                <Mail className="h-3.5 w-3.5" /> Email
              </Button>
            )}
            <Link href={`/projects?new=1&client=${client.id}`}>
              <Button variant="outline" size="sm">
                <FolderKanban className="h-3.5 w-3.5" /> New project
              </Button>
            </Link>
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-right md:grid-cols-4">
          <Stat label="Projects" value={`${summary.open} open · ${summary.projects} total`} />
          <Stat label="Total value" value={formatCurrency(summary.totalValue, summary.currency)} />
          <Stat
            label="Received"
            value={formatCurrency(summary.received, summary.currency)}
            accent="emerald"
          />
          <Stat
            label="Balance due"
            value={formatCurrency(summary.balance, summary.currency)}
            accent={summary.balance > 0 ? "amber" : "emerald"}
          />
        </div>
      </div>

      {/* ---- Tabs ---- */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-max rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<LayoutDashboard className="h-4 w-4" />}>
            Overview
          </TabButton>
          <TabButton active={tab === "projects"} onClick={() => setTab("projects")} icon={<FolderKanban className="h-4 w-4" />} badge={view.projects.length || undefined}>
            Projects
          </TabButton>
          <TabButton active={tab === "money"} onClick={() => setTab("money")} icon={<TrendingUp className="h-4 w-4" />} badge={view.invoices.length + view.quotes.length || undefined}>
            Money
          </TabButton>
          <TabButton active={tab === "conversations"} onClick={() => setTab("conversations")} icon={<MessageCircle className="h-4 w-4" />} badge={unread || undefined}>
            Conversations
          </TabButton>
          <TabButton active={tab === "meetings"} onClick={() => setTab("meetings")} icon={<CalendarClock className="h-4 w-4" />} badge={view.meetings.length + view.bookings.length || undefined}>
            Meetings
          </TabButton>
          <TabButton active={tab === "timeline"} onClick={() => setTab("timeline")} icon={<History className="h-4 w-4" />}>
            Timeline
          </TabButton>
        </div>
      </div>

      <div className={tab === "overview" ? undefined : "hidden"}>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <ChainCard links={view.chain} currency={summary.currency} quoted={null} delivered={summary.totalValue} />
          </div>
          <div className="space-y-6">
            <ReferralsCard view={view} />
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
              <h2 className="text-sm font-semibold text-slate-900">What&apos;s next</h2>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                {view.projects.filter((p) => p.balance > 0).map((p) => (
                  <li key={`bal-${p.id}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">Balance on {p.name}</span>
                    <span className="shrink-0 font-semibold text-amber-600">{formatCurrency(p.balance, p.currency)}</span>
                  </li>
                ))}
                {view.quotes.filter((q) => ["sent", "viewed"].includes(q.status)).map((q) => (
                  <li key={`q-${q.id}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">Quote {q.number} awaiting their answer</span>
                    <span className="shrink-0 text-xs text-slate-400">{q.status}</span>
                  </li>
                ))}
                {nextBooking && (
                  <li className="flex items-center justify-between gap-2">
                    <span>Call booked</span>
                    <span className="shrink-0 text-xs text-slate-400">{nextBooking.date} {nextBooking.start}</span>
                  </li>
                )}
                {view.projects.filter((p) => p.balance > 0).length === 0 &&
                  view.quotes.filter((q) => ["sent", "viewed"].includes(q.status)).length === 0 &&
                  !nextBooking && <li className="text-slate-400">Nothing waiting on either side.</li>}
              </ul>
            </section>
            {client.notes && (
              <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
                <h2 className="text-sm font-semibold text-slate-900">Notes</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{client.notes}</p>
              </section>
            )}
            {view.churn.length > 0 && (
              <section className="rounded-2xl border border-rose-200/80 bg-rose-50/40 p-5 shadow-[var(--shadow-card)]">
                <h2 className="text-sm font-semibold text-rose-700">Churn signals</h2>
                <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
                  {view.churn.map((c) => (
                    <li key={c.id}>
                      <span className="font-medium capitalize">{c.severity}</span> · {c.reason}
                      <span className="ml-1 text-xs text-slate-400">({c.status}, {when(c.createdAt)})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </div>

      <div className={tab === "projects" ? undefined : "hidden"}>
        {view.projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban className="h-6 w-6" />}
            title="No projects yet"
            description="Start one from an accepted quote, a proposal, or the New project button above."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {view.projects.map((p) => (
              <ProjectCard key={p.id} project={p} baseUrl={view.baseUrl} />
            ))}
          </div>
        )}
      </div>

      <div className={tab === "money" ? undefined : "hidden"}>
        <MoneyTab view={view} />
      </div>

      <div className={tab === "conversations" ? undefined : "hidden"}>
        <ConversationsTab view={view} />
      </div>

      <div className={tab === "meetings" ? undefined : "hidden"}>
        <MeetingsTab view={view} />
      </div>

      <div className={tab === "timeline" ? undefined : "hidden"}>
        <TimelineTab items={view.timeline} />
      </div>

      <ComposeEmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        to={client.email ?? ""}
        links={{ clientId: client.id }}
        tokens={{
          name: firstNameOf(client.name),
          full_name: client.name,
          company: client.company ?? "",
          email: client.email ?? "",
          phone: client.phone ?? "",
        }}
        onSent={() => router.refresh()}
      />

      <ClientFormModal
        open={editOpen}
        client={editRow}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProjectCard({
  project: p,
  baseUrl,
}: {
  project: ClientView["projects"][number];
  baseUrl: string;
}) {
  const link = p.shareToken ? `${baseUrl}/public/project/${p.shareToken}` : null;
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/projects/${p.id}`} className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900 hover:text-primary-700">{p.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge className={PROJECT_STATUS_META[p.status as ProjectStatus]?.badge ?? ""}>
              {PROJECT_STATUS_META[p.status as ProjectStatus]?.label ?? p.status}
            </Badge>
            {p.stage && (
              <Badge className={DELIVERY_STAGE_META[p.stage as DeliveryStage]?.badge ?? ""}>
                {DELIVERY_STAGE_META[p.stage as DeliveryStage]?.label ?? p.stage}
              </Badge>
            )}
          </div>
        </Link>
        {(p.liveUrl || p.previewUrl) && (
          <a
            href={p.liveUrl ?? p.previewUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary-600 hover:underline"
          >
            {p.liveUrl ? "Live site" : "Preview"} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="mt-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn("h-full rounded-full", p.progress >= 100 ? "bg-emerald-500" : "bg-primary-500")}
            style={{ width: `${p.progress}%` }}
          />
        </div>
        <p className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
          <span>{p.progress}% built</span>
          <span>
            {formatCurrency(p.received, p.currency)} of {formatCurrency(p.totalValue, p.currency)}
            {p.balance > 0 && <span className="ml-1 font-semibold text-amber-600">· {formatCurrency(p.balance, p.currency)} due</span>}
          </span>
        </p>
      </div>

      {link && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5 text-primary-500" />
            {p.portalRevoked ? "Tracking link revoked" : p.portalLastSentAt ? `Tracking link sent ${when(p.portalLastSentAt)}` : "Tracking link not sent yet"}
            {p.portalPasscode && (
              <span className="inline-flex items-center gap-0.5 text-slate-400">
                <KeyRound className="h-3 w-3" /> {p.portalPasscode}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="font-medium text-primary-600 hover:underline"
              onClick={() => navigator.clipboard.writeText(link)}
            >
              Copy link
            </button>
            <Link href={`/projects/${p.id}?tab=client`} className="text-slate-400 hover:text-primary-600">
              Manage →
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}

function MoneyTab({ view }: { view: ClientView }) {
  const { quotes, invoices, plans } = view;
  return (
    <div className="space-y-6">
      <StatementCard view={view} />

      <Section title="Quotes" icon={<FileText className="h-4 w-4 text-violet-500" />} empty={quotes.length === 0 ? "No quotes for this client." : null}>
        <ul className="divide-y divide-slate-100">
          {quotes.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="font-semibold text-slate-800">{q.number}</span>
              <span className="text-slate-600">{q.title}</span>
              <Badge className="bg-slate-100 text-slate-600 ring-slate-200">{q.status}</Badge>
              {q.invoiced && <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">Invoiced</Badge>}
              <span className="ml-auto font-semibold tabular-nums text-slate-700">{formatCurrency(q.total, q.currency)}</span>
              <a href={`/q/${q.shareToken}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-primary-600" aria-label="Open public quote">
                <ExternalLink className="h-4 w-4" />
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Invoices" icon={<Receipt className="h-4 w-4 text-amber-500" />} empty={invoices.length === 0 ? "No invoices yet." : null}>
        <ul className="divide-y divide-slate-100">
          {invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="font-semibold text-slate-800">Invoice {i.number}</span>
              <span className="text-xs text-slate-400">{when(i.date)}</span>
              {i.stamp === "payment_received" ? (
                <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">Paid</Badge>
              ) : i.stamp === "deposit_paid" ? (
                <Badge className="bg-sky-50 text-sky-600 ring-sky-200">Deposit paid</Badge>
              ) : (
                <Badge className="bg-amber-50 text-amber-600 ring-amber-200">Due {formatCurrency(i.dueToday, i.currency ?? "LKR")}</Badge>
              )}
              {i.projectId && (
                <Link href={`/projects/${i.projectId}`} className="text-xs text-slate-400 hover:text-primary-600">
                  project →
                </Link>
              )}
              <span className="ml-auto font-semibold tabular-nums text-slate-700">{formatCurrency(i.total, i.currency ?? "LKR")}</span>
              {i.shareToken && (
                <a href={`/public/invoice/${i.shareToken}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-primary-600" aria-label="Open public invoice">
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Payment plans" icon={<Wallet className="h-4 w-4 text-emerald-500" />} empty={plans.length === 0 ? "No payment plans." : null}>
        <ul className="divide-y divide-slate-100">
          {plans.map((p) => (
            <li key={p.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold text-slate-800">{p.title}</span>
                <Badge className="bg-slate-100 text-slate-600 ring-slate-200">{p.status}</Badge>
                <span className="ml-auto font-semibold tabular-nums text-slate-700">{formatCurrency(p.total, p.currency)}</span>
              </div>
              {p.installments.length > 0 && (
                <ul className="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                  {p.installments.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
                      <span>#{i.seq} · due {when(i.dueDate)}</span>
                      <span className={cn("font-medium tabular-nums", i.status === "paid" ? "text-emerald-600" : "text-slate-700")}>
                        {formatCurrency(i.amount, p.currency)} {i.status === "paid" ? "✓" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/**
 * T4.6 — the client's statement of account.
 *
 * One document instead of a tab full of rows: every invoice and every
 * payment, per currency, with a running balance. Download is a plain link
 * to the authed PDF route; Email goes through the compose modal so it lands
 * in the log; WhatsApp sends the PDF itself while the window is open and the
 * link otherwise. The dates are optional — blank is the whole history.
 */
function StatementCard({ view }: { view: ClientView }) {
  const router = useRouter();
  const { client } = view;
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  const pdfHref = `/api/statements/${client.id}/pdf${suffix}`;
  const publicUrl =
    view.statement.token && view.baseUrl
      ? `${view.baseUrl}/public/statement/${view.statement.token}${suffix}`
      : null;
  const periodLabel = from || to ? `${from || "the beginning"} → ${to || "today"}` : "the whole history";

  async function whatsapp() {
    setSending(true);
    const res = await sendStatementByWhatsApp(client.id, { from: from || null, to: to || null });
    setSending(false);
    if (res.ok) {
      toast.success(res.channel === "whatsapp" ? "Sent on WhatsApp as a PDF." : "Their WhatsApp window is closed — the link went by SMS.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Section title="Statement of account" icon={<Receipt className="h-4 w-4 text-primary-600" />} empty={null}>
      <div className="space-y-3 px-5 py-4">
        <p className="text-xs text-slate-500">
          Every invoice and every payment on one page, with a running balance. Leave the dates blank for the full history.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-[11px] font-medium text-slate-500">
            From
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </label>
          <label className="space-y-1 text-[11px] font-medium text-slate-500">
            To
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </label>
          <a href={pdfHref} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm">
              <Download className="h-3.5 w-3.5" /> Download PDF
            </Button>
          </a>
          <Button variant="outline" size="sm" disabled={!client.email} onClick={() => setEmailOpen(true)} title={client.email ? undefined : "No email on their record"}>
            <Mail className="h-3.5 w-3.5" /> Email
          </Button>
          <Button variant="outline" size="sm" disabled={!client.phone || sending} loading={sending} onClick={whatsapp} title={client.phone ? undefined : "No phone on their record"}>
            <MessageCircle className="h-3.5 w-3.5 text-emerald-600" /> WhatsApp
          </Button>
          {publicUrl && <CopyButton value={publicUrl} label="Copy their link" />}
        </div>
        {publicUrl && (
          <p className="text-[11px] text-slate-400">
            Their link opens the statement for {periodLabel}, and is on their portal as well.
          </p>
        )}
      </div>

      <ComposeEmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        title="Email the statement"
        to={client.email ?? ""}
        subject={`Statement of account — ${client.name}`}
        body={`Hi ${firstNameOf(client.name)},\n\nPlease find your statement of account attached, covering ${periodLabel}. It lists every invoice we have raised and every payment we have received, with the balance as it stands today.\n\nIf anything on it looks different from your own records, reply to this email and we will go through it together.\n\nThank you,\nARC AI`}
        links={{ clientId: client.id }}
        attachStatement={{ clientId: client.id, from: from || null, to: to || null }}
        attachmentLabel="Statement of account attached as a PDF"
        tokens={{
          name: firstNameOf(client.name),
          full_name: client.name,
          company: client.company ?? "",
          email: client.email ?? "",
          phone: client.phone ?? "",
        }}
        onSent={() => router.refresh()}
      />
    </Section>
  );
}

/**
 * 0117 — what this client has brought us, and the link they can share.
 *
 * The code is minted the first time this card is rendered, so a client list
 * doesn't fill up with codes nobody will ever use. Nothing here decides what
 * a referrer is owed: that is a conversation, and winning a referred lead
 * raises a task for it rather than paying out a formula.
 */
function ReferralsCard({ view }: { view: ClientView }) {
  const { code, link, introduced } = view.referrals;
  if (!code) return null;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-slate-900">Referrals</h2>
      <p className="mt-1 text-xs text-slate-500">
        {introduced.length === 0
          ? "They haven't introduced anyone yet."
          : `${introduced.length} introduction${introduced.length === 1 ? "" : "s"} so far.`}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <span className="rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700">
          {code}
        </span>
        {link && <CopyButton value={link} label="Copy their link" />}
      </div>

      {introduced.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {introduced.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-slate-600">
                {r.leadTitle ?? "An introduction"}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  r.status === "rewarded"
                    ? "bg-emerald-50 text-emerald-700"
                    : r.status === "won"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-slate-100 text-slate-500",
                )}
              >
                {r.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConversationsTab({ view }: { view: ClientView }) {
  // Email and portal messages are already in the timeline (0115), so they are
  // read back from it rather than queried a second time here.
  const emails = view.timeline.filter((i) => i.kind === "email");
  const portal = view.timeline.filter(
    (i) => i.kind === "comment" || i.kind === "change_request",
  );

  if (view.conversations.length === 0 && emails.length === 0 && portal.length === 0) {
    return (
      <EmptyState
        icon={<MessageCircle className="h-6 w-6" />}
        title="No messages yet"
        description="WhatsApp, texts, portal messages and email with this client all show here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {view.conversations.length > 0 && <ChatThread view={view} />}
      {emails.length > 0 && (
        <ReadOnlyMessages
          title="Email"
          hint="Sent from the CRM. Write another from the header, or reply in the inbox."
          items={emails}
        />
      )}
      {portal.length > 0 && (
        <ReadOnlyMessages
          title="Portal"
          hint="What the client wrote on their project page. Reply in the inbox."
          items={portal}
        />
      )}
    </div>
  );
}

/**
 * Email and portal history, read-only.
 *
 * Deliberately not a composer: a reply belongs in one place — /inbox — where
 * the thread has an owner and a channel. Two places to answer from is how two
 * people answer the same message.
 */
function ReadOnlyMessages({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: TimelineItem[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-400">{hint}</p>
      </div>
      <ol className="space-y-2">
        {items.slice(0, 20).map((i) => (
          <li
            key={i.id}
            className={cn(
              "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
              i.actor === "client"
                ? "mr-auto bg-slate-100 text-slate-800"
                : "ml-auto bg-primary-50 text-slate-800",
            )}
          >
            <p className="font-medium text-slate-900">{i.title}</p>
            {i.body && <p className="mt-0.5 whitespace-pre-wrap text-slate-600">{i.body}</p>}
            <p className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
              {when(i.at, "d MMM, HH:mm")}
              {i.href && (
                <Link href={i.href} className="text-primary-600 hover:underline">
                  Open
                </Link>
              )}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChatThread({ view }: { view: ClientView }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>{view.conversations.length} messages · newest first</span>
        {view.waContacts.map((c) => (
          <Badge key={c.id} className="bg-emerald-50 text-emerald-600 ring-emerald-200">
            WhatsApp +{c.waId}
            {c.doNotContact ? " · opted out" : ""}
          </Badge>
        ))}
      </div>
      <ol className="space-y-2">
        {view.conversations.map((m) => (
          <li
            key={m.id}
            className={cn(
              "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
              m.direction === "in"
                ? "mr-auto bg-slate-100 text-slate-800"
                : "ml-auto bg-primary-50 text-slate-800",
            )}
          >
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className="mt-1 text-[11px] text-slate-400">
              {m.channel === "whatsapp" ? "WhatsApp" : "SMS"} · {m.actor} · {when(m.at, "d MMM, HH:mm")}
              {m.status === "failed" ? " · failed" : ""}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MeetingsTab({ view }: { view: ClientView }) {
  const rows = [
    ...view.meetings.map((m) => ({
      id: `m-${m.id}`,
      at: m.at,
      title: m.title,
      detail: `${m.durationMinutes} min · ${m.locationType}${m.location ? ` · ${m.location}` : ""}`,
      href: m.meetingUrl,
    })),
    ...view.bookings.map((b) => ({
      id: `b-${b.id}`,
      at: `${b.date}T${b.start.length === 5 ? `${b.start}:00` : b.start}`,
      title: `Booked call (${b.status})`,
      detail: `${b.start}–${b.end}${b.notes ? ` · ${b.notes}` : ""}`,
      href: null as string | null,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="h-6 w-6" />}
        title="No meetings yet"
        description="Meetings scheduled with this client and calls they book appear here."
      />
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <CalendarClock className="h-4 w-4 text-slate-400" />
            <span className="font-medium text-slate-800">{r.title}</span>
            <span className="text-xs text-slate-400">{r.detail}</span>
            <span className="ml-auto text-xs tabular-nums text-slate-500">{when(r.at, "d MMM yyyy, HH:mm")}</span>
            {r.href && (
              <a href={r.href} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-primary-600">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimelineTab({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" />}
        title="Nothing recorded yet"
        description="Lead activity, delivery events, messages, quotes, invoices and payments all land here."
      />
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <ol>
        {items.map((item, i) => (
          <li key={item.id} className="relative flex gap-3 pb-4">
            {i < items.length - 1 && <span className="absolute left-[13px] top-7 h-full w-px bg-slate-100" />}
            <span className={cn("z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white", TIMELINE_TONE[item.kind])}>
              {TIMELINE_ICON[item.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800">
                {item.href ? (
                  <Link href={item.href} className="font-medium hover:text-primary-700">
                    {item.title}
                  </Link>
                ) : (
                  <span className="font-medium">{item.title}</span>
                )}
              </p>
              {item.body && <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-500">{item.body}</p>}
              <p className="mt-0.5 text-[11px] text-slate-400">
                {when(item.at, "d MMM yyyy, HH:mm")}
                {item.actor ? ` · ${item.actor}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Section({
  title,
  icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <h2 className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5 text-sm font-semibold text-slate-900">
        {icon} {title}
      </h2>
      {empty ? <p className="px-5 py-4 text-sm text-slate-400">{empty}</p> : children}
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "emerald" | "amber";
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p
        className={cn(
          "text-base font-bold tabular-nums",
          accent === "emerald" ? "text-emerald-600" : accent === "amber" ? "text-amber-600" : "text-slate-800",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
      {badge !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[11px] tabular-nums",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// Keep the Users icon import meaningful for the empty state of a future
// "people at this client" card without a lint warning today.
void Users;
