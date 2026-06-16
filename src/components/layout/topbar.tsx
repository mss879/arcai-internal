"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import { titleForPath } from "@/components/layout/nav";
import { GlobalSearch } from "@/components/layout/global-search";
import type { Notification, Profile } from "@/lib/types";

export function Topbar({
  profile,
  notifications,
  onOpenMobile,
}: {
  profile: Profile;
  notifications: Notification[];
  onOpenMobile: () => void;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200/70 bg-white/70 px-4 backdrop-blur-xl sm:px-6">
      <button
        onClick={onOpenMobile}
        aria-label="Open menu"
        className="grid h-10 w-10 place-items-center rounded-xl text-slate-600 hover:bg-slate-100 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="text-lg font-semibold text-slate-900">
        {titleForPath(pathname)}
      </h1>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <GlobalSearch />

        <NotificationsBell initial={notifications} />

        <Link
          href="/profile"
          className="ml-0.5 rounded-full ring-2 ring-transparent transition hover:ring-primary-200"
        >
          <Avatar name={profile.full_name} src={profile.avatar_url} size="md" />
        </Link>
      </div>
    </header>
  );
}

