"use client";

import { useEffect } from "react";

/**
 * Self-registering service worker component for PWA installation.
 * Runs on the client side after mounting.
 */
export function PwaRegister() {
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      // Prevent registering in development if not desired, or register it anyway
      // For PWAs to work, registering it in dev is fine and helps testing.
      process.env.NODE_ENV === "production"
    ) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          console.log("PWA Service Worker registered with scope:", reg.scope);
        })
        .catch((err) => {
          console.error("PWA Service Worker registration failed:", err);
        });
    }
  }, []);

  return null;
}
