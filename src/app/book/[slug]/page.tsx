import { format } from "date-fns";
import { CalendarX2 } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";

import { BookingClient } from "./booking-client";

export const metadata = { title: "Book a time" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );
}

export default async function BookPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return (
      <Shell>
        <Unavailable />
      </Shell>
    );
  }

  const admin = createAdminClient();
  const { data: link } = await admin
    .from("meeting_links")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (!link || !link.active) {
    return (
      <Shell>
        <Unavailable />
      </Shell>
    );
  }

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const { data: bookings } = await admin
    .from("meeting_bookings")
    .select("booking_date, start_time")
    .eq("meeting_link_id", link.id)
    .eq("status", "confirmed")
    .gte("booking_date", todayStr);

  const taken = (bookings ?? []).map(
    (b) => `${b.booking_date}_${b.start_time}`,
  );

  return (
    <Shell>
      <BookingClient
        link={{
          slug: link.slug,
          title: link.title,
          description: link.description,
          duration_minutes: link.duration_minutes,
          start_hour: link.start_hour,
          end_hour: link.end_hour,
          advance_days: Math.min(link.advance_days, 14),
          location: link.location,
        }}
        taken={taken}
      />
    </Shell>
  );
}

function Unavailable() {
  return (
    <div className="rounded-3xl border border-slate-200/80 bg-white p-10 text-center shadow-[var(--shadow-card)]">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400">
        <CalendarX2 className="h-7 w-7" />
      </div>
      <h1 className="text-xl font-semibold text-slate-900">
        Booking link unavailable
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        This link may have been paused or removed. Please check with whoever
        shared it.
      </p>
    </div>
  );
}
