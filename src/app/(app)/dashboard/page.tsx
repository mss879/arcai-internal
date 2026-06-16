import Link from "next/link";
import { format, isToday } from "date-fns";
import {
  CalendarClock,
  FolderKanban,
  ListChecks,
  Users,
} from "lucide-react";

import { Calendar } from "@/components/dashboard/calendar";
import { QuickAddTask } from "@/components/dashboard/quick-add-task";
import { PRIORITY_META } from "@/lib/constants";
import { requireProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { cn, formatTime12 } from "@/lib/utils";
import type { Todo } from "@/lib/types";

export const metadata = { title: "Dashboard" };

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const today = format(new Date(), "yyyy-MM-dd");

  const [todosRes, members, projectsCount, clientsCount, bookingsRes] =
    await Promise.all([
      supabase.from("todos").select("*").order("due_date", { ascending: true }),
      getMembers(),
      supabase
        .from("projects")
        .select("*", { count: "exact", head: true })
        .eq("status", "active"),
      supabase.from("clients").select("*", { count: "exact", head: true }),
      supabase
        .from("meeting_bookings")
        .select("*, link:meeting_links(title)")
        .eq("status", "confirmed")
        .order("booking_date", { ascending: true })
        .order("start_time", { ascending: true }),
    ]);

  const todos = (todosRes.data ?? []) as Todo[];
  const openTasks = todos.filter((t) => t.status !== "done");
  const todayTasks = openTasks.filter(
    (t) => t.due_date && isToday(new Date(t.due_date)),
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

  const stats = [
    {
      label: "Open tasks",
      value: openTasks.length,
      icon: ListChecks,
      href: "/todos",
      tint: "bg-primary-500/10 text-primary-600 border border-primary-500/10",
    },
    {
      label: "Active projects",
      value: projectsCount.count ?? 0,
      icon: FolderKanban,
      href: "/projects",
      tint: "bg-amber-500/10 text-amber-600 border border-amber-500/10",
    },
    {
      label: "Clients",
      value: clientsCount.count ?? 0,
      icon: Users,
      href: "/clients",
      tint: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/10",
    },
    {
      label: "Upcoming meetings",
      value: upcomingBookings.length,
      icon: CalendarClock,
      href: "/meetings",
      tint: "bg-cyan-500/10 text-cyan-600 border border-cyan-500/10",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl gradient-primary p-6 sm:p-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(30rem 30rem at 90% -20%, rgba(255,255,255,0.25), transparent 60%)",
          }}
        />
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
            </p>
          </div>
          <QuickAddTask members={members} />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
              <p className="mt-3 text-2xl font-extrabold text-slate-800 tracking-tight">
                {s.value}
              </p>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mt-1">{s.label}</p>
            </Link>
          </div>
        ))}
      </div>

      {/* Calendar (Full Width) */}
      <Calendar todos={todos} members={members} bookings={bookings} />

      {/* Today's Tasks & Upcoming Meetings (Under the Calendar) */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
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
                    className="flex items-center gap-2.5 rounded-xl border border-slate-100 px-3 py-2"
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
                      <span className="shrink-0 text-xs text-slate-400">
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
            className="mt-4 block text-center text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            View all tasks
          </Link>
        </div>

        {/* Upcoming meetings */}
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] flex flex-col justify-between">
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
                    className="flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2"
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
            className="mt-4 block text-center text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            Manage meetings
          </Link>
        </div>
      </div>
    </div>
  );
}
