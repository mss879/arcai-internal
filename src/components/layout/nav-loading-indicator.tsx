"use client";

import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shows a small spinner on a nav item while its destination is loading.
 * Must be rendered inside a <Link>. Gives instant feedback the moment a tab
 * is clicked, so navigation feels responsive even before the page streams in.
 * Positioned absolutely so it never shifts the layout.
 */
export function NavLoadingIndicator({ isCollapsed }: { isCollapsed?: boolean }) {
  const { pending } = useLinkStatus();

  return (
    <Loader2
      aria-hidden
      className={cn(
        "absolute h-4 w-4 animate-spin text-white transition-opacity duration-150",
        isCollapsed ? "right-1 top-1" : "right-3 top-1/2 -translate-y-1/2",
        pending ? "opacity-90" : "opacity-0",
      )}
    />
  );
}
