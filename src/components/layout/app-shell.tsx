"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { IdleTimeout } from "@/components/layout/idle-timeout";
import { VoiceAssistant } from "@/components/assistant/voice-assistant";
import { MobileVoiceScreen } from "@/components/assistant/mobile-voice-screen";
import type { Notification, Profile } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";

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

  const firstName = profile.full_name.split(" ")[0] || "there";

  const [mobileOpen, setMobileOpen] = React.useState(false);
  const close = React.useCallback(() => setMobileOpen(false), []);

  const [isCollapsed, setIsCollapsed] = React.useState(false);

  // Safely read from localStorage after mount to avoid hydration mismatch
  React.useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setIsCollapsed(true);
    }
  }, []);

  const toggleCollapse = React.useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  return (
    <div className="app-bg min-h-screen flex">
      {/* Auto sign-out after inactivity */}
      <IdleTimeout />

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col shrink-0 sticky top-0 h-screen z-40 transition-all duration-300 ease-in-out overflow-visible",
          isCollapsed ? "w-[84px]" : "w-[260px]"
        )}
      >
        <Sidebar
          profile={profile}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleCollapse}
        />
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

      {/* Main content area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar
          profile={profile}
          notifications={notifications}
          onOpenMobile={() => setMobileOpen(true)}
        />

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      {/* Voice + workspace AI assistant.
          Desktop: floating panel. Mobile: full-screen voice-first experience
          that auto-opens after login. */}
      <div className="hidden lg:block">
        <VoiceAssistant firstName={firstName} />
      </div>
      <div className="lg:hidden">
        <MobileVoiceScreen firstName={firstName} />
      </div>
    </div>
  );
}
