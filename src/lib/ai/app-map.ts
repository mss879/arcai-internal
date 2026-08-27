/**
 * Arc's map of its own product.
 *
 * The assistant has always been able to *do* things in the workspace; it has
 * never been able to say where those things live, or open the page it just
 * talked about. Two questions kept coming back — "what can you actually do?"
 * and "just show me" — and neither is answerable from a pile of tool schemas,
 * because a schema is written for a model, not for a person.
 *
 * So the product describes itself here, once: every navigable area with its
 * real route, the phrases a human uses for it ("the pipeline", "money",
 * "invoices"), and the honest list of what Arc can do once it is there. The
 * capability list is derived from the tools that exist in
 * `@/lib/ai/tools`, `@/lib/ai/tools-finance`, `@/lib/ai/tools-delivery`,
 * `@/lib/ai/tools-growth` and `@/lib/ai/tools-nav` — never from what the
 * product wishes it could do. An advertised capability with no tool behind it
 * is a promise the assistant will break in front of the user.
 *
 * Deliberately framework-free and server-safe — no React, no "server-only" —
 * because both the nav tools on the server and the assistant workspace in the
 * browser need the same map. `src/components/layout/nav.ts` stays the source
 * of truth for the sidebar itself; this file mirrors it plus the sub-routes
 * the sidebar has no room for.
 */

import type { AppArea } from "@/lib/assistant-artifacts";

/** One navigable place in the product. */
export type AppAreaEntry = {
  /** Drives the artifact's icon and accent. Shared by an area's sub-routes. */
  area: AppArea;
  /** The name the product itself uses, e.g. "Money & Finance". */
  label: string;
  /** The real in-app route. Unique across APP_AREAS. */
  href: string;
  /** What you can do there, in one sentence, for a human. */
  blurb: string;
  /** Lucide icon name, matching what the UI already renders for this route. */
  icon: string;
  /** Hidden from members; the route gates itself server-side as well. */
  adminOnly?: boolean;
  /**
   * The other things people call this page. Matched by `resolveAreaPath`, so
   * "the pipeline" and "money" land somewhere sensible instead of nowhere.
   */
  aliases: string[];
};

/**
 * Every area of the product, sidebar order first, then the sub-routes that
 * live inside a section. Order matters: earlier entries win a tie in
 * `resolveAreaPath`, which keeps a section's landing page ahead of its
 * children ("projects" opens the board, not the templates page).
 */
