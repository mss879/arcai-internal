"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { NavLoadingIndicator } from "@/components/layout/nav-loading-indicator";
import {
  NAV_GROUPS,
  PINNED_NAV,
  groupForPath,
  type NavItem,
} from "@/components/layout/nav";
import { signOutAction } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/types";

/**
 * Which groups this viewer has folded away, remembered in their browser.
 *
 * A tiny external store rather than `useState` + an effect that reads
 * localStorage. The obvious version — initialise from storage during render —
 * cannot work: the server has no localStorage, so the two renders disagree
 * and React throws a hydration error. Loading it in an effect instead fixes
 * that but makes the sidebar render twice on every mount.
 *
 * `useSyncExternalStore` is what React provides for exactly this shape:
 * a value that lives outside React, has a defined server snapshot, and
 * changes on its own terms.
 */
const NAV_STATE_KEY = "arc_nav_groups";

/** Cached so `getSnapshot` returns a stable string; React re-reads on notify. */
let navSnapshot: string | null = null;
const navListeners = new Set<() => void>();

function getNavSnapshot(): string {
  if (navSnapshot === null) {
    try {
      navSnapshot = window.localStorage.getItem(NAV_STATE_KEY) ?? "{}";
    } catch {
      navSnapshot = "{}";
    }
  }
  return navSnapshot;
}

/** On the server nothing is folded, which is also the safe default. */
function getNavServerSnapshot(): string {
  return "{}";
}

function subscribeNav(onChange: () => void): () => void {
  navListeners.add(onChange);
  return () => {
    navListeners.delete(onChange);
  };
}

function writeNavState(state: Record<string, boolean>): void {
  navSnapshot = JSON.stringify(state);
  try {
    window.localStorage.setItem(NAV_STATE_KEY, navSnapshot);
  } catch {
    // A preference that cannot be saved is not worth an exception — the
    // sidebar still works, it just forgets between visits.
  }
  for (const notify of navListeners) notify();
}

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
        "relative flex items-center rounded-xl transition-all duration-300 ease-in-out font-semibold text-[13.5px]",
        isCollapsed 
          ? "justify-center h-12 w-12 mx-auto px-0 gap-0" 
          : "px-4 py-2.5",
        active 
          ? "text-white" 
          : "text-white hover:bg-white/10",
      )}
    >
      {active && (
        <span className="absolute inset-0 rounded-xl bg-white/15 ring-1 ring-inset ring-white/10" />
      )}
      <item.icon className={cn("relative shrink-0 transition-all duration-300", isCollapsed ? "h-6 w-6" : "h-5 w-5")} />

      <span
        className={cn(
          "relative inline-block overflow-hidden whitespace-nowrap transition-all duration-200 ease-in-out",
          isCollapsed ? "ml-0 max-w-0 opacity-0" : "ml-3 max-w-[160px] opacity-100",
        )}
      >
        {item.label}
      </span>

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

  const currentGroup = groupForPath(pathname ?? "");

  const rawNavState = React.useSyncExternalStore(
    subscribeNav,
    getNavSnapshot,
    getNavServerSnapshot,
  );
  const storedGroups = React.useMemo<Record<string, boolean>>(() => {
    try {
      return JSON.parse(rawNavState) as Record<string, boolean>;
    } catch {
      // Storage holding something unparseable — every group stays open,
      // which is the old behaviour and perfectly usable.
      return {};
    }
  }, [rawNavState]);

  /**
   * The group that navigation has just opened.
   *
   * Arriving on a page inside a folded group should reveal it — being unable
   * to see where you are is worse than losing a fold you chose. This is React's
   * sanctioned "adjust state during render" pattern rather than an effect,
   * which would render the sidebar twice on every navigation.
   *
   * It is deliberately separate from the stored state: it opens the group
   * WITHOUT overwriting the viewer's saved preference, so folding it again
   * while standing on that page sticks rather than springing back open.
   */
  const [revealed, setRevealed] = React.useState<string | null>(currentGroup);
  const [lastGroup, setLastGroup] = React.useState<string | null>(currentGroup);
  if (currentGroup !== lastGroup) {
    setLastGroup(currentGroup);
    setRevealed(currentGroup);
  }

  const toggleGroup = (label: string) => {
    const open = revealed === label || (storedGroups[label] ?? true);
    // Closing the group you are standing in has to clear the reveal too, or
    // it reopens on the very next render.
    if (open && revealed === label) setRevealed(null);
    writeNavState({ ...storedGroups, [label]: !open });
  };

  return (
    <div
      className={cn(
        // Flat primary-700 rather than the shared `gradient-primary` utility:
        // the darker bottom of that gradient is the colour we want for the
        // whole rail. The utility itself is left alone — twelve other places
        // (the dashboard hero, the auth shell, assistant buttons) still want
        // the gradient.
        "relative flex h-full flex-col bg-primary-700 py-5 transition-all duration-300 ease-in-out border-r border-white/10",
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
            <Image
              src="/new-logo.png"
              alt="ARC AI Logo"
              width={1310}
              height={360}
              sizes="180px"
              priority
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
        {/* The three most-visited pages, above every group and never folded. */}
        {PINNED_NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.href)}
            onNavigate={onNavigate}
            isCollapsed={isCollapsed}
          />
        ))}

        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(
            (item) => !item.adminOnly || profile.role === "admin",
          );
          // A group whose every item is admin-only disappears entirely for a
          // member rather than leaving an empty heading behind.
          if (!items.length) return null;

          // Collapsed rail: icons only, so a heading has nowhere to go. A
          // hairline keeps the grouping legible without one.
          if (isCollapsed) {
            return (
              <div key={group.label}>
                <div className="h-px bg-white/10 my-3 mx-2" />
                {items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item.href)}
                    onNavigate={onNavigate}
                    isCollapsed
                  />
                ))}
              </div>
            );
          }

          const open =
            revealed === group.label || (storedGroups[group.label] ?? true);
          const holdsCurrentPage = group.label === currentGroup;

          return (
            <div key={group.label} className="pt-3 first:pt-0">
              {/* slate-100, not a softer grey. On this flat primary-700 the
                  greys below it fall off a cliff — slate-200 is 4.20:1,
                  slate-300 is 3.49:1, white/70 is 3.29:1, and the original
                  white/40 was 1.5:1, which is why these were unreadable.
                  slate-100 is 4.73:1: the lightest grey that still clears
                  AA, and visibly grey against the white menu items. */}
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={open}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-100 transition-colors hover:bg-white/10 hover:text-white"
              >
                <span>{group.label}</span>
                <span className="flex items-center gap-1.5">
                  {/* A dot when a folded group holds the page you are on, so
                      the sidebar never hides where you actually are. */}
                  {!open && holdsCurrentPage && (
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-100" aria-hidden />
                  )}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      open ? "rotate-0" : "-rotate-90",
                    )}
                    aria-hidden
                  />
                </span>
              </button>

              {open && (
                <div className="mt-1 space-y-1.5">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item.href)}
                      onNavigate={onNavigate}
                      isCollapsed={false}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
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

