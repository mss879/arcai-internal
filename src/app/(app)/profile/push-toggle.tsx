"use client";

import * as React from "react";
import { toast } from "sonner";
import { BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";

import { deletePushSubscription, savePushSubscription } from "./actions";

/** Convert a base64url VAPID public key to the Uint8Array the Push API wants. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

export function PushToggle() {
  const [supported, setSupported] = React.useState(true);
  const [subscribed, setSubscribed] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok =
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;
      if (!ok) {
        if (!cancelled) {
          setSupported(false);
          setReady(true);
        }
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setSubscribed(!!sub);
      } catch {
        /* registration can fail in unsupported/insecure contexts */
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error(
          "Notifications are blocked. Allow them in your browser settings.",
        );
        return;
      }
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) {
        toast.error("Push is not configured on the server.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const json = sub.toJSON();
      const res = await savePushSubscription(
        {
          endpoint: json.endpoint!,
          keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
        },
        navigator.userAgent,
      );
      if (res.ok) {
        setSubscribed(true);
        toast.success("Notifications enabled on this device 🎉");
      } else {
        toast.error(res.error);
      }
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not enable notifications.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deletePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast.success("Notifications disabled on this device.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <BellRing className="h-4 w-4 text-slate-400" /> Push notifications
      </h3>
      <p className="mt-1 text-xs text-slate-400">
        Get a pop-up on this device — even when ARC AI is closed — when
        you&apos;re assigned a task or lead, @mentioned, or a meeting is booked.
      </p>

      <div className="mt-4">
        {!supported ? (
          <p className="text-sm text-slate-500">
            This browser doesn&apos;t support push notifications. On iPhone, add
            ARC AI to your Home Screen first (Share → Add to Home Screen).
          </p>
        ) : subscribed ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Enabled on this device
            </span>
            <Button variant="outline" onClick={disable} loading={busy} disabled={!ready}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button onClick={enable} loading={busy} disabled={!ready}>
            Enable on this device
          </Button>
        )}
      </div>
    </div>
  );
}