export const APP_AREAS: AppAreaEntry[] = [
  {
    area: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    blurb:
      "The morning read on the whole agency — today's to-dos, what is overdue, money in and out this month, the next meetings and anything that needs a decision.",
    icon: "LayoutDashboard",
    aliases: ["home", "overview", "front page", "start", "summary", "snapshot"],
  },
  {
    area: "clients",
    label: "Clients",
    href: "/clients",
    blurb:
      "The client directory — who they are, how to reach them, and everything the agency has done for them.",
    icon: "Users",
    aliases: ["customers", "accounts", "client list", "directory", "contacts"],
  },
  {
    area: "todos",
    label: "To-Dos",
    href: "/todos",
    blurb:
      "Every task the team owes, as a list or a board, with owners, priorities and due dates.",
    icon: "ListChecks",
    aliases: ["tasks", "todo", "to do", "my tasks", "checklist", "reminders"],
  },
  {
    area: "projects",
    label: "Projects",
    href: "/projects",
    blurb:
      "The client work itself — the board of live projects, each with its budget, costs, payments, milestones, tasks and client portal.",
    icon: "FolderKanban",
    aliases: ["jobs", "builds", "work", "project board", "the board", "engagements"],
  },
  {
    area: "delivery",
    label: "Client Delivery",
    href: "/delivery",
    blurb:
      "The delivery pipeline every project walks — assets in, build, review, launch — with the WhatsApp onboarding agent, chasers and stalled-project alerts.",
    icon: "PackageCheck",
    aliases: [
      "delivery pipeline",
      "onboarding",
      "handover",
      "stages",
      "delivery board",
      "assets",
    ],
  },
  {
    area: "website",
    label: "Website Progress",
    href: "/website-progress",
    blurb:
      "Build progress on each website, tracked section by section so a client can see how far along their site is.",
    icon: "Globe",
    aliases: ["websites", "site progress", "web builds", "site build"],
  },
  {
    area: "crm",
    label: "CRM Pipeline",
    href: "/crm",
    blurb:
      "The sales pipeline — every lead as a card on a stage, with its value, owner, score, activity history and AI next action.",
    icon: "KanbanSquare",
    aliases: [
      "pipeline",
      "leads",
      "sales",
      "deals",
      "sales pipeline",
      "prospects",
      "opportunities",
      "funnel",
    ],
  },
  {
    area: "crm",
    label: "Companies",
    href: "/crm/companies",
    blurb: "Leads grouped by the company behind them, so several contacts read as one account.",
    icon: "Building2",
    aliases: ["organisations", "organizations", "accounts list", "firms", "businesses"],
  },
  {
    area: "crm",
    label: "Find Leads",
    href: "/crm/prospecting",
    blurb:
      "The area-scan prospector — sweep a place and a trade, find businesses with no website or a bad one, and import them as leads with a cold draft attached.",
    icon: "Radar",
    aliases: [
      "prospecting",
      "find leads",
      "lead finder",
      "area scan",
      "scan",
      "new leads",
      "cold leads",
    ],
  },
  {
    area: "crm",
    label: "Prospect Research",
    href: "/crm/research",
    blurb:
      "Deep research on one lead — their site, their business and their gaps — written up as a briefing before you call.",
    icon: "ScanSearch",
    aliases: ["research", "lead research", "briefing", "background", "dossier"],
  },
  {
    area: "crm",
    label: "Email campaigns",
    href: "/crm/outreach",
    blurb:
      "Cold email outreach — AI-written first mails, approve-then-send or auto-send, run one lead at a time or as a bulk campaign.",
    icon: "Send",
    aliases: ["outreach", "cold email", "email campaign", "campaigns", "mail merge"],
  },
  {
    area: "automation",
    label: "Automation",
    href: "/automation",
    blurb:
      "The flows that run without you — a trigger, then steps: send, wait, move, assign, notify — plus the recipes you can install as-is.",
    icon: "Zap",
    aliases: ["automations", "flows", "workflows", "triggers", "recipes", "rules"],
  },
  {
    area: "finance",
    label: "Money & Finance",
    href: "/finance",
    blurb:
      "The books — cash in, cash out, profit by month, the expense ledger, recurring income, payment plans and cheques.",
    icon: "Landmark",
    aliases: [
      "money",
      "finance",
      "financials",
      "profit",
      "cash",
      "expenses",
      "bookkeeping",
      "p&l",
      "revenue",
    ],
  },
  {
    area: "payments",
    label: "Payments",
    href: "/payments",
    blurb: "The payments board — what each company owes, what has been settled, and what is late.",
    icon: "CreditCard",
    aliases: ["owed", "receivables", "outstanding", "debtors", "who owes us", "collections"],
  },
  {
    area: "invoices",
    label: "Invoices & Quotes",
    href: "/invoices",
    blurb:
      "Write an invoice or a quote, keep every past one, and send it to the client as the branded PDF they expect.",
    icon: "FileText",
    aliases: ["invoice", "invoices", "bill", "billing", "receivable"],
  },
  {
    area: "invoices",
    label: "Quotes",
    // The Quotes tab of the same page. `/quotes` redirects here, but a
    // redirect loses the preview pane's own query string, so link direct.
    href: "/invoices?tab=quotes",
    blurb:
      "Quotes sent to clients — what was offered, whether it was accepted, and the invoice it turned into.",
    icon: "FileText",
    aliases: ["quote", "quotes", "quotation", "estimate", "quotations"],
  },
  {
    area: "meetings",
    label: "Meetings",
    href: "/meetings",
    blurb:
      "The calendar — schedule a meeting, invite the client by SMS, and get a reminder one to five hours before.",
    icon: "CalendarClock",
    aliases: ["calendar", "meeting", "schedule", "appointments", "diary", "bookings", "calls"],
  },
  {
    area: "proposals",
    label: "Proposals",
    href: "/proposals",
    blurb:
      "Client proposals — the written pitch and the priced package, saved and downloadable as the branded PDF.",
    icon: "ScrollText",
    aliases: ["proposal", "pitch", "offer", "sow", "scope"],
  },
  {
    area: "pricing",
    label: "Pricing",
    href: "/pricing",
    blurb:
      "The live price list — every package, what it includes, and the price the team has set, which every proposal and quote reads from.",
    icon: "BadgeDollarSign",
    aliases: ["prices", "price list", "packages", "rates", "how much", "cost", "tariff"],
  },
  {
    area: "notices",
    label: "Notice Generation",
    href: "/notices",
    blurb:
      "Formal client notices, dictated and then written by AI in the shape of an invoice.",
    icon: "Megaphone",
    aliases: ["notice", "notices", "letter", "formal letter", "notification letter"],
  },
  {
    area: "sms",
    label: "SMS",
    href: "/sms",
    blurb:
      "Text messages to clients and leads — one-offs, payment reminders, promotions and the SMS flows that fire on their own.",
    icon: "MessageSquareText",
    aliases: ["text", "texts", "text message", "sms", "messages", "notify"],
  },
  {
    area: "whatsapp",
    label: "WhatsApp",
    href: "/whatsapp",
    blurb:
      "Every WhatsApp Business chat, answered by the AI sales agent — inbox, agent settings, campaign and cold outreach, keyword rules and analytics.",
    icon: "MessageCircle",
    aliases: ["wa", "whats app", "chat", "inbox", "wa inbox", "sales agent", "the agent"],
  },
  {
    area: "content",
    label: "Content Studio",
    href: "/content",
    blurb:
      "Marketing content — generate posts and carousels, plan them on a calendar, and keep the references the AI writes from.",
    icon: "Sparkles",
    aliases: ["content", "posts", "social", "marketing", "carousel", "studio", "captions"],
  },
  {
    area: "resources",
    label: "Resources",
    href: "/resources",
    blurb: "The shared shelf — links, files and references the team keeps for reuse.",
    icon: "FolderOpen",
    aliases: ["files", "documents", "links", "library", "docs", "shelf"],
  },
  {
    area: "projects",
    label: "Project insights",
    href: "/projects/insights",
    blurb:
      "The AI layer over delivery — what needs you right now, and a place to ask anything about the projects in plain English.",
    icon: "Sparkles",
    aliases: ["insights", "risk", "at risk", "ai insights", "project ai", "what needs attention"],
  },
  {
    area: "projects",
    label: "Project reports",
    href: "/projects/reports",
    blurb:
      "What the numbers say about the work — profit per project, estimate accuracy, workload, timeline and cycle time.",
    icon: "BarChart3",
    aliases: ["reports", "project profit", "margins", "workload", "cycle time", "estimates"],
  },
  {
    area: "projects",
    label: "Project templates",
    href: "/projects/templates",
    blurb: "The plan a new project starts from — the standing task and milestone list per service.",
    icon: "Layers",
    aliases: ["templates", "project template", "starter plan", "blueprints"],
  },
  {
    area: "intelligence",
    label: "AI & Intelligence",
    href: "/intelligence",
    blurb:
      "The agency's own radar — the daily digest, churn alerts, ad and competitor tracking, website visitors and the AI toolkit.",
    icon: "BrainCircuit",
    adminOnly: true,
    // No bare "ai" or "ads": both are words people use about everything else
    // in this app, and a wrong page opens silently.
    aliases: [
      "intelligence",
      "ai digest",
      "daily digest",
      "churn",
      "competitors",
      "ad tracking",
      "website visitors",
      "ai toolkit",
    ],
  },
  {
    area: "team",
    label: "Team & Access",
    href: "/team",
    blurb:
      "The team — members and their access, trusted devices, the login and change log, commissions and loans.",
    icon: "ShieldCheck",
    adminOnly: true,
    aliases: ["team", "staff", "members", "people", "access", "permissions", "colleagues", "users"],
  },
  {
    area: "workspace",
    label: "My Profile",
    href: "/profile",
    blurb: "Your own details, your trusted devices and your sign-in history.",
    icon: "UserRound",
    aliases: ["profile", "me", "my account", "my details", "settings", "my devices"],
  },
];

