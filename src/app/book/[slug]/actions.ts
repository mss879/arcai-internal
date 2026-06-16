"use server";

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

  const { data: link } = await admin
    .from("meeting_links")
    .select("*")
    .eq("slug", input.slug)
    .maybeSingle();

  if (!link || !link.active) {
    return { ok: false, error: "This booking link is no longer available." };
  }

  // Validate the date is within the allowed window.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(`${input.date}T00:00:00`);
  const max = new Date(today);
  max.setDate(max.getDate() + link.advance_days);
  if (date < today || date > max) {
    return { ok: false, error: "Please choose a date within the available range." };
  }

  // Validate the slot is one we actually offer.
  const slot = generateTimeSlots(
    link.start_hour,
    link.end_hour,
    link.duration_minutes,
  ).find((s) => s.start === input.start_time);
  if (!slot) return { ok: false, error: "That time slot is not valid." };

  const { error } = await admin.from("meeting_bookings").insert({
    meeting_link_id: link.id,
    client_name: input.client_name.trim(),
    client_email: input.client_email?.trim() || null,
    client_phone: input.client_phone?.trim() || null,
    notes: input.notes?.trim() || null,
    booking_date: input.date,
    start_time: slot.start,
    end_time: slot.end,
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Sorry — that slot was just taken. Pick another." };
    }
    return { ok: false, error: error.message };
  }

  if (link.created_by) {
    await admin.from("notifications").insert({
      user_id: link.created_by,
      type: "system",
      title: "New meeting booked",
      body: `${input.client_name.trim()} booked ${input.date} at ${slot.start}`,
      link: `/meetings/${link.id}`,
    });
  }

  return { ok: true };
}
