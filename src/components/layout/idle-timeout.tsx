"use client";

import * as React from "react";

import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

/**
 * Inactivity auto-logout.
 *
 * After IDLE_TIMEOUT_MS with no user activity, the session is signed out and
 * the user is sent to /login?timeout=1. A warning dialog appears
 * WARNING_BEFORE_MS before that, letting them stay signed in.
 *
 * Activity is shared across tabs via localStorage, and the elapsed time is
 * measured from a timestamp (not a counter), so it stays accurate even if a
 * tab is backgrounded, throttled, or the computer sleeps.
 *
 * To change the durations, edit the two constants below.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity → logout
const WARNING_BEFORE_MS = 60 * 1000; // show the warning 1 minute before logout

const ACTIVITY_KEY = "arc:last-activity";
const LOGOUT_KEY = "arc:logout-broadcast";
const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
] as const;

function now() {
  return Date.now();
}

export function IdleTimeout() {
  const [warningOpen, setWarningOpen] = React.useState(false);
  const [remainingSec, setRemainingSec] = React.useState(60);

  // Refs so the event/interval handlers always see fresh values without
  // re-binding listeners on every render.
  const warningOpenRef = React.useRef(false);
  const lastWriteRef = React.useRef(0);
  const loggingOutRef = React.useRef(false);

  React.useEffect(() => {
    warningOpenRef.current = warningOpen;
  }, [warningOpen]);

  const recordActivity = React.useCallback((force = false) => {
    // While the warning is open, passive activity must NOT reset the timer —
    // the user has to make an explicit choice. (force=true bypasses this for
    // the "Stay signed in" button.)
    if (warningOpenRef.current && !force) return;
    const t = now();
    if (!force && t - lastWriteRef.current < 3000) return; // throttle writes
    lastWriteRef.current = t;
    try {
      localStorage.setItem(ACTIVITY_KEY, String(t));
    } catch {
      // localStorage unavailable (private mode / blocked) — fail open.
    }
  }, []);

  const logout = React.useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    try {
      localStorage.setItem(LOGOUT_KEY, String(now())); // tell other tabs
      await createClient().auth.signOut();
    } catch {
      // ignore — we redirect regardless
    }
    // Full navigation so all in-memory state is cleared.
    window.location.href = "/login?timeout=1";
  }, []);

  const stayLoggedIn = React.useCallback(() => {
    recordActivity(true);
    setWarningOpen(false);
  }, [recordActivity]);

  React.useEffect(() => {
    // Seed the timer on mount.
    recordActivity(true);

    const onActivity = () => recordActivity();
    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true }),
    );

    const onStorage = (e: StorageEvent) => {
      // Another tab logged out → follow it.
      if (e.key === LOGOUT_KEY) {
        window.location.href = "/login?timeout=1";
      }
    };
    window.addEventListener("storage", onStorage);

    const tick = () => {
      let last = lastWriteRef.current || now();
      try {
        const stored = Number(localStorage.getItem(ACTIVITY_KEY));
        if (stored) last = stored;
      } catch {
        // ignore
      }
      const elapsed = now() - last;

      if (elapsed >= IDLE_TIMEOUT_MS) {
        void logout();
        return;
      }
      if (elapsed >= IDLE_TIMEOUT_MS - WARNING_BEFORE_MS) {
        setWarningOpen(true);
        setRemainingSec(Math.ceil((IDLE_TIMEOUT_MS - elapsed) / 1000));
      } else if (warningOpenRef.current) {
        // Activity (possibly from another tab) pushed us back below the
        // threshold — dismiss the warning.
        setWarningOpen(false);
      }
    };

    const interval = window.setInterval(tick, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener("storage", onStorage);
      window.clearInterval(interval);
    };
  }, [recordActivity, logout]);

  const mm = Math.floor(remainingSec / 60);
  const ss = String(remainingSec % 60).padStart(2, "0");

  return (
    <Modal
      open={warningOpen}
      onClose={stayLoggedIn}
      title="Are you still there?"
      description="You've been inactive for a while. For security, you'll be signed out automatically."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => void logout()}>
            Log out now
          </Button>
          <Button variant="primary" onClick={stayLoggedIn}>
            Stay signed in
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        Signing out in{" "}
        <span className="font-semibold tabular-nums text-slate-900">
          {mm}:{ss}
        </span>
        .
      </p>
    </Modal>
  );
}
