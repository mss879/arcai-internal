import {
  BadgeDollarSign,
  BrainCircuit,
  CalendarClock,
  CreditCard,
  FileText,
  FolderKanban,
  FolderOpen,
  Globe,
  KanbanSquare,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
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
  { label: "Website Progress", href: "/website-progress", icon: Globe },
  { label: "CRM Pipeline", href: "/crm", icon: KanbanSquare },
  { label: "Automation", href: "/automation", icon: Zap },
  { label: "Money & Finance", href: "/finance", icon: Landmark },
  { label: "AI & Intelligence", href: "/intelligence", icon: BrainCircuit },
  { label: "Meetings", href: "/meetings", icon: CalendarClock },
  { label: "Payments", href: "/payments", icon: CreditCard },
  { label: "Invoices & Quotes", href: "/invoices", icon: FileText },
  { label: "Notice Generation", href: "/notices", icon: Megaphone },
  { label: "Proposals", href: "/proposals", icon: ScrollText },
  { label: "Pricing", href: "/pricing", icon: BadgeDollarSign },
  { label: "SMS", href: "/sms", icon: MessageSquareText },
  { label: "WhatsApp", href: "/whatsapp", icon: MessageCircle },
  { label: "Content Studio", href: "/content", icon: Sparkles },
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
