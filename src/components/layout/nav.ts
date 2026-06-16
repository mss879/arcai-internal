import {
  CalendarClock,
  FolderKanban,
  FolderOpen,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Clients", href: "/clients", icon: Users },
  { label: "To-Dos", href: "/todos", icon: ListChecks },
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "CRM Pipeline", href: "/crm", icon: KanbanSquare },
  { label: "Meetings", href: "/meetings", icon: CalendarClock },
  { label: "Resources", href: "/resources", icon: FolderOpen },
];

export const ADMIN_NAV: NavItem[] = [
  { label: "Team & Access", href: "/team", icon: ShieldCheck },
];

/** Resolve the page title for a given pathname. */
export function titleForPath(pathname: string): string {
  const all = [...NAV, ...ADMIN_NAV, { label: "My Profile", href: "/profile" }];
  const match = all
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "Workspace";
}
