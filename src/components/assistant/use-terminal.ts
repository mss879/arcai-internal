"use client";

/**
 * What being the terminal means, client-side (0104).
 *
 * The server already decided this machine is the Arcus terminal (the flag on
 * its trusted-device row) and switched the idle logout off. This hook adds
 * the one thing only the browser can do: hold a Screen Wake Lock while the
 * wake word is armed, so the display doesn't sleep out from under a machine
 * whose job is to listen. Web Speech recognition aborts on hidden tabs and
 * dies with OS sleep — a dark screen is a deaf Arcus.
 *
 * Feature-detected and silent: on browsers without the API the terminal
 * still works, minus this one courtesy. The lock is re-acquired whenever the
 * tab becomes visible again, because the platform releases it on every hide.
 */

import * as React from "react";

type WakeLockSentinel = { release: () => Promise<void> } & EventTarget;

export function useTerminal(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    };
    if (!nav.wakeLock) return;

    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        lock = await nav.wakeLock!.request("screen");
      } catch {
        // Battery saver, permissions policy — the terminal survives without.
      }
    };

    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
