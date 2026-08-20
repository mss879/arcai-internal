"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { reportScreenshotAction } from "@/app/(app)/security-actions";

/**
 * Logs a member's Print Screen key press to the admin Activity trail —
 * the only screenshot signal a browser is allowed to see (Windows).
 * macOS's Cmd+Shift+3/4 and phone screenshots happen entirely outside
 * the page and cannot be detected by any web app.
 *
 * Renders nothing. Mounted for members only, from the authenticated layout.
 */
export function ScreenshotSentry() {
  const pathname = usePathname();
  const lastReport = React.useRef(0);

  React.useEffect(() => {
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== "PrintScreen" && e.code !== "PrintScreen") return;
      const now = Date.now();
      if (now - lastReport.current < 10_000) return; // don't spam on key-hold
      lastReport.current = now;
      void reportScreenshotAction(pathname ?? "/");
    }
    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  }, [pathname]);

  return null;
}
