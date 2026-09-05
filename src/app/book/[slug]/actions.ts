"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateTimeSlots } from "@/lib/utils";

export type BookingResult = { ok: true } | { ok: false; error: string };

export async function submitBooking(input: {
  slug: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  client_name: string;
  client_email?: string;
  client_phone?: string;
  notes?: string;
}): Promise<BookingResult> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: "Booking is unavailable right now." };
  }
  if (!input.client_name?.trim()) {
    return { ok: false, error: "Please enter your name." };
  }

  const admin = createAdminClient();

  // 0116 — the booking form is public. Six an hour from one connection is
  // generous for a person and a low ceiling for a script filling the diary.
  const limited = await enforceRateLimit(admin, `booking:${clientIp(await headers())}`, {
    limit: 6,
    windowSec: 3600,
  });
  if (!limited.ok) {
    return { ok: false, error: "Too many bookings from this connection. Please try again later." };
  }

  const { data: link } = await admin
    .from("meeting_links")
    .select("*")
    .eq("slug", input.slug)
    .maybeSingle();

  if (!link || !link.active) {
    return { ok: false, error: "This booking link is no longer available." };
  }

  // Validate the date is within the allowed window.
  // To avoid timezone discrepancies between server and client, we check if
  // the selected date is within [-1 day, +advance_days + 1 day] of UTC today.
  const todayUTC = new Date();
  const todayStr = todayUTC.toISOString().split("T")[0]; // YYYY-MM-DD in UTC
  
  const bookingDate = new Date(`${input.date}T00:00:00Z`);
  const minDate = new Date(`${todayStr}T00:00:00Z`);
  minDate.setUTCDate(minDate.getUTCDate() - 1);
  
  const maxDate = new Date(`${todayStr}T00:00:00Z`);
  maxDate.setUTCDate(maxDate.getUTCDate() + link.advance_days + 1);

  if (bookingDate < minDate || bookingDate > maxDate) {
    return { ok: false, error: "Please choose a date within the available range." };
  }

  // Validate the slot is one we actually offer.
  const slot = generateTimeSlots(
    link.start_hour,
    link.end_hour,
    link.duration_minutes,
  ).find((s) => s.start === input.start_time);
  if (!slot) return { ok: false, error: "That time slot is not valid." };

  // 0112 — a booking from a number or email we know is the client's booking.
  let clientId: string | null = null;
  try {
    const { findClientByPhoneOrEmail } = await import("@/lib/contacts");
    const match = await findClientByPhoneOrEmail(admin, {
      phone: input.client_phone,
      email: input.client_email,
    });
    clientId = match?.id ?? null;
  } catch {
    clientId = null;
  }

  const { error } = await admin.from("meeting_bookings").insert({
    meeting_link_id: link.id,
    client_name: input.client_name.trim(),
    client_email: input.client_email?.trim() || null,
    client_phone: input.client_phone?.trim() || null,
    notes: input.notes?.trim() || null,
    booking_date: input.date,
    start_time: slot.start,
    end_time: slot.end,
    client_id: clientId,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Sorry — that slot was just taken. Pick another." };
    }
    return { ok: false, error: error.message };
  }

  if (link.created_by) {
    const title = "New meeting booked";
    const body = `${input.client_name.trim()} booked ${input.date} at ${slot.start}`;
    const { notifyUsers } = await import("@/lib/notify");
    await notifyUsers(admin, {
      userIds: [link.created_by],
      title,
      body,
      link: `/meetings/${link.id}`,
    });
  }

  // Revalidate paths to ensure the dashboard and meetings list reflect the booking immediately
  revalidatePath("/");
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${link.id}`);

  return { ok: true };
}