// ---- Resolving a phrase or a path to a place -----------------------------

/**
 * Route shapes that carry an id. `open_record` builds these, and
 * `resolveAppHref` accepts them so a deep link survives the round trip
 * instead of collapsing to its section's landing page.
 */
const DYNAMIC_ROUTE_PREFIXES: { prefix: string; area: AppArea }[] = [
  { prefix: "/crm/lead/", area: "crm" },
  { prefix: "/projects/", area: "projects" },
  { prefix: "/meetings/", area: "meetings" },
  { prefix: "/team/", area: "team" },
];

/**
 * Real routes that exist only to redirect. Resolved to where they land: a
 * 302 would drop the preview pane's own query string and the page would come
 * back wearing the sidebar it was embedded to hide.
 */
const PATH_ALIASES: Record<string, string> = {
  "/quotes": "/invoices?tab=quotes",
};

/** Lowercase, punctuation-free, with the words people pad a request with removed. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9/&\s]/g, " ")
    .replace(
      /\b(please|can you|could you|just|now|go to|open|show me|show|take me to|bring up|pull up|the|my|our|a|an|page|screen|section|tab|view)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** The path part of an href, without its query string. */
function pathOf(href: string): string {
  const q = href.indexOf("?");
  return q === -1 ? href : href.slice(0, q);
}

/**
 * Whether `needle` appears in `haystack` as a run of whole words.
 *
 * Plain substring matching is wrong here and quietly so: the alias "me" would
 * match "meetings", "money" and "team", and the user would be shown their own
 * profile because they asked about a meeting.
 */
