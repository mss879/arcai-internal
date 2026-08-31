import {
  BadgeDollarSign,
  BriefcaseBusiness,
  BarChart3,
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
  PackageCheck,
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
  /** Hidden from members; the route must also gate itself server-side. */
  adminOnly?: boolean;
};

export type NavGroup = {
  /** The section heading, and the key its collapsed state is stored under. */
  label: string;
  items: NavItem[];
};

/**
 * The three pages opened many times a day.
 *
 * Ungrouped, above everything, never collapsible. A menu is a tool for
 * finding what you do NOT visit often; what you visit constantly should
 * never sit behind a fold.
 */
export const PINNED_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "To-Dos", href: "/todos", icon: ListChecks },
  { label: "Projects", href: "/projects", icon: FolderKanban },
];

/**
 * Everything else, grouped by the job being done rather than by the feature
 * that implements it.
 *
 * Two placements that a database diagram would get wrong:
 *
 *   Notice Generation sits under Money because a notice is the prose sibling
 *   of an invoice — same letterhead, same numbering, a written message where
 *   the line items would be (see @/lib/notice). It is a document you send to
 *   get paid, not a marketing tool, whatever the megaphone icon suggests.
 *
 *   Website Progress sits under Clients & Delivery because it tracks the
 *   builds of CLIENT sites. The agency's own site is Web Analytics, under
 *   Insights. Those two have never been the same thing and the old flat menu
 *   listed them four apart, which is exactly how you end up in the wrong one.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Sales",
    items: [
      { label: "CRM Pipeline", href: "/crm", icon: KanbanSquare },
      { label: "Proposals", href: "/proposals", icon: ScrollText },
      { label: "Pricing", href: "/pricing", icon: BadgeDollarSign },
    ],
  },
  {
    label: "Clients & Delivery",
    items: [
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Client Delivery", href: "/delivery", icon: PackageCheck },
      { label: "Website Progress", href: "/website-progress", icon: Globe },
      { label: "Meetings", href: "/meetings", icon: CalendarClock },
    ],
  },
  {
    label: "Money",
    items: [
      { label: "Money & Finance", href: "/finance", icon: Landmark },
      { label: "Invoices & Quotes", href: "/invoices", icon: FileText },
      { label: "Payments", href: "/payments", icon: CreditCard },
      { label: "Notice Generation", href: "/notices", icon: Megaphone },
    ],
  },
  {
    label: "Marketing & Outreach",
    items: [
      { label: "Content Studio", href: "/content", icon: Sparkles },
      { label: "SMS", href: "/sms", icon: MessageSquareText },
      { label: "WhatsApp", href: "/whatsapp", icon: MessageCircle },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        // The agency's own website (arcai.agency), mirrored from its own
        // Supabase project.
        label: "Web Analytics",
        href: "/web-analytics",
        icon: BarChart3,
        adminOnly: true,
      },
      {
        // The CRM's internal signals and the snippet on client sites.
        label: "AI & Intelligence",
        href: "/intelligence",
        icon: BrainCircuit,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      { label: "Automation", href: "/automation", icon: Zap },
      {
        // Hiring for arcai.agency: roles are written here and published to
        // the website, applications come back into a pipeline. Admin-only —
        // every row is a named person's CV and contact details.
        label: "Careers",
        href: "/careers",
        icon: BriefcaseBusiness,
        adminOnly: true,
      },
      { label: "Resources", href: "/resources", icon: FolderOpen },
      // Was its own one-item "Admin" section pinned to the bottom of the
      // sidebar. `adminOnly` is what hides it now that the section is gone —
      // dropping this flag would show every member the team's access list.
      { label: "Team & Access", href: "/team", icon: ShieldCheck, adminOnly: true },
    ],
  },
];

/**
 * Every navigable page, flat, in menu order.
 *
 * DERIVED, never hand-maintained — a page added to a group appears here
 * automatically. Five other places read this: the topbar's title lookup, the
 * assistant's `open_app_page` tool and app-map, the composer's area picker,
 * the thread rail and the preview canvas. Grouping is a sidebar concern and
 * none of them should have to know about it, which is why this export keeps
 * exactly the shape it always had.
 */
export const NAV: NavItem[] = [
  ...PINNED_NAV,
  ...NAV_GROUPS.flatMap((group) => group.items),
];

/** Resolve the page title for a given pathname. */
export function titleForPath(pathname: string): string {
  const all = [...NAV, { label: "My Profile", href: "/profile" }];
  const match = all
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "Workspace";
}

/**
 * Which group a path lives in, so the sidebar can open that group on arrival.
 *
 * Returns null for the pinned three and for anything not in the menu at all
 * (a profile page, a public token route) — in both cases there is no group to
 * open, which is the correct answer rather than a missing case.
 */
export function groupForPath(pathname: string): string | null {
  for (const group of NAV_GROUPS) {
    const hit = group.items.some(
      (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
    );
    if (hit) return group.label;
  }
  return null;
}
