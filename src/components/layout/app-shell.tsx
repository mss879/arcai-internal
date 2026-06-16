"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import type { Notification, Profile } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

export function AppShell({
  profile,
  notifications,
  children,
}: {
  profile: Profile;
  notifications: Notification[];
  children: React.ReactNode;
}) {
  useRealtimeSync("notifications");

  const [mobileOpen, setMobileOpen] = React.useState(false);
  const close = React.useCallback(() => setMobileOpen(false), []);

  return (
    <div className="app-bg min-h-screen lg:pl-[260px]">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[260px] lg:block">
        <Sidebar profile={profile} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={close}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-[260px] lg:hidden"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0.1 }}
            >
              <Sidebar profile={profile} onNavigate={close} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <Topbar
        profile={profile}
        notifications={notifications}
        onOpenMobile={() => setMobileOpen(true)}
      />

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
