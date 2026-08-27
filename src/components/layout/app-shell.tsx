"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { IdleTimeout } from "@/components/layout/idle-timeout";
import type { NotificationLite, Profile } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";

// The assistant is a large, self-contained bundle (voice, chat, tools UI).
// Load it lazily so it stays off the critical path of every page.
const VoiceAssistant = dynamic(
  () =>
    import("@/components/assistant/voice-assistant").then(
      (m) => m.VoiceAssistant,
    ),
  { ssr: false },
);
const MobileVoiceScreen = dynamic(
  () =>
    import("@/components/assistant/mobile-voice-screen").then(
      (m) => m.MobileVoiceScreen,
    ),
  { ssr: false },
);

export function AppShell({
  profile,
  notifications,
  isTerminal = false,
  children,
}: {
  profile: Profile;
  notifications: NotificationLite[];
  /** This browser is the Arcus terminal (0104): always signed in, always listening. */
  isTerminal?: boolean;
  children: React.ReactNode;
}) {
  useRealtimeSync("notifications");

  const embed = useSearchParams().get("embed") === "1";

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

  // Embedded inside the Arc Studio preview canvas (`?embed=1`): render the
  // page and nothing else — no sidebar, no topbar, no idle timeout, and
  // crucially no assistant, or a `page` artifact would mount a second Arc
  // inside Arc's own preview and recurse until the tab locks up.
  //
  // Placed AFTER every hook so hook order is identical on both branches.
  // `useSearchParams()` is legal here: the (app) layout already wraps this
  // tree in a <Suspense> boundary, which is what the Next docs require of a
  // client component that reads the query string.
  if (embed) {
    return (
      <div className="app-bg min-h-screen">
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="app-bg flex min-h-screen lg:h-screen lg:overflow-hidden">
      {/* Auto sign-out after inactivity */}
      {/* The terminal NEVER idles out — that is the entire point of it: the
          cookies already live 400 days, and this component was the only thing
          signing the machine off. Every other browser keeps the 30-minute rule. */}
      {!isTerminal && <IdleTimeout />}

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col shrink-0 h-screen z-40 transition-all duration-300 ease-in-out overflow-visible",
          isCollapsed ? "w-[84px]" : "w-[260px]"
        )}
      >
        <Sidebar
          profile={profile}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleCollapse}
        />
      </aside>

      {/* Mobile drawer — kept mounted so both open and close slide via CSS */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden={!mobileOpen}
        onClick={close}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[260px] transition-transform duration-300 ease-out lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar profile={profile} onNavigate={close} />
      </aside>

      {/* Main content area. On desktop the shell is locked to the viewport and
          only this column's inner wrapper scrolls, so the sidebar always fills
          the full height. On mobile the document scrolls as usual. */}
      <div className="flex-1 min-w-0 flex flex-col lg:h-screen lg:overflow-hidden">
        <Topbar
          profile={profile}
          notifications={notifications}
          onOpenMobile={() => setMobileOpen(true)}
        />

        <div className="flex-1 lg:min-h-0 lg:overflow-y-auto">
          <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>

      {/* Voice + workspace AI assistant — ADMINS ONLY (0104). The agent
          reads and acts across every area of the workspace, which is an
          admin's reach, not a member's; the assistant API routes enforce the
          same rule server-side, so this hide is presentation, not security.
          Desktop: floating panel. Mobile: full-screen voice-first experience
          that auto-opens after login. */}
      {profile.role !== "member" && (
      <div className="hidden lg:block">
        <VoiceAssistant firstName={firstName} isTerminal={isTerminal} />
      </div>
      )}
      {profile.role !== "member" && (
      <div className="lg:hidden">
        <MobileVoiceScreen />
      </div>
      )}
    </div>
  );
}
