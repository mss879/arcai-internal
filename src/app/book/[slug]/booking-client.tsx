"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { addDays, format, isToday } from "date-fns";
import { toast } from "sonner";
import { CalendarCheck, Clock, MapPin, PartyPopper } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Logo } from "@/components/brand/logo";
import { cn, formatTime12, generateTimeSlots } from "@/lib/utils";

import { submitBooking } from "./actions";

type LinkConfig = {
  slug: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  start_hour: number;
  end_hour: number;
  advance_days: number;
  location: string | null;
};

export function BookingClient({
  link,
  taken,
}: {
  link: LinkConfig;
  taken: string[];
}) {
  const takenSet = React.useMemo(() => new Set(taken), [taken]);
  const dates = React.useMemo(
    () =>
      Array.from({ length: link.advance_days + 1 }, (_, i) =>
        addDays(new Date(), i),
      ),
    [link.advance_days],
  );

  const slots = React.useMemo(
    () =>
      generateTimeSlots(link.start_hour, link.end_hour, link.duration_minutes),
    [link],
  );

  const [date, setDate] = React.useState<Date>(dates[0]);
  const [slot, setSlot] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState<{ date: Date; slot: string } | null>(
    null,
  );

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const dateKey = format(date, "yyyy-MM-dd");

  function isSlotDisabled(start: string) {
    if (takenSet.has(`${dateKey}_${start}`)) return true;
    if (isToday(date)) {
      const [h, m] = start.split(":").map(Number);
      const now = new Date();
      if (h < now.getHours() || (h === now.getHours() && m <= now.getMinutes()))
        return true;
    }
    return false;
  }

  async function confirm() {
    if (!slot) return;
    if (!name.trim()) {
      toast.error("Please enter your name.");
      return;
    }
    setPending(true);
    const res = await submitBooking({
      slug: link.slug,
      date: dateKey,
      start_time: slot,
      client_name: name,
      client_email: email,
      client_phone: phone,
      notes,
    });
    setPending(false);
    if (res.ok) {
      setDone({ date, slot });
    } else {
      toast.error(res.error);
    }
  }

  if (done) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl border border-slate-200/80 bg-white p-8 text-center shadow-[var(--shadow-card)]"
      >
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-500">
          <PartyPopper className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">
          You&apos;re booked!
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          {format(done.date, "EEEE, MMMM d")} at {formatTime12(done.slot)}
        </p>
        {link.location && (
          <p className="mt-1 text-sm text-slate-400">{link.location}</p>
        )}
        <Button
          variant="outline"
          className="mt-6"
          onClick={() => {
            setDone(null);
            setSlot(null);
            setName("");
            setEmail("");
            setPhone("");
            setNotes("");
          }}
        >
          Book another time
        </Button>
      </motion.div>
    );
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="gradient-primary px-7 py-6 text-white">
        <Logo variant="light" size="sm" />
        <h1 className="mt-4 text-2xl font-semibold">{link.title}</h1>
        {link.description && (
          <p className="mt-1 max-w-lg text-sm text-white/80">
            {link.description}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/75">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {link.duration_minutes} minutes
          </span>
          {link.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> {link.location}
            </span>
          )}
        </div>
      </div>

      <div className="p-6 sm:p-7">
        {/* Dates */}
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Select a date
        </p>
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
          {dates.map((d) => {
            const active = format(d, "yyyy-MM-dd") === dateKey;
            return (
              <button
                key={d.toISOString()}
                onClick={() => {
                  setDate(d);
                  setSlot(null);
                }}
                className={cn(
                  "flex min-w-[64px] flex-col items-center rounded-xl border px-3 py-2 transition",
                  active
                    ? "border-primary-300 bg-primary-50 text-primary-700 ring-2 ring-primary-100"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50",
                )}
              >
                <span className="text-[11px] font-medium uppercase">
                  {format(d, "EEE")}
                </span>
                <span className="text-lg font-bold">{format(d, "d")}</span>
                <span className="text-[10px] text-slate-400">
                  {format(d, "MMM")}
                </span>
              </button>
            );
          })}
        </div>

        {/* Slots */}
        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {format(date, "EEEE, MMMM d")}
        </p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {slots.map((s) => {
            const disabled = isSlotDisabled(s.start);
            const active = slot === s.start;
            return (
              <button
                key={s.start}
                disabled={disabled}
                onClick={() => setSlot(s.start)}
                className={cn(
                  "rounded-xl border px-2 py-2.5 text-sm font-medium transition",
                  disabled &&
                    "cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300 line-through",
                  !disabled &&
                    active &&
                    "border-primary-500 bg-primary-600 text-white shadow-sm",
                  !disabled &&
                    !active &&
                    "border-slate-200 text-slate-600 hover:border-primary-300 hover:bg-primary-50",
                )}
              >
                {formatTime12(s.start)}
              </button>
            );
          })}
        </div>

        {/* Details form */}
        <AnimatePresence>
          {slot && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-6 space-y-4 border-t border-slate-100 pt-6">
                <div className="flex items-center gap-2 rounded-xl bg-primary-50 px-3.5 py-2.5 text-sm text-primary-700">
                  <CalendarCheck className="h-4 w-4" />
                  {format(date, "EEE, MMM d")} at {formatTime12(slot)}
                </div>
                <Field label="Your name" required>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Doe"
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Email">
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                  <Field label="Phone">
                    <Input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Anything we should know?">
                  <Textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </Field>
                <Button
                  onClick={confirm}
                  loading={pending}
                  size="lg"
                  className="w-full"
                >
                  Confirm booking
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
