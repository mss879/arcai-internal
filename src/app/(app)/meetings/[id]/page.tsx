import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, CalendarClock, Mail, Phone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/server";
import { formatTime12 } from "@/lib/utils";

export const metadata = { title: "Bookings" };

export default async function MeetingBookingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: link } = await supabase
    .from("meeting_links")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!link) notFound();

  const { data: bookings } = await supabase
    .from("meeting_bookings")
    .select("*")
    .eq("meeting_link_id", id)
    .order("booking_date", { ascending: true })
    .order("start_time", { ascending: true });

  return (
    <div className="space-y-6">
      <Link
        href="/meetings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Meetings
      </Link>

      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{link.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {bookings?.length ?? 0} booking{bookings?.length === 1 ? "" : "s"} ·{" "}
          {link.duration_minutes} min slots
        </p>
      </div>

      {!bookings || bookings.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="No bookings yet"
          description="Share the link — bookings will show up here."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3.5 font-semibold">When</th>
                <th className="px-5 py-3.5 font-semibold">Client</th>
                <th className="px-5 py-3.5 font-semibold">Contact</th>
                <th className="px-5 py-3.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {bookings.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-slate-900">
                      {format(new Date(b.booking_date), "EEE, MMM d")}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatTime12(b.start_time)} – {formatTime12(b.end_time)}
                    </p>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-slate-800">{b.client_name}</p>
                    {b.notes && (
                      <p className="text-xs text-slate-400">{b.notes}</p>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-slate-500">
                    <div className="space-y-0.5">
                      {b.client_email && (
                        <p className="flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-slate-400" />
                          {b.client_email}
                        </p>
                      )}
                      {b.client_phone && (
                        <p className="flex items-center gap-1.5">
                          <Phone className="h-3.5 w-3.5 text-slate-400" />
                          {b.client_phone}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge
                      className={
                        b.status === "confirmed"
                          ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                          : "bg-rose-50 text-rose-600 ring-rose-200"
                      }
                    >
                      {b.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
