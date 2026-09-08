"use client";

import * as React from "react";

/**
 * Member activity heartbeat (mounted for members only).
 *
 * Posts to /api/activity/ping while the member actually has the app open
 * and in front of them. The route either stretches the current session or
 * opens a new one, so "opened the app" is recorded even when no password
 * was typed — the case that made the Activity view stop at whatever day
 * the member last signed in.
 *
 * Why the conditions below, rather than a plain interval:
 *
 *   * only while the tab is VISIBLE, and only within ACTIVE_WINDOW_MS of a
 *     real interaction — a tab left open on a spare monitor should not
 *     read as an hour of work;
 *   * immediately when the tab becomes visible again. This is the iPad:
 *     iOS freezes timers in a backgrounded tab, so the interval is no help
 *     — the moment the app is opened is the signal, and it is exactly when
 *     a new session usually has to be opened;
 *   * a `sendBeacon` on the way out, so a session ends at the second they
 *     left rather than at the last tick before it.
 *
 * Every one of those paths goes through the same floor. That matters:
 * each ping is a billed Netlify function invocation, and switching to
 * another app and back is something a member does dozens of times an
 * hour. A ping is only worth sending when it would actually move
 * `last_active_at` — which the server, in turn, only writes once a
 * minute. Nothing here is allowed to outrun that.
 *
 * Interaction is tracked here rather than read from the idle-timeout's
 * localStorage key, so this still works on the Arcus terminal — which
 * deliberately mounts no idle timeout.
 */

const ENDPOINT = "/api/activity/ping";
/**
 * One heartbeat every two minutes. The only thing that depends on this
 * rate is the 5-minute "online now" window on the Team board; the exit
 * beacon is what makes the recorded end time exact. Halving the rate
 * halves the standing cost of the feature and changes neither.
 */
const PING_INTERVAL_MS = 120_000;
/** No interaction for this long = they walked away, stop counting time. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
/** No ping may leave the browser more often than this, from any trigger. */
const MIN_PING_GAP_MS = 45_000;
/**
 * On the way out, only spend a request if the last ping is old enough
 * that the server would actually write a new `last_active_at`. Below
 * this, the session already ends within a few seconds of the truth.
 */
const MIN_EXIT_GAP_MS = 60_000;

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
] as const;

export function ActivityHeartbeat() {
  React.useEffect(() => {
    let lastInteraction = Date.now();
    let lastPing = 0;
    let cancelled = false;

    const markInteraction = () => {
      lastInteraction = Date.now();
    };

    const ping = () => {
      if (cancelled) return;
      const t = Date.now();
      if (t - lastPing < MIN_PING_GAP_MS) return;
      lastPing = t;
      // Monitoring is never worth a visible failure: swallow everything.
      void fetch(ENDPOINT, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});
    };

    /** Close the session at the moment they actually leave. */
    const exit = () => {
      const t = Date.now();
      if (t - lastPing < MIN_EXIT_GAP_MS) return;
      lastPing = t;
      try {
        navigator.sendBeacon?.(ENDPOINT);
      } catch {
        // Beacons are best-effort by design.
      }
    };

    // Arriving on a page is itself the interaction.
    ping();

    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, markInteraction, { passive: true }),
    );

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInteraction > ACTIVE_WINDOW_MS) return;
      ping();
    }, PING_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        markInteraction();
        ping();
      } else {
        exit();
      }
    };

    const onResume = () => {
      markInteraction();
      ping();
    };

    document.addEventListener("visibilitychange", onVisibility);
    // `pageshow` covers a bfcache restore, where visibilitychange may not fire.
    window.addEventListener("pageshow", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pagehide", exit);

    return () => {
      cancelled = true;
      ACTIVITY_EVENTS.forEach((e) =>
        window.removeEventListener(e, markInteraction),
      );
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pagehide", exit);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
