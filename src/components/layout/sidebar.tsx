"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { LogOut, ChevronLeft, ChevronRight } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Avatar } from "@/components/ui/avatar";
import { NavLoadingIndicator } from "@/components/layout/nav-loading-indicator";
import { ADMIN_NAV, NAV, type NavItem } from "@/components/layout/nav";
import { signOutAction } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/types";

function NavLink({
  item,
  active,
  onNavigate,
  isCollapsed,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  isCollapsed?: boolean;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={isCollapsed ? item.label : undefined}
      className={cn(
        "relative flex items-center rounded-xl transition-all duration-300 ease-in-out font-semibold text-[15px]",
        isCollapsed 
          ? "justify-center h-12 w-12 mx-auto px-0 gap-0" 
          : "px-4 py-3",
        active 
          ? "text-white" 
          : "text-white hover:bg-white/10",
      )}
    >
      {active && (
        <motion.span
          layoutId="active-nav"
          className="absolute inset-0 rounded-xl bg-white/15 ring-1 ring-inset ring-white/10"
          transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
        />
      )}
      <item.icon className={cn("relative shrink-0 transition-all duration-300", isCollapsed ? "h-6 w-6" : "h-5 w-5")} />
      
      <AnimatePresence initial={false} mode="popLayout">
        {!isCollapsed && (
          <motion.span
            initial={{ opacity: 0, width: 0, marginLeft: 0 }}
            animate={{ opacity: 1, width: "auto", marginLeft: 12 }}
            exit={{ opacity: 0, width: 0, marginLeft: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="relative whitespace-nowrap overflow-hidden inline-block"
          >
            {item.label}
          </motion.span>
        )}
      </AnimatePresence>

      <NavLoadingIndicator isCollapsed={isCollapsed} />
    </Link>
  );
}

export function Sidebar({
  profile,
  onNavigate,
  isCollapsed = false,
  onToggleCollapse,
}: {
  profile: Profile;
  onNavigate?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div
      className={cn(
        "relative flex h-full flex-col gradient-primary py-5 transition-all duration-300 ease-in-out border-r border-white/10",
        isCollapsed ? "px-2 items-center" : "px-4"
      )}
    >
      {/* Collapse toggle button (desktop only) */}
      {onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          type="button"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3.5 top-1/2 -translate-y-1/2 z-50 hidden h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-slate-900 text-white shadow-lg transition-all hover:scale-110 active:scale-95 lg:flex hover:bg-slate-800"
        >
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      )}

      {/* Logo container */}
      <div
        className={cn(
          "flex justify-center mb-6 transition-all duration-300 w-full",
          isCollapsed ? "px-0" : "px-2"
        )}
      >
        {isCollapsed ? (
          <div className="flex items-center justify-center bg-black rounded-xl h-12 w-12 shadow-xl border border-white/10 text-white font-extrabold text-xl tracking-wider select-none">
            A
          </div>
        ) : (
          <div className="flex items-center justify-center bg-black rounded-2xl py-3 px-5 shadow-xl border border-white/10 w-full max-w-[180px] transition-all duration-300">
            <img
              src="/new-logo.png?v=2"
              alt="ARC AI Logo"
              className="w-full h-auto object-contain shrink-0"
            />
          </div>
        )}
      </div>

      {/* Navigation menu — scrolls independently so growing menus never push
          the profile/logout footer off-screen. `min-h-0` lets this flex child
          shrink below its content height so `overflow-y-auto` can engage. */}
      <nav
        className={cn(
          "mt-8 min-h-0 flex-1 space-y-1.5 w-full overflow-y-auto overflow-x-hidden pb-2",
          isCollapsed ? "px-0" : "",
        )}
      >
        {!isCollapsed ? (
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
            Workspace
          </p>
        ) : (
          <div className="h-px bg-white/10 my-4 mx-2" />
        )}
        {NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.href)}
            onNavigate={onNavigate}
            isCollapsed={isCollapsed}
          />
        ))}

        {profile.role === "admin" && (
          <>
            {!isCollapsed ? (
              <p className="px-3 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                Admin
              </p>
            ) : (
              <div className="h-px bg-white/10 my-6 mx-2" />
            )}
            {ADMIN_NAV.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href)}
                onNavigate={onNavigate}
                isCollapsed={isCollapsed}
              />
            ))}
          </>
        )}
      </nav>

      {/* Footer profile & logout */}
      <div className="mt-4 border-t border-white/10 pt-4 w-full">
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-4">
            <Link
              href="/profile"
              onClick={onNavigate}
              title={profile.full_name || profile.username}
            >
              <Avatar
                name={profile.full_name}
                src={profile.avatar_url}
                size="sm"
                ring
              />
            </Link>
            <form action={signOutAction} className="w-full flex justify-center">
              <button
                type="submit"
                aria-label="Sign out"
                title="Sign out"
                className="grid h-10 w-10 place-items-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </form>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <Link
              href="/profile"
              onClick={onNavigate}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <Avatar
                name={profile.full_name}
                src={profile.avatar_url}
                size="sm"
                ring
              />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-white">
                  {profile.full_name || profile.username}
                </p>
                <p className="truncate text-xs capitalize text-white/55">
                  {profile.role}
                </p>
              </div>
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                aria-label="Sign out"
                className="grid h-9 w-9 place-items-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

