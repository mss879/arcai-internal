"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { LogOut } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Avatar } from "@/components/ui/avatar";
import { ADMIN_NAV, NAV, type NavItem } from "@/components/layout/nav";
import { signOutAction } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/types";

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        active ? "text-white" : "text-white/65 hover:text-white",
      )}
    >
      {active && (
        <motion.span
          layoutId="active-nav"
          className="absolute inset-0 rounded-xl bg-white/15 ring-1 ring-inset ring-white/10"
          transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
        />
      )}
      <item.icon className="relative h-[18px] w-[18px] shrink-0" />
      <span className="relative">{item.label}</span>
    </Link>
  );
}

export function Sidebar({
  profile,
  onNavigate,
}: {
  profile: Profile;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-full flex-col gradient-primary px-4 py-5">
      <div className="flex justify-center mb-6">
        <div className="flex items-center justify-center bg-black rounded-2xl p-5 shadow-xl border border-white/10 w-full max-w-[180px] aspect-square">
          <img
            src="/new-logo.png"
            alt="ARC AI Logo"
            className="w-full h-full object-contain shrink-0"
          />
        </div>
      </div>

      <nav className="mt-8 flex-1 space-y-1">
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
          Workspace
        </p>
        {NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.href)}
            onNavigate={onNavigate}
          />
        ))}

        {profile.role === "admin" && (
          <>
            <p className="px-3 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
              Admin
            </p>
            {ADMIN_NAV.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href)}
                onNavigate={onNavigate}
              />
            ))}
          </>
        )}
      </nav>

      <div className="mt-4 border-t border-white/10 pt-4">
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
              <p className="truncate text-sm font-semibold text-white">
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
              className="grid h-8 w-8 place-items-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
