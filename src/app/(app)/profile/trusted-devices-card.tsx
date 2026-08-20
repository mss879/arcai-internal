"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { MonitorSmartphone, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

import { trustDevice } from "./actions";

export type TrustedDeviceInfo = {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  isCurrent: boolean;
};

/**
 * Member-only card: register this browser as the first trusted device, see
 * the registered devices, and learn how the second one joins (SMS code at
 * login). Devices can only be removed by an admin.
 */
export function TrustedDevicesCard({
  devices,
  phoneMask,
}: {
  devices: TrustedDeviceInfo[];
  phoneMask: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const currentTrusted = devices.some((d) => d.isCurrent);

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <MonitorSmartphone className="h-4 w-4 text-slate-400" /> Trusted devices
      </h3>
      <p className="mt-1 text-xs text-slate-400">
        Your account works on up to 2 registered devices (e.g. laptop +
        phone). Once registered, you can&apos;t log in from anywhere else.
      </p>

      {devices.length > 0 && (
        <ul className="mt-4 space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  {d.label}
                  {d.isCurrent && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      this device
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-400">
                  Registered {format(new Date(d.created_at), "MMM d, yyyy")}
                  {d.last_used_at &&
                    ` · last used ${format(new Date(d.last_used_at), "MMM d")}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        {devices.length === 0 ? (
          <Button onClick={() => setConfirming(true)}>
            <ShieldCheck className="h-4 w-4" /> Trust this device
          </Button>
        ) : devices.length === 1 && currentTrusted ? (
          <p className="text-xs leading-relaxed text-slate-500">
            To add your other device: log in there and tap{" "}
            <span className="font-medium text-slate-700">
              &ldquo;Text me a code&rdquo;
            </span>
            {phoneMask ? (
              <> — the code goes to {phoneMask}.</>
            ) : (
              <>
                . <span className="font-medium text-amber-600">
                  Add your phone number above first
                </span>{" "}
                — codes are sent by SMS.
              </>
            )}
          </p>
        ) : devices.length >= 2 ? (
          <p className="text-xs text-slate-500">
            Both device slots are used. Only an admin can reset your devices.
          </p>
        ) : null}
      </div>

      <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
        Devices can only be removed by an admin.
      </p>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Trust this device?"
        description="This registers this browser as one of your 2 trusted devices. From then on you can only log in from trusted devices — and only an admin can reset the list."
        confirmLabel="Trust this device"
        destructive={false}
        onConfirm={async () => {
          const res = await trustDevice();
          if (res.ok) {
            toast.success("Device registered — this device is now trusted.");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