function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * The area a user's phrase means, or null when nothing matches well enough.
 *
 * Accepts a route ("/crm", "/projects/insights"), the product's own label
 * ("Money & Finance"), or the words people actually use ("the pipeline",
 * "money", "invoices"). Never guesses: a phrase that matches nothing returns
 * null so the caller can say so rather than opening the wrong page.
 */
export function resolveAreaPath(input: string): AppAreaEntry | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // A route wins outright — including a deep link, which belongs to the
  // longest matching section (so /projects/reports beats /projects).
  if (raw.startsWith("/")) {
    const path = pathOf(raw).replace(/\/+$/, "") || "/";
    const byHref = APP_AREAS.filter((a) => {
      const p = pathOf(a.href);
      return p === path || path.startsWith(`${p}/`);
    }).sort((a, b) => pathOf(b.href).length - pathOf(a.href).length)[0];
    if (byHref) return byHref;
  }

  const q = normalize(raw);
  if (!q) return null;
  const qWords = q.split(" ").filter(Boolean);

  let best: { entry: AppAreaEntry; score: number } | null = null;
  for (const entry of APP_AREAS) {
    const terms = [entry.label, entry.href.replace(/^\//, "").replace(/\//g, " "), ...entry.aliases];
    let score = 0;
    for (const term of terms) {
      const t = normalize(term);
      if (!t) continue;
      const tWords = t.split(" ").filter(Boolean);
      // Exact beats "the phrase is in there somewhere", and a longer overlap
      // beats a shorter one — so "prospect research" is not lost to "research".
      if (t === q) score = Math.max(score, 1000 + t.length);
      else if (containsWords(qWords, tWords)) score = Math.max(score, 100 + t.length * 2);
      else if (containsWords(tWords, qWords)) score = Math.max(score, 50 + q.length);
    }
    // Ties keep APP_AREAS order, which puts a section's landing page ahead of
    // its children — "projects" opens the board, not the templates.
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }

  return best?.entry ?? null;
}

/** A place to open: the exact route, and the area it belongs to. */
export type AppLocation = { href: string; entry: AppAreaEntry };

/**
 * Where to send someone, from either a phrase or a route.
 *
 * Unlike `resolveAreaPath` this keeps a deep link intact — "/projects/<id>"
 * opens that project, not the board — and keeps a query string the caller
 * meant ("/invoices?tab=past"). Unknown routes return null rather than
 * navigating the preview pane to a 404.
 */
export function resolveAppHref(input: string): AppLocation | null {
  const raw = String(input ?? "").trim();

  if (raw.startsWith("/")) {
    const path = pathOf(raw).replace(/\/+$/, "") || "/";
    const aliased = PATH_ALIASES[path];
    if (aliased) return resolveAppHref(aliased);
    // An href carrying a query wins on its full form; otherwise the section
    // that owns the path does, so "/invoices" is not lost to the Quotes tab.
    const exact =
      APP_AREAS.find((a) => a.href === raw) ??
      APP_AREAS.find((a) => pathOf(a.href) === path);
    if (exact) return { href: raw, entry: exact };

    const dynamic = DYNAMIC_ROUTE_PREFIXES.filter(
      (d) => path.startsWith(d.prefix) && path.length > d.prefix.length,
    ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (dynamic) {
      // The record's own section is the right home for a deep link — the
      // board for a project, the pipeline for a lead.
      const section = dynamic.prefix.replace(/\/$/, "");
      const entry =
        APP_AREAS.find((a) => a.href === section) ??
        APP_AREAS.find((a) => a.area === dynamic.area);
      if (entry) return { href: raw, entry };
    }
    return null;
  }

  const entry = resolveAreaPath(raw);
  return entry ? { href: entry.href, entry } : null;
}

// ---- What Arc can actually do, area by area ------------------------------

/** One thing Arc can do, written the way a person would ask for it. */
export type Capability = {
  /** The capability itself, in plain words. */
  label: string;
  /** Something a user could literally say to get it. */
  example: string;
  /**
   * `read` looks something up. `write` changes the workspace. `confirm`
   * prepares something that leaves the building (an email, an SMS) and stops
   * for a human to press Send — Arc never sends it itself.
   */
  kind: "read" | "write" | "confirm";
  /** The tools behind it. Every name here must exist in a tool module. */
  tools: string[];
};

/**
 * What Arc can do in each area — the honest answer to "what can you do?".
 *
 * Every entry is backed by tools that exist today. Areas Arc can open but not
 * yet act in (Content Studio, Resources, Website Progress) say so by carrying
 * only the capabilities that are real, which is the point: an empty-ish list
 * is information, and a fabricated one is a lie the user finds out about the
 * hard way.
 */
export const CAPABILITY_CATALOG: Record<AppArea, Capability[]> = {
  dashboard: [
    {
      label: "Read the whole workspace at a glance",
      example: "What's on my plate today?",
      kind: "read",
      tools: ["get_workspace_overview"],
    },
    {
      label: "Read your own notification bell — what you missed, unread first",
      example: "What did I miss?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Take on a whole multi-step errand — you approve the plan, then it works",
      example: "Chase every overdue invoice",
      kind: "confirm",
      tools: ["propose_mission", "mission_status", "control_mission"],
    },
    {
      label: "Remember how you work, and tell you what it remembers",
      example: "Remember I always give Silva 10% off",
      kind: "write",
      tools: ["remember", "forget", "list_memories"],
    },
    {
      label: "Find anything by name across clients, tasks, projects, leads and meetings",
      example: "Find everything about Silverline",
      kind: "read",
      tools: ["search_workspace"],
    },
    {
      label: "Open any page of the app in the pane beside this conversation",
      example: "Show me the pipeline",
      kind: "read",
      tools: ["open_app_page", "open_record"],
    },
  ],
  clients: [
    {
      label: "List and search clients",
      example: "Who are our clients in Kandy?",
      kind: "read",
      tools: ["list_clients", "search_workspace"],
    },
    {
      label: "Add a client",
      example: "Add Ceylon Spice as a client, email hello@ceylonspice.lk",
      kind: "write",
      tools: ["create_client"],
    },
    {
      label: "Edit a client's details",
      example: "Change Ceylon Spice's phone to 077 123 4567",
      kind: "write",
      tools: ["update_client"],
    },
    {
      label: "Open one client's record",
      example: "Pull up Ceylon Spice",
      kind: "read",
      tools: ["open_record"],
    },
  ],
  todos: [
    {
      label: "List what is open, overdue or yours",
      example: "What's overdue this week?",
      kind: "read",
      tools: ["list_todos"],
    },
    {
      label: "Add a task and assign it",
      example: "Add a task for Kamal to send the logo files by Friday",
      kind: "write",
      tools: ["create_todo", "list_team_members"],
    },
    {
      label: "Set yourself a reminder",
      example: "Remind me to call the bank on Monday",
      kind: "write",
      tools: ["create_reminder"],
    },
    {
      label: "Mark a task done or in progress",
      example: "Mark the logo files task done",
      kind: "write",
      tools: ["update_todo_status"],
    },
  ],
  projects: [
    {
      label: "Seed a project from a saved template — tasks, milestones, checks in one go",
      example: "Set up the Silva project from the website template",
      kind: "write",
      tools: ["apply_project_template"],
    },
    {
      label: "Everything about one project in a single read",
      example: "How is Ceylon Spice going?",
      kind: "read",
      tools: ["project_dossier"],
    },
    {
      label: "List projects and open one",
      example: "Show me the Ceylon Spice project",
      kind: "read",
      tools: ["list_projects", "delivery_query", "open_record"],
    },
    {
      label: "Start a project for a client",
      example: "Start a website project for Ceylon Spice at 450,000",
      kind: "write",
      tools: ["create_project"],
    },
    {
      label: "Record money in and costs out against a project",
      example: "Ceylon Spice paid 150,000 as the deposit",
      kind: "write",
      tools: ["record_project_payment", "log_project_expense"],
    },
    {
      label: "Move a project along its delivery stage, firing the same automations the board does",
      example: "Move Ceylon Spice to review",
      kind: "write",
      tools: ["move_project_stage"],
    },
    {
      label: "Add a task to a project, or log hours against it",
      example: "Log 3 hours on the Ceylon Spice build",
      kind: "write",
      tools: ["add_project_task", "log_project_time"],
    },
    {
      label: "Mark a project blocked on someone else, or clear the block",
      example: "Ceylon Spice is blocked — the client hasn't sent the logo",
      kind: "write",
      tools: ["set_project_blocked"],
    },
    {
      label: "See what is at risk, with the reason",
      example: "What should I worry about this week?",
      kind: "read",
      tools: ["projects_at_risk"],
    },
    {
      label: "List milestones, tasks, hours, approvals, change requests or client comments",
      example: "What milestones are due in October?",
      kind: "read",
      tools: ["delivery_query"],
    },
    {
      label: "Who is busiest, how long each stage really takes, what a service type usually costs",
      example: "Who is over-running their hours?",
      kind: "read",
      tools: ["delivery_reports"],
    },
    {
      label: "Ask anything analytical about the work",
      example: "Which project spent the most on hosting this year?",
      kind: "read",
      tools: ["ask_projects"],
    },
  ],
  delivery: [
    {
      label: "The whole pipeline at once — what sits in each stage, and what is stuck",
      example: "What's stuck in delivery?",
      kind: "read",
      tools: ["delivery_board"],
    },
    {
      label: "Move a project to its next delivery stage, deposit gate and launch checklist respected",
      example: "Ceylon Spice is ready for launch",
      kind: "write",
      tools: ["move_project_stage"],
    },
    {
      label: "Check a client's asset checklist and what is still missing",
      example: "What's missing from the Ceylon Spice checklist?",
      kind: "read",
      tools: ["delivery_query", "project_dossier"],
    },
    {
      label: "Stand the chaser and the stalled alert down while a job waits on a client",
      example: "Mark Ceylon Spice blocked until they send the copy",
      kind: "write",
      tools: ["set_project_blocked"],
    },
    {
      label: "Tick a milestone or launch check off — its automations fire on their own",
      example: "Mark the design phase done on the Silva site",
      kind: "write",
      tools: ["complete_milestone"],
    },
  ],
  website: [
    {
      label: "Add or update a site on the progress board",
      example: "Track silvamotors.lk, in progress, 40%",
      kind: "write",
      tools: ["save_website_project"],
    },
    {
      label: "See which websites are in progress and which are waiting on the client",
      example: "Which websites are waiting on the client?",
      kind: "read",
      tools: ["delivery_query"],
    },
  ],
  crm: [
    {
      label:
        "Sweep a town for businesses that need a website and file them as leads (runs for minutes; drafts are parked, never sent)",
      example: "Find me 10 salons in Kandy",
      kind: "write",
      tools: ["find_leads_nearby"],
    },
    {
      label: "How the pipeline is doing — open value, win rate, what moved, the forecast",
      example: "How's the pipeline looking this month?",
      kind: "read",
      tools: ["pipeline_report"],
    },
    {
      label: "Preview who an email campaign would reach (nothing is sent)",
      example: "Who would a campaign to the salon leads hit?",
      kind: "read",
      tools: ["preview_campaign"],
    },
    {
      label: "Filter leads by stage, owner, score, source or keyword",
      example: "What's in the proposal stage?",
      kind: "read",
      tools: ["crm_query", "list_leads", "search_workspace"],
    },
    {
      label: "Find the deals nobody has touched",
      example: "Which leads are going cold?",
      kind: "read",
      tools: ["crm_query"],
    },
    {
      label: "Add a lead — live automations fire for it just as they would from the board",
      example: "Add a lead: Sunrise Bakery, 077 555 1234, worth 250,000",
      kind: "write",
      tools: ["create_lead"],
    },
    {
      label: "Edit a lead or move it between stages",
      example: "Move Sunrise Bakery to negotiation and set it to 300,000",
      kind: "write",
      tools: ["update_lead"],
    },
    {
      label: "Summarise a lead's history, suggest the next move, or draft a reply",
      example: "What should I do next with Sunrise Bakery?",
      kind: "read",
      tools: ["sales_assist"],
    },
    {
      label: "Score open leads hot, warm or cold",
      example: "Score the new leads so I know who to call",
      kind: "write",
      tools: ["score_leads"],
    },
    {
      label: "Read the prospect briefings, cold-email drafts, campaigns and area scans",
      example: "How many cold drafts are waiting for me?",
      kind: "read",
      tools: ["crm_query"],
    },
    {
      label: "Read the board's saved segments, custom fields and recurring scan schedules",
      example: "What saved views does the CRM have?",
      kind: "read",
      tools: ["crm_query"],
    },
    {
      label: "Add a follow-up task on a lead",
      example: "Task: call Nimal Thursday about the demo",
      kind: "write",
      tools: ["create_crm_task"],
    },
    {
      label: "Log a call, note or meeting on a lead's timeline",
      example: "Log that I called Silva — they want a demo Friday",
      kind: "write",
      tools: ["log_lead_activity"],
    },
    {
      label: "Open one lead's card",
      example: "Pull up Sunrise Bakery",
      kind: "read",
      tools: ["open_record"],
    },
  ],
  automation: [
    {
      label: "See which flows are firing, and which runs failed",
      example: "Did any automation fail yesterday?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Browse the recipe gallery and which recipes are installed",
      example: "What automation recipes could I install?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Pause or resume a flow by name",
      example: "Pause the stalled-project chaser",
      kind: "write",
      tools: ["pause_automation", "resume_automation"],
    },
    {
      label: "Open the flows, their runs and the recipe shelf",
      example: "Show me the automations",
      kind: "read",
      tools: ["open_app_page"],
    },
  ],
  finance: [
    {
      label: "The month's cash in, cash out, profit and what is still to collect",
      example: "How did we do this month compared to last?",
      kind: "read",
      tools: ["finance_overview"],
    },
    {
      label: "List any finance record set — expenses, installments, cheques, recurring income, margins",
      example: "Show me every expense on ads this year",
      kind: "read",
      tools: ["finance_query"],
    },
    {
      label: "Log a cost in the expense ledger",
      example: "Log 45,000 for Facebook ads",
      kind: "write",
      tools: ["record_expense"],
    },
    {
      label: "Mark money as arrived — an installment, a cheque, a recurring month, a payments row",
      example: "The second installment for Ceylon Spice is paid",
      kind: "write",
      tools: ["mark_money_received"],
    },
    {
      label: "A team member's commission, loans and what they are still owed",
      example: "How much commission am I owed?",
      kind: "read",
      tools: ["member_money"],
    },
  ],
  payments: [
    {
      label: "See who owes what, and what is still outstanding",
      example: "How much does Ceylon Spice still owe us?",
      kind: "read",
      tools: ["list_payments", "finance_query"],
    },
    {
      label: "Settle a payments-board row",
      example: "Mark the Ceylon Spice payment as received",
      kind: "write",
      tools: ["mark_money_received"],
    },
  ],
  invoices: [
    {
      label: "Write and save an invoice from dictation, numbered automatically",
      example: "Create an invoice for Ceylon Spice, 120,000 for the website build",
      kind: "write",
      tools: ["create_invoice"],
    },
    {
      label: "Pull up a saved invoice or quote in full",
      example: "Show me invoice 00214",
      kind: "read",
      tools: ["get_finance_document", "finance_query"],
    },
    {
      label: "Prepare the email that sends an invoice — you press Send",
      example: "Email that invoice to their accounts address",
      kind: "confirm",
      tools: ["prepare_invoice_email"],
    },
    {
      label: "Create a numbered quote with line items — saved, never sent",
      example: "Quote Nimal 250,000 for the website and 45,000 for hosting",
      kind: "write",
      tools: ["create_quote"],
    },
  ],
  meetings: [
    {
      label: "The diary for a window — who is coming, where, and what clients booked themselves",
      example: "What meetings do I have this week?",
      kind: "read",
      tools: ["meetings_agenda", "list_meetings"],
    },
    {
      label: "Schedule a meeting on the board — online or in person, reminder armed",
      example: "Set a kickoff call with Sunrise Bakery tomorrow at 2, link meet.google.com/abc",
      kind: "write",
      tools: ["create_meeting"],
    },
    {
      label: "Reschedule or cancel a meeting",
      example: "Push the Ceylon Spice call to Thursday at 3",
      kind: "write",
      tools: ["reschedule_meeting", "cancel_meeting"],
    },
    {
      label: "Open one meeting",
      example: "Open the Ceylon Spice meeting",
      kind: "read",
      tools: ["open_record"],
    },
  ],
  notices: [
    {
      label: "Pull up a notice that was already written",
      example: "Show me the notice we sent Ceylon Spice",
      kind: "read",
      tools: ["get_finance_document", "finance_query"],
    },
    {
      label: "Write and file a formal notice from your rough words — saved, never sent",
      example: "Write a notice to Silva about the late payment",
      kind: "write",
      tools: ["create_notice"],
    },
  ],
  proposals: [
    {
      label: "List every saved proposal — who for, what's on it, the totals",
      example: "Show me all proposals from this month",
      kind: "read",
      tools: ["list_proposals"],
    },
    {
      label: "Open one proposal in full, line by line",
      example: "What did we quote Ceylon Spice?",
      kind: "read",
      tools: ["get_proposal", "open_record"],
    },
    {
      label: "Write and save a full proposal — AI narrative, priced from the live price list",
      example: "Write a proposal for Ceylon Spice for a smart business site",
      kind: "write",
      tools: ["create_proposal", "get_pricing"],
    },
    {
      label: "Revise a proposal you already have — price, package, extras or the words themselves",
      example: "Make that proposal 400,000 and add SEO setup",
      kind: "write",
      tools: ["update_proposal"],
    },
    {
      label: "Delete a proposal — after you confirm it",
      example: "Delete the old Silva proposal",
      kind: "write",
      tools: ["delete_proposal"],
    },
  ],
  pricing: [
    {
      label: "Read the live price list with the team's own edits applied",
      example: "What do we charge for an e-commerce build?",
      kind: "read",
      tools: ["get_pricing"],
    },
  ],
  sms: [
    {
      label: "Prepare a text to a client or lead — you press Send",
      example: "Text Ceylon Spice that the site goes live Friday",
      kind: "confirm",
      tools: ["prepare_sms"],
    },
    {
      label: "Prepare a payment reminder against an unpaid invoice — you press Send",
      example: "Send Ceylon Spice a reminder about their balance",
      kind: "confirm",
      tools: ["prepare_sms", "list_payments"],
    },
    {
      label: "Read what was already texted, and the multi-step sequences",
      example: "What SMS went out yesterday?",
      kind: "read",
      tools: ["growth_query", "conversation_history"],
    },
  ],
  whatsapp: [
    {
      label: "List the whole inbox — every thread, unread counts, who needs a human",
      example: "Show me the WhatsApp inbox",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Read the real thread with one person, the AI agent's replies included",
      example: "What did the agent say to Dilan?",
      kind: "read",
      tools: ["conversation_history"],
    },
    {
      label: "How the agent is doing — calls booked, reply speed, objections, who needs a human",
      example: "How many calls has the agent booked this month?",
      kind: "read",
      tools: ["whatsapp_report"],
    },
    {
      label: "How the agent is set up and what it has learned (admins)",
      example: "How is the WhatsApp agent configured?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Open the inbox, the agent's settings and its analytics",
      example: "Open WhatsApp",
      kind: "read",
      tools: ["open_app_page"],
    },
  ],
  content: [
    {
      label: "See what content was generated and which carousels are scheduled",
      example: "What content is scheduled this week?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Read the reference library the AI designs from",
      example: "What's in the content reference library?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Open the Content Studio — generation, the carousel calendar and references",
      example: "Open the content studio",
      kind: "read",
      tools: ["open_app_page"],
    },
  ],
  resources: [
    {
      label: "Search the shared shelf by name",
      example: "Find the brand guidelines file",
      kind: "read",
      tools: ["search_workspace", "delivery_query"],
    },
  ],
  intelligence: [
    {
      label: "Write this week's digest on demand (saved, notifies nobody)",
      example: "How did the business do this week?",
      kind: "write",
      tools: ["run_weekly_digest"],
    },
    {
      label: "Scan every client for churn risk and file alerts",
      example: "Which clients look like they're drifting?",
      kind: "write",
      tools: ["run_churn_scan"],
    },
    {
      label: "Read the weekly digest, churn alerts, competitors, ad ROAS and site traffic",
      example: "What does the latest digest say?",
      kind: "read",
      tools: ["growth_query"],
    },
    {
      label: "Open the intelligence area (admins only)",
      example: "Open AI and intelligence",
      kind: "read",
      tools: ["open_app_page"],
    },
  ],
  team: [
    {
      label: "List the team, to know who work can be assigned to",
      example: "Who's on the team?",
      kind: "read",
      tools: ["list_team_members"],
    },
    {
      label: "One member's whole picture — their leads, their tasks, their hours, their commission",
      example: "What's on Kamal's plate?",
      kind: "read",
      tools: ["team_report", "delivery_reports"],
    },
    {
      label: "A member's commission, loans and repayments",
      example: "What does Kamal still owe on his loan?",
      kind: "read",
      tools: ["member_money"],
    },
    {
      label: "Pending team invites and each member's trusted devices (admins)",
      example: "Which devices is Kasun signed in on?",
      kind: "read",
      tools: ["team_report"],
    },
    {
      label: "Open one member's page",
      example: "Open Kamal's page",
      kind: "read",
      tools: ["open_record"],
    },
  ],
  workspace: [
    {
      label: "Say what Arc can do, anywhere in the app",
      example: "What can you do?",
      kind: "read",
      tools: ["app_capabilities"],
    },
    {
      label: "Open any page or record in the pane beside this conversation",
      example: "Show me the finance page",
      kind: "read",
      tools: ["open_app_page", "open_record"],
    },
  ],
};

/**
 * What to call an area when talking about it as a whole.
 *
 * Almost always the section's landing page label — the first entry wins, so
 * an area is named "Invoices & Quotes" rather than by its Quotes sub-route.
 * "workspace" is the exception and needs saying: it is not the profile page
 * that happens to carry the tag, it is everything Arc can do wherever you are.
 */
export const AREA_LABELS: Record<AppArea, string> = (() => {
  const out: Partial<Record<AppArea, string>> = {};
  for (const entry of APP_AREAS) if (!out[entry.area]) out[entry.area] = entry.label;
  out.workspace = "Anywhere in Arc";
  return out as Record<AppArea, string>;
})();

/** Every capability, flattened, with the area it belongs to. */
export function allCapabilities(): (Capability & { area: AppArea; areaLabel: string })[] {
  const out: (Capability & { area: AppArea; areaLabel: string })[] = [];
  for (const [area, list] of Object.entries(CAPABILITY_CATALOG) as [AppArea, Capability[]][]) {
    for (const capability of list) {
      out.push({ ...capability, area, areaLabel: AREA_LABELS[area] ?? area });
    }
  }
  return out;
}
