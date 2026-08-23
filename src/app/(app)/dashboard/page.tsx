import Link from "next/link";
import type { CSSProperties } from "react";
import {
  format,
  isPast,
  isToday,
  startOfMonth,
  subMonths,
} from "date-fns";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  AtSign,
  Bell,
  CalendarClock,
  DollarSign,
  FileSignature,
  FileText,
  FolderKanban,
  KanbanSquare,
  ListChecks,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";

import { Calendar } from "@/components/dashboard/calendar";
import { MeetingAttendancePrompt } from "@/components/dashboard/meeting-attendance-prompt";
import { QuickAddTask } from "@/components/dashboard/quick-add-task";
import { PRIORITY_META } from "@/lib/constants";
import { requireProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency, formatTime12 } from "@/lib/utils";
import type { Meeting, MeetingWithAttendees, NotificationLite, Todo } from "@/lib/types";

export const metadata = { title: "Dashboard" };

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Stagger delay for the entrance choreography (see .animate-rise-in). */
function rise(ms: number): CSSProperties {
  return { "--rise-delay": `${ms}ms` } as CSSProperties;
}

const NOTIF_ICONS = {
  mention: AtSign,
  assignment: UserPlus,
  commission: DollarSign,
  system: Bell,
} as const;

export default async function DashboardPage() {
  // requireProfile is cached per request (the layout already resolved it),
  // so awaiting it first costs nothing and gives us the id for the
  // notifications query below.
  const profile = await requireProfile();
  const supabase = await createClient();
  const today = format(new Date(), "yyyy-MM-dd");

  const [
    todosRes,
    members,
    projectsCount,
    clientsCount,
    bookingsRes,
    meetingsRes,
    invoicesRes,
    quotesRes,
    leadsRes,
    notificationsRes,
  ] = await Promise.all([
    supabase.from("todos").select("*").order("due_date", { ascending: true }),
    getMembers(),
    supabase
      .from("projects")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      // 0090 — archived projects are out of every count and board.
      .is("deleted_at", null),
    supabase.from("clients").select("*", { count: "exact", head: true }),
    supabase
      .from("meeting_bookings")
      .select("*, link:meeting_links(title)")
      .eq("status", "confirmed")
      .order("booking_date", { ascending: true })
      .order("start_time", { ascending: true }),
    supabase
      .from("meetings")
      .select("*, attendees:meeting_attendees(user_id, attendance)")
      .order("meeting_at", { ascending: true }),
    supabase.from("invoices").select("invoice_date, grand_total, stamp"),
    supabase.from("quotes").select("status, grand_total, invoice_id"),
    supabase
      .from("leads")
      .select("value, expected_close_date")
      .is("deleted_at", null)
      .eq("status", "open"),
    supabase
      .from("notifications")
      .select("id, type, title, body, link, read, created_at")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const todos = (todosRes.data ?? []) as Todo[];
  const openTasks = todos.filter((t) => t.status !== "done");
  const todayTasks = openTasks.filter(
    (t) => t.due_date && isToday(new Date(t.due_date)),
  );
  const overdueTasks = openTasks.filter(
    (t) =>
      t.due_date &&
      isPast(new Date(t.due_date)) &&
      !isToday(new Date(t.due_date)),
  );

  const bookings = (bookingsRes.data ?? []) as unknown as {
    id: string;
    booking_date: string;
    start_time: string;
    client_name: string;
    link?: { title: string } | null;
  }[];
  const upcomingBookings = bookings
    .filter((b) => b.booking_date >= today)
    .slice(0, 6);

  // Scheduled team meetings (0042) — flatten the attendee join to id arrays
  // the calendar can prefill an edit with.
  const meetingsRaw = (meetingsRes.data ?? []) as unknown as (Meeting & {
    attendees: { user_id: string; attendance: string | null }[] | null;
  })[];
  const toWithAttendees = ({
    attendees,
    ...m
  }: (typeof meetingsRaw)[number]): MeetingWithAttendees => ({
    ...m,
    attendee_ids: (attendees ?? []).map((a) => a.user_id),
  });
  const meetings: MeetingWithAttendees[] = meetingsRaw.map(toWithAttendees);

  // Meetings I was assigned to that have already ended and I haven't answered
  // the "did you attend?" prompt for (0043).
  const nowMs = new Date().getTime();
  const pastUnansweredMeetings: MeetingWithAttendees[] = meetingsRaw
    .filter((m) => {
      const endMs =
        new Date(m.meeting_at).getTime() +
        (m.duration_minutes ?? 60) * 60_000;
      if (endMs >= nowMs) return false;
      return (m.attendees ?? []).some(
        (a) => a.user_id === profile.id && a.attendance == null,
      );
    })
    .map(toWithAttendees);

  // ---- Money & pipeline analytics --------------------------------
  const invoices = (invoicesRes.data ?? []) as {
    invoice_date: string;
    grand_total: number;
    stamp: string | null;
  }[];
  const quotes = (quotesRes.data ?? []) as {
    status: string;
    grand_total: number;
    invoice_id: string | null;
  }[];
  const leads = (leadsRes.data ?? []) as {
    value: number | null;
    expected_close_date: string | null;
  }[];
  const notifications = (notificationsRes.data ?? []) as NotificationLite[];

  const thisMonthStart = startOfMonth(new Date());
  const lastMonthStart = startOfMonth(subMonths(new Date(), 1));
  const sumInvoices = (from: Date, to?: Date) =>
    invoices
      .filter((i) => {
        if (!i.invoice_date) return false;
        const d = new Date(i.invoice_date);
        return d >= from && (!to || d < to);
      })
      .reduce((s, i) => s + Number(i.grand_total), 0);

  const revenueThisMonth = sumInvoices(thisMonthStart);
  const revenueLastMonth = sumInvoices(lastMonthStart, thisMonthStart);
  const revenueDelta =
    revenueLastMonth > 0
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : null;

  // Invoiced value per month for the last 6 months (oldest first).
  const trend = Array.from({ length: 6 }, (_, i) => {
    const from = startOfMonth(subMonths(new Date(), 5 - i));
    const to = startOfMonth(subMonths(new Date(), 4 - i));
    return { label: format(from, "MMM"), value: sumInvoices(from, to) };
  });
  const trendMax = Math.max(...trend.map((t) => t.value), 1);

  const awaitingQuotes = quotes.filter((q) =>
    ["sent", "viewed"].includes(q.status),
  );
  const awaitingQuotesValue = awaitingQuotes.reduce(
    (s, q) => s + Number(q.grand_total),
    0,
  );
  const acceptedUninvoiced = quotes.filter(
    (q) => q.status === "accepted" && !q.invoice_id,
  );
  const unpaidInvoices = invoices.filter((i) => i.stamp !== "payment_received");
  const unpaidValue = unpaidInvoices.reduce(
    (s, i) => s + Number(i.grand_total),
    0,
  );
  const pipelineValue = leads.reduce((s, l) => s + Number(l.value ?? 0), 0);
  const overdueLeads = leads.filter(
    (l) =>
      l.expected_close_date &&
      isPast(new Date(l.expected_close_date)) &&
      !isToday(new Date(l.expected_close_date)),
  );

  const attention: {
    label: string;
    detail: string;
    href: string;
    tone: "rose" | "amber" | "primary";
  }[] = [];
  if (overdueTasks.length > 0) {
    attention.push({
      label: `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? "" : "s"}`,
      detail: overdueTasks[0].title,
      href: "/todos",
      tone: "rose",
    });
  }
  if (awaitingQuotes.length > 0) {
    attention.push({
      label: `${awaitingQuotes.length} quote${awaitingQuotes.length === 1 ? "" : "s"} awaiting response`,
      detail: `${formatCurrency(awaitingQuotesValue)} on the table`,
      href: "/invoices?tab=quotes",
      tone: "amber",
    });
  }
  if (acceptedUninvoiced.length > 0) {
    attention.push({
      label: `${acceptedUninvoiced.length} accepted quote${acceptedUninvoiced.length === 1 ? "" : "s"} not invoiced yet`,
      detail: "Convert them to invoices in one click",
      href: "/invoices?tab=quotes",
      tone: "primary",
    });
  }
  if (unpaidInvoices.length > 0) {
    attention.push({
      label: `${unpaidInvoices.length} invoice${unpaidInvoices.length === 1 ? "" : "s"} not marked paid`,
      detail: `${formatCurrency(unpaidValue)} outstanding`,
      href: "/invoices?tab=past",
      tone: "amber",
    });
  }
  if (overdueLeads.length > 0) {
    attention.push({
      label: `${overdueLeads.length} deal${overdueLeads.length === 1 ? "" : "s"} past expected close date`,
      detail: "Update or follow up in the CRM",
      href: "/crm",
      tone: "rose",
    });
  }

  const stats = [
    {
      label: "Open tasks",
      value: String(openTasks.length),
      icon: ListChecks,
      href: "/todos",
      tint: "bg-primary-500/10 text-primary-600 border border-primary-500/10",
    },
    {
      label: "Active projects",
      value: String(projectsCount.count ?? 0),
      icon: FolderKanban,
      href: "/projects",
      tint: "bg-amber-500/10 text-amber-600 border border-amber-500/10",
    },
    {
      label: "Clients",
      value: String(clientsCount.count ?? 0),
      icon: Users,
      href: "/clients",
      tint: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/10",
    },
    {
      label: "Upcoming meetings",
      value: String(upcomingBookings.length),
      icon: CalendarClock,
      href: "/meetings",
      tint: "bg-cyan-500/10 text-cyan-600 border border-cyan-500/10",
    },
  ];

  const moneyStats = [
    {
      label: "Invoiced this month",
      value: formatCurrency(revenueThisMonth),
      sub:
        revenueDelta === null
          ? "No invoices last month"
          : `${Math.abs(revenueDelta)}% ${revenueDelta >= 0 ? "up" : "down"} vs last month`,
      delta: revenueDelta,
      icon: TrendingUp,
      href: "/invoices?tab=past",
      tint: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/10",
    },
    {
      label: "Pipeline value",
      value: formatCurrency(pipelineValue),
      sub: `${leads.length} open lead${leads.length === 1 ? "" : "s"}`,
      delta: null,
      icon: KanbanSquare,
      href: "/crm",
      tint: "bg-primary-500/10 text-primary-600 border border-primary-500/10",
    },
    {
      label: "Quotes awaiting",
      value: formatCurrency(awaitingQuotesValue),
      sub: `${awaitingQuotes.length} sent, not yet signed`,
      delta: null,
      icon: FileSignature,
      href: "/invoices?tab=quotes",
      tint: "bg-amber-500/10 text-amber-600 border border-amber-500/10",
    },
    {
      label: "Unpaid invoices",
      value: formatCurrency(unpaidValue),
      sub: `${unpaidInvoices.length} without a Paid stamp`,
      delta: null,
      icon: FileText,
      href: "/invoices?tab=past",
      tint: "bg-rose-500/10 text-rose-600 border border-rose-500/10",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Post-meeting "did you attend?" prompt for meetings that have ended */}
      <MeetingAttendancePrompt
        meetings={pastUnansweredMeetings}
        members={members}
      />

      {/* Hero */}
      <div
        className="animate-rise-in relative overflow-hidden rounded-2xl gradient-primary p-6 shadow-[var(--shadow-lift)] ring-1 ring-white/20 sm:p-8"
        style={rise(0)}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(30rem 30rem at 90% -20%, rgba(255,255,255,0.25), transparent 60%), radial-gradient(20rem 20rem at 0% 120%, rgba(255,255,255,0.12), transparent 60%)",
          }}
        />
        {/* Slow light sweep for a premium sheen */}
        <div className="animate-hero-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white sm:text-3xl">
              {greeting()}, {profile.full_name?.split(" ")[0] || profile.username}
            </h1>
            <p className="mt-1 text-sm text-white/80">
              {format(new Date(), "EEEE, MMMM d")} ·{" "}
              {todayTasks.length === 0
                ? "No tasks due today 🎉"
                : `${todayTasks.length} task${todayTasks.length === 1 ? "" : "s"} due today`}
              {overdueTasks.length > 0 &&
                ` · ${overdueTasks.length} overdue`}
            </p>
          </div>
          <QuickAddTask members={members} />
        </div>
      </div>

      {/* Calendar — front and centre */}
      <div className="animate-rise-in" style={rise(90)}>
        <Calendar
          todos={todos}
          members={members}
          bookings={bookings}
          meetings={meetings}
        />
      </div>

      {/* Stats */}
      <div
        className="animate-rise-in grid grid-cols-2 gap-4 lg:grid-cols-4"
        style={rise(180)}
      >
        {stats.map((s, idx) => (
          <div
            key={s.label}
            style={{ animationDelay: `${idx * 300}ms` }}
            className="animate-continuous-float"
          >
            <Link
              href={s.href}
              className="block group rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-1.5 hover:scale-[1.02] hover:from-white/75 hover:to-white/40 hover:border-primary-400 hover:shadow-md active:scale-[0.98]"
            >
              <span
                className={cn(
                  "grid h-11 w-11 place-items-center rounded-xl transition-transform duration-500 ease-out group-hover:scale-115 group-hover:rotate-6",
                  s.tint,
                )}
              >
                <s.icon className="h-5 w-5" />
              </span>
              <p className="mt-3 text-2xl font-extrabold tabular-nums tracking-tight text-slate-800">
                {s.value}
              </p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{s.label}</p>
            </Link>
          </div>
        ))}
      </div>

      {/* Money & pipeline analytics */}
      <div
        className="animate-rise-in grid grid-cols-2 gap-4 lg:grid-cols-4"
        style={rise(270)}
      >
        {moneyStats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="group block rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-transparent transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[var(--shadow-lift)] hover:ring-primary-200"
          >
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-xl transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-rotate-6",
                  s.tint,
                )}
              >
                <s.icon className="h-5 w-5" />
              </span>
              {s.delta !== null && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold",
                    s.delta >= 0
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-rose-50 text-rose-600",
                  )}
                >
                  {s.delta >= 0 ? (
                    <ArrowUpRight className="h-3 w-3" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3" />
                  )}
                  {Math.abs(s.delta)}%
                </span>
              )}
            </div>
            <p className="mt-3 truncate text-xl font-extrabold tabular-nums tracking-tight text-slate-800">
              {s.value}
            </p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {s.label}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">{s.sub}</p>
          </Link>
        ))}
      </div>

      {/* Revenue trend + needs attention */}
      <div
        className="animate-rise-in grid grid-cols-1 gap-6 lg:grid-cols-3"
        style={rise(360)}
      >
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Invoiced value — last 6 months
            </h2>
            <Link
              href="/finance"
              className="text-xs font-medium text-primary-600 transition-colors hover:text-primary-700"
            >
              Full finance view →
            </Link>
          </div>
          <div className="mt-4 flex h-44 items-end gap-3 sm:gap-4">
            {trend.map((m, i) => (
              <div
                key={`${m.label}-${i}`}
                className="group flex min-w-0 flex-1 flex-col items-center gap-1.5"
              >
                <span className="text-[11px] font-semibold tabular-nums text-slate-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100 sm:opacity-100">
                  {m.value > 0 ? formatCurrency(m.value) : ""}
                </span>
                <div className="flex h-32 w-full items-end">
                  <div
                    className={cn(
                      "animate-bar-grow w-full rounded-t-lg transition-colors duration-300",
                      i === trend.length - 1
                        ? "bg-gradient-to-t from-primary-600 to-primary-400"
                        : "bg-gradient-to-t from-primary-200 to-primary-100 group-hover:from-primary-400 group-hover:to-primary-300",
                    )}
                    style={{
                      height: `${Math.max(4, Math.round((m.value / trendMax) * 100))}%`,
                      ...rise(450 + i * 90),
                    }}
                  />
                </div>
                <span className="text-xs font-medium text-slate-400">{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Needs attention
          </h2>
          <div className="mt-3 space-y-2">
            {attention.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">
                All clear — nothing needs chasing. 🎉
              </p>
            ) : (
              attention.map((a) => (
                <Link
                  key={a.label}
                  href={a.href}
                  className="flex items-start gap-2.5 rounded-xl border border-slate-100 px-3 py-2.5 transition-all duration-200 hover:translate-x-0.5 hover:border-primary-200 hover:bg-slate-50/60"
                >
                  <span
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                      a.tone === "rose"
                        ? "bg-rose-500"
                        : a.tone === "amber"
                          ? "bg-amber-500"
                          : "bg-primary-500",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800">
                      {a.label}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {a.detail}
                    </span>
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Notifications, today's tasks & upcoming meetings */}
      <div
        className="animate-rise-in grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3"
        style={rise(450)}
      >
        {/* Recent notifications */}
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] flex flex-col justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Bell className="h-4 w-4 text-primary-500" />
              Recent notifications
            </h2>
            <div className="mt-3 space-y-2">
              {notifications.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  Nothing yet — assignments and mentions show up here.
                </p>
              ) : (
                notifications.map((n) => {
                  const Icon =
                    NOTIF_ICONS[n.type as keyof typeof NOTIF_ICONS] ?? Bell;
                  return (
                    <Link
                      key={n.id}
                      href={n.link || "/dashboard"}
                      className={cn(
                        "flex items-start gap-2.5 rounded-xl border px-3 py-2 transition-all duration-200 hover:translate-x-0.5 hover:border-primary-200",
                        n.read
                          ? "border-slate-100"
                          : "border-primary-100 bg-primary-50/40",
                      )}
                    >
                      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block truncate text-sm",
                            n.read
                              ? "text-slate-600"
                              : "font-medium text-slate-900",
                          )}
                        >
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="block truncate text-xs text-slate-400">
                            {n.body}
                          </span>
                        )}
                      </span>
                      {!n.read && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary-500" />
                      )}
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Today */}
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Today&apos;s tasks
            </h2>
            <div className="mt-3 space-y-2">
              {todayTasks.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  Nothing due today.
                </p>
              ) : (
                todayTasks.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2.5 rounded-xl border border-slate-100 px-3 py-2 transition-colors hover:bg-slate-50/60"
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        PRIORITY_META[t.priority].dot,
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                      {t.title}
                    </span>
                    {t.due_date && (
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {format(new Date(t.due_date), "p")}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          <Link
            href="/todos"
            className="mt-4 block text-center text-xs font-medium text-primary-600 transition-colors hover:text-primary-700"
          >
            View all tasks
          </Link>
        </div>

        {/* Upcoming meetings */}
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] flex flex-col justify-between md:col-span-2 xl:col-span-1">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Upcoming meetings
            </h2>
            <div className="mt-3 space-y-2">
              {upcomingBookings.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  No meetings booked.
                </p>
              ) : (
                upcomingBookings.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2 transition-colors hover:bg-slate-50/60"
                  >
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-center text-primary-600">
                      <span className="text-[10px] font-bold uppercase leading-none">
                        {format(new Date(b.booking_date), "MMM")}
                      </span>
                      <span className="text-sm font-bold leading-none">
                        {format(new Date(b.booking_date), "d")}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {b.client_name}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {b.link?.title ?? "Meeting"} · {formatTime12(b.start_time)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <Link
            href="/meetings"
            className="mt-4 block text-center text-xs font-medium text-primary-600 transition-colors hover:text-primary-700"
          >
            Manage meetings
          </Link>
        </div>
      </div>
    </div>
  );
}
