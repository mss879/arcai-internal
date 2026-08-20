"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldAlert, Smartphone } from "lucide-react";

/**
 * Post-login warning for the member device lock.
 *
 * Urgent (amber): no device trusted yet — countdown to the 48h deadline,
 * after which they can't sign in at all.
 * Info (slate): one device trusted — reminder of how to add the second.
 * Hidden: both slots used, window closed, or not a member.
 */
export function DeviceTrustBanner({
  devicesCount,
  currentDeviceTrusted,
  graceDeadline,
  withinGrace,
  phoneOnFile,
}: {
  devicesCount: number;
  currentDeviceTrusted: boolean;
  graceDeadline: string | null;
  withinGrace: boolean;
  phoneOnFile: boolean;
}) {
  const [remaining, setRemaining] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!graceDeadline) return;
    const tick = () => {
      const ms = new Date(graceDeadline).getTime() - Date.now();
      if (ms <= 0) {
        setRemaining("0h 0m");
        return;
      }
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      setRemaining(`${h}h ${m}m`);
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [graceDeadline]);

  if (devicesCount >= 2 || !withinGrace) return null;

  if (devicesCount === 0) {
    return (
      <div className="mb-5 flex flex-col gap-3 rounded-2xl bg-amber-50 px-4 py-3.5 ring-1 ring-inset ring-amber-200 sm:flex-row sm:items-center">
        <ShieldAlert className="hidden h-5 w-5 shrink-0 text-amber-500 sm:block" />
        <p className="flex-1 text-sm leading-relaxed text-amber-900">
          <span className="font-semibold">Trust this device now.</span> You
          have {remaining ?? "48h"} left to register your devices — after
          that you won&apos;t be able to log in from anywhere else.
        </p>
        <Link
          href="/profile"
          className="inline-flex shrink-0 items-center justify-center rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600"
        >
          Trust this device
        </Link>
      </div>
    );
  }

  // Exactly one device registered.
  if (!currentDeviceTrusted) return null; // untrusted sessions get kicked anyway
  return (
    <div className="mb-5 flex items-start gap-2.5 rounded-2xl bg-slate-100/80 px-4 py-3 ring-1 ring-inset ring-slate-200">
      <Smartphone className="mt-0.5 h-4.5 w-4.5 shrink-0 text-slate-400" />
      <p className="text-sm leading-relaxed text-slate-600">
        <span className="font-medium text-slate-800">
          1 of 2 devices registered.
        </span>{" "}
        To add your other device, log in there and tap &ldquo;Text me a
        code&rdquo;.{" "}
        {phoneOnFile ? (
          <>The code goes to the phone number on your profile.</>
        ) : (
          <>
            First{" "}
            <Link href="/profile" className="font-medium text-primary-600 underline">
              add your phone number
            </Link>{" "}
            — codes are sent by SMS.
          </>
        )}
      </p>
    </div>
  );
}
