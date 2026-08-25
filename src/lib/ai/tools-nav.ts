import "server-only";

/**
 * The tools that let Arc point at something instead of describing it.
 *
 * Everything else the assistant owns answers in words: a number, a list, a
 * confirmation. But half of what people ask an assistant inside an app is
 * really navigation — "show me the pipeline", "pull up the Ceylon Spice
 * project", "what can you even do?" — and prose is the wrong answer to all
 * three. A paragraph describing the CRM board is strictly worse than the CRM
 * board.
 *
 * So these three tools return `page` artifacts: the preview canvas embeds the
 * real route, live, with the user's own data and their own permissions. The
 * assistant is not reimplementing the product in the chat pane; it is opening
 * the product.
 *
 * Two rules keep them honest. Routes come from `@/lib/ai/app-map`, so a tool
 * can only open a page that exists — the preview pane never lands on a 404.
 * And ids are never guessed: `open_record` looks the row up through
 * `ctx.supabase` (the caller's own RLS-scoped client, exactly like every other
 * tool) and returns `{ ok: false }` when nothing matches, rather than
 * inventing a plausible uuid.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type { AppArea, Artifact, ArtifactColumn } from "@/lib/assistant-artifacts";
import { pageArtifact, rowsToTable, tableArtifact } from "@/lib/assistant-artifacts";
import type { Database } from "@/lib/database.types";
import {
  APP_AREAS,
  AREA_LABELS,
  CAPABILITY_CATALOG,
  allCapabilities,
  resolveAppHref,
  resolveAreaPath,
  type AppAreaEntry,
  type Capability,
} from "@/lib/ai/app-map";

type DB = SupabaseClient<Database>;

// ---- Tool schemas advertised to the model --------------------------------

/**
 * The area names the model may pass to `app_capabilities`. Derived from the
 * catalog so a new area cannot be advertised in the schema without also being
 * answerable.
 */
const AREA_NAMES = Object.keys(CAPABILITY_CATALOG) as AppArea[];

/** Tool schemas advertised to the model for navigating and showing the app. */
export const NAV_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "open_app_page",
      description:
        "Open a page of the app in the preview pane beside the conversation, so the user SEES it rather than hearing it described. Use this whenever someone asks to be shown, taken to or given a page — 'show me the pipeline', 'open finance', 'take me to invoices', 'where do I set prices?' — and alongside a spoken answer when the page carries more than you can sensibly read out. Accepts either a plain phrase ('the pipeline', 'money', 'invoices') or an exact route ('/crm', '/projects/insights'). Do NOT use it to look data up: it opens a page, it does not read one. For a specific project, lead, client, meeting, member or invoice use open_record instead.",
      parameters: {
        type: "object",
        properties: {
          area_or_path: {
            type: "string",
            description:
              "The page to open, as the user's own words ('the pipeline', 'money', 'client delivery') or an exact in-app route ('/crm', '/projects/reports').",
          },
          note: {
            type: "string",
            description:
              "One line saying why this page is the answer, shown under its title. Optional.",
          },
        },
        required: ["area_or_path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "app_capabilities",
      description:
        "What Arc can actually do — the honest, area-by-area list, built from the tools that really exist. Call this for 'what can you do?', 'can you handle invoices?', 'what else do you know about?' or when the user seems unsure what to ask for. Pass an area to narrow it to one part of the app. Answer from what this returns and nothing else: never promise a capability that is not in the list.",
      parameters: {
        type: "object",
        properties: {
          area: {
            type: "string",
            enum: AREA_NAMES,
            description:
              "Narrow to one area of the app. Omit for everything Arc can do.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_record",
      description:
        "Find one specific project, lead, client, meeting, team member or invoice by name and open its own page in the preview pane. Use for 'pull up the Ceylon Spice project', 'show me Sunrise Bakery', 'open Kamal's page', 'show me invoice 00214'. This is the 'show me X' tool; open_app_page is the 'show me the X page' tool. It returns ok:false when the name matches nothing — say so plainly instead of guessing at which record was meant.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["project", "lead", "client", "meeting", "member", "invoice"],
            description: "What kind of record to find.",
          },
          query: {
            type: "string",
            description:
              "Part of its name — a project or meeting title, a lead or client name or company, a member's name, or an invoice number.",
          },
        },
        required: ["type", "query"],
        additionalProperties: false,
      },
    },
  },
];

// ---- Shared helpers ------------------------------------------------------

/** A trimmed string out of whatever the model sent. */
function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * PostgREST `ilike` needs the wildcards baked into the pattern.
 *
 * The strip is not cosmetic. Four of these patterns are interpolated into an
 * `or()` string, which PostgREST appends to the query raw and splits on commas
 * and parentheses — so a client genuinely called "Silva, Perera & Co" splits
 * one filter into two malformed ones and the lookup fails with a 400 instead
 * of finding them. `%` and `*` are the wildcards themselves, and a term
 * carrying its own would quietly widen the match. Mirrors `safeLike` in the
 * delivery and growth modules.
 *
 * `.` is deliberately kept: PostgREST splits `column.operator.value` on the
 * first two dots only, so dots inside the value are safe — and dropping them
 * would stop `findClient` from ever matching an email address.
 */
function like(query: string): string {
  const safe = query.replace(/[,()%*\\]/g, " ").replace(/\s+/g, " ").trim();
  return `%${safe}%`;
}

/** Is the signed-in member an admin? Only asked when a page is admin-only. */
async function isAdmin(supabase: DB, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return data?.role === "admin";
}

/**
 * The page artifact plus the compact answer the model speaks from.
 *
 * The artifact carries the page; `content` carries only what the model needs
 * to describe it, because the model pays for every token of the page it is
 * already showing.
 */
function openedPage(
  entry: AppAreaEntry,
  href: string,
  opts: { title?: string; subtitle?: string; summary?: string },
): ToolResult {
  const artifact: Artifact = pageArtifact({
    title: opts.title ?? entry.label,
    subtitle: opts.subtitle ?? entry.label,
    summary: opts.summary ?? entry.blurb,
    href,
    area: entry.area,
    // The pane is a pane. Sooner or later they want the whole page.
    actions: [{ label: "Open full page", href, icon: "ExternalLink" }],
  });
  return {
    content: {
      ok: true,
      opened: opts.title ?? entry.label,
      area: entry.area,
      href,
      blurb: entry.blurb,
      // So the model can offer a next step that actually exists.
      can_do: (CAPABILITY_CATALOG[entry.area] ?? []).map((c) => c.label),
    },
    event: { kind: "read", label: `Opened ${opts.title ?? entry.label}`, href },
    artifacts: [artifact],
  };
}

// ---- open_app_page -------------------------------------------------------

async function openAppPage(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const wanted = text(args.area_or_path);
  if (!wanted) {
    return { content: { ok: false, reason: "Say which page to open." } };
  }

  const target = resolveAppHref(wanted);
  if (!target) {
    return {
      content: {
        ok: false,
        reason: `There is no page called "${wanted}".`,
        // Naming the real pages is more useful than an apology.
        pages: APP_AREAS.map((a) => a.label),
      },
    };
  }

  // An admin-only page would just bounce a member back to the dashboard, and
  // a preview pane full of a redirect is worse than being told plainly.
  if (target.entry.adminOnly && !(await isAdmin(ctx.supabase, ctx.userId))) {
    return {
      content: {
        ok: false,
        reason: `${target.entry.label} is admin-only, and this account is a member.`,
      },
    };
  }

  const note = text(args.note);
  return openedPage(target.entry, target.href, {
    summary: note || target.entry.blurb,
  });
}

// ---- app_capabilities ----------------------------------------------------

const CAPABILITY_KIND_LABEL: Record<Capability["kind"], string> = {
  read: "Looks it up",
  write: "Changes it here",
  confirm: "Drafts it — you press Send",
};

async function appCapabilities(args: Record<string, unknown>): Promise<ToolResult> {
  const asked = text(args.area);
  // A phrase is as valid an answer as an enum value — "what can you do with
  // money?" should not fail because the model wrote "money" instead of
  // "finance".
  const area: AppArea | null = asked
    ? AREA_NAMES.includes(asked as AppArea)
      ? (asked as AppArea)
      : (resolveAreaPath(asked)?.area ?? null)
    : null;

  if (asked && !area) {
    return {
      content: {
        ok: false,
        reason: `"${asked}" is not a part of this app.`,
        areas: AREA_NAMES,
      },
    };
  }

  const rows = area
    ? (CAPABILITY_CATALOG[area] ?? []).map((c) => ({
        ...c,
        area,
        areaLabel: AREA_LABELS[area] ?? area,
      }))
    : allCapabilities();

  if (rows.length === 0) {
    return {
      content: {
        ok: false,
        reason: `Arc cannot do anything in ${area ?? "that area"} yet — it can only open the page.`,
      },
    };
  }

  // "workspace" has no page of its own — the dashboard is where you are when
  // you ask what Arc can do.
  const home =
    area && area !== "workspace"
      ? (APP_AREAS.find((a) => a.area === area)?.href ?? "/dashboard")
      : "/dashboard";
  const columns: ArtifactColumn[] = [
    { key: "area", label: "Where" },
    { key: "capability", label: "What Arc can do" },
    { key: "example", label: "Say something like", secondary: true },
    { key: "kind", label: "How", format: "status" },
  ];

  const artifact = tableArtifact({
    title: area ? `What Arc can do — ${AREA_LABELS[area]}` : "What Arc can do",
    subtitle: area ? AREA_LABELS[area] : "Every area of the workspace",
    summary:
      "Only what Arc can really do today — each line is backed by a working tool. Anything not listed here, it cannot do yet.",
    href: home,
    area: area ?? "workspace",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      href: APP_AREAS.find((a) => a.area === c.area)?.href,
      tone: c.kind === "write" ? "warning" : c.kind === "confirm" ? "info" : "neutral",
      cells: {
        area: c.areaLabel,
        capability: c.label,
        example: c.example,
        kind: CAPABILITY_KIND_LABEL[c.kind],
      },
    })),
    footnote:
      "Anything that leaves the building — an email, a text, a WhatsApp message — is written by Arc and sent by you.",
  });

  // One area is small enough to hand over whole. Everything is not — but
  // truncating "what can you do?" to the first fifteen rows would answer the
  // question with whatever happens to sort first, so the wide answer drops
  // the examples and keeps every area instead.
  if (area) {
    return {
      content: {
        ok: true,
        area,
        count: rows.length,
        capabilities: rows.map((c) => ({ can: c.label, say: c.example, kind: c.kind })),
      },
      artifacts: [artifact],
    };
  }

  const byArea: Record<string, string[]> = {};
  for (const row of rows) {
    (byArea[row.areaLabel] ??= []).push(row.label);
  }
  return {
    content: {
      ok: true,
      area: "all",
      count: rows.length,
      by_area: byArea,
      note: "Ask app_capabilities for one area to get an example phrase for each line.",
    },
    artifacts: [artifact],
  };
}

// ---- open_record ---------------------------------------------------------

/** Where a found row lives, and how to introduce it. */
type FoundRecord = {
  href: string;
  area: AppArea;
  title: string;
  subtitle: string;
  /** Compact facts for the model — never the whole row. */
  facts: Record<string, unknown>;
  /** Other rows the name also matched, so the assistant can mention them. */
  others?: string[];
};

/**
 * Which of several matches the user meant.
 *
 * `ilike '%cafe%'` is a net, not an answer — it catches "Cafe Rio" and "Cafe"
 * alike, and taking the newest is a coin toss dressed as a decision. An exact
 * name wins, then one that starts with what was typed, then the first row;
 * and whatever else matched comes back too, so Arc can say there were others
 * rather than quietly choosing for the user.
 */
function pickBest<T>(
  rows: T[],
  query: string,
  nameOf: (row: T) => string,
): { row: T; others: string[] } | null {
  if (rows.length === 0) return null;
  const q = query.trim().toLowerCase();
  const at = (row: T) => nameOf(row).trim().toLowerCase();
  const row = rows.find((r) => at(r) === q) ?? rows.find((r) => at(r).startsWith(q)) ?? rows[0];
  return { row, others: rows.filter((r) => r !== row).map(nameOf) };
}

/** How many candidates a lookup pulls back before choosing between them. */
const CANDIDATES = 5;

async function findProject(supabase: DB, q: string): Promise<FoundRecord | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status, delivery_stage, total_value, due_date")
    .is("deleted_at", null)
    .ilike("name", like(q))
    .order("created_at", { ascending: false })
    .limit(CANDIDATES);
  if (error) return null;
  const best = pickBest(data ?? [], q, (r) => r.name);
  if (!best) return null;
  const row = best.row;
  return {
    href: `/projects/${row.id}`,
    area: "projects",
    title: row.name,
    subtitle: "Project",
    facts: {
      status: row.status,
      delivery_stage: row.delivery_stage,
      total_value: row.total_value,
      due_date: row.due_date,
      currency: "LKR",
    },
    others: best.others,
  };
}

async function findLead(supabase: DB, q: string): Promise<FoundRecord | null> {
  const term = like(q);
  const { data, error } = await supabase
    .from("leads")
    .select("id, title, company, contact_name, value, status, score")
    .is("deleted_at", null)
    .or(`title.ilike.${term},company.ilike.${term},contact_name.ilike.${term}`)
    .order("last_activity_at", { ascending: false })
    .limit(CANDIDATES);
  if (error) return null;
  const best = pickBest(data ?? [], q, (r) => r.title);
  if (!best) return null;
  const row = best.row;
  return {
    href: `/crm/lead/${row.id}`,
    area: "crm",
    title: row.title,
    subtitle: row.company ? `Lead — ${row.company}` : "Lead",
    facts: {
      company: row.company,
      contact: row.contact_name,
      value: row.value,
      status: row.status,
      score: row.score,
      currency: "LKR",
    },
    others: best.others,
  };
}

async function findClient(supabase: DB, q: string): Promise<FoundRecord | null> {
  const term = like(q);
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, company, email, phone, city, status")
    .or(`name.ilike.${term},company.ilike.${term},email.ilike.${term}`)
    .limit(CANDIDATES);
  if (error) return null;
  const best = pickBest(data ?? [], q, (r) => r.name);
  if (!best) return null;
  const row = best.row;
  return {
    // Clients have no page of their own — the directory is the honest link.
    href: "/clients",
    area: "clients",
    title: row.name,
    subtitle: row.company ? `Client — ${row.company}` : "Client",
    facts: {
      company: row.company,
      email: row.email,
      phone: row.phone,
      city: row.city,
      status: row.status,
    },
    others: best.others,
  };
}

/**
 * Meetings are two things wearing one word. `/meetings/<id>` is a booking
 * *link* and its bookings; the calendar's own meetings have no page of their
 * own. Prefer the one that deep-links, fall back to the calendar.
 */
async function findMeeting(supabase: DB, q: string): Promise<FoundRecord | null> {
  const term = like(q);
  const [bookings, links, meetings] = await Promise.all([
    supabase
      .from("meeting_bookings")
      .select("id, meeting_link_id, client_name, booking_date, start_time, status")
      .ilike("client_name", term)
      .order("booking_date", { ascending: false })
      .limit(CANDIDATES),
    supabase
      .from("meeting_links")
      .select("id, title, active")
      .ilike("title", term)
      .limit(CANDIDATES),
    supabase
      .from("meetings")
      .select("id, title, meeting_at, location_type, location")
      .ilike("title", term)
      .order("meeting_at", { ascending: false })
      .limit(CANDIDATES),
  ]);

  const booking = pickBest(bookings.data ?? [], q, (r) => r.client_name);
  if (booking) {
    return {
      href: `/meetings/${booking.row.meeting_link_id}`,
      area: "meetings",
      title: booking.row.client_name,
      subtitle: "Booking",
      facts: {
        date: booking.row.booking_date,
        time: booking.row.start_time,
        status: booking.row.status,
      },
      others: booking.others,
    };
  }

  const link = pickBest(links.data ?? [], q, (r) => r.title);
  if (link) {
    return {
      href: `/meetings/${link.row.id}`,
      area: "meetings",
      title: link.row.title,
      subtitle: "Booking link",
      facts: { active: link.row.active },
      others: link.others,
    };
  }

  const meeting = pickBest(meetings.data ?? [], q, (r) => r.title);
  if (meeting) {
    return {
      // A scheduled meeting has no page of its own; the calendar is where it is.
      href: "/meetings",
      area: "meetings",
      title: meeting.row.title,
      subtitle: "Meeting",
      facts: {
        meeting_at: meeting.row.meeting_at,
        location: meeting.row.location ?? meeting.row.location_type,
      },
      others: meeting.others,
    };
  }
  return null;
}

async function findMember(supabase: DB, q: string): Promise<FoundRecord | null> {
  const term = like(q);
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, username, role, title")
    .or(`full_name.ilike.${term},username.ilike.${term}`)
    .limit(CANDIDATES);
  if (error) return null;
  const best = pickBest(data ?? [], q, (r) => r.full_name);
  if (!best) return null;
  const row = best.row;
  return {
    href: `/team/${row.id}`,
    area: "team",
    title: row.full_name,
    subtitle: row.title ?? "Team member",
    facts: { username: row.username, role: row.role, title: row.title },
    others: best.others,
  };
}

async function findInvoice(supabase: DB, q: string): Promise<FoundRecord | null> {
  // "00214", "#00214" and "invoice 214" all mean the same invoice.
  const digits = q.replace(/\D/g, "");
  const term = like(digits || q);
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, invoice_date, bill_to_name, grand_total, amount_paid, due_today, sent_at, project_id",
    )
    .or(`invoice_number.ilike.${term},bill_to_name.ilike.${like(q)}`)
    .order("created_at", { ascending: false })
    .limit(CANDIDATES);
  if (error) return null;
  const rows = data ?? [];
  // Match on the digits, so "214" picks "#00214" over an invoice that merely
  // contains 214 somewhere in a longer number.
  const numbered = digits ? rows.find((r) => r.invoice_number.replace(/\D/g, "") === digits) : null;
  const best = numbered
    ? { row: numbered, others: rows.filter((r) => r !== numbered).map((r) => r.invoice_number) }
    : pickBest(rows, q, (r) => r.bill_to_name);
  if (!best) return null;
  const row = best.row;
  return {
    // Invoices have no page of their own; the Past tab is where they live.
    href: row.project_id ? `/projects/${row.project_id}` : "/invoices?tab=past",
    area: "invoices",
    title: `Invoice ${row.invoice_number}`,
    subtitle: row.bill_to_name,
    facts: {
      date: row.invoice_date,
      grand_total: row.grand_total,
      amount_paid: row.amount_paid,
      due_today: row.due_today,
      sent: Boolean(row.sent_at),
      currency: "LKR",
    },
    others: best.others,
  };
}

async function openRecord(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = text(args.type);
  const query = text(args.query);
  if (!query) {
    return { content: { ok: false, reason: "Say which record to open." } };
  }
  // A query made only of filter punctuation ("%%") survives `text` but is
  // stripped to nothing by `like`, leaving the bare pattern `%%` — which
  // matches every row, so the finders below would open an arbitrary record
  // and report it as the one that was asked for.
  if (!like(query).replace(/%/g, "")) {
    return {
      content: { ok: false, reason: `"${query}" is not something I can search for.` },
    };
  }

  const { supabase } = ctx;
  let found: FoundRecord | null = null;
  switch (kind) {
    case "project":
      found = await findProject(supabase, query);
      break;
    case "lead":
      found = await findLead(supabase, query);
      break;
    case "client":
      found = await findClient(supabase, query);
      break;
    case "meeting":
      found = await findMeeting(supabase, query);
      break;
    case "member":
      found = await findMember(supabase, query);
      break;
    case "invoice":
      found = await findInvoice(supabase, query);
      break;
    default:
      return {
        content: {
          ok: false,
          reason: `"${kind}" is not a kind of record. Use project, lead, client, meeting, member or invoice.`,
        },
      };
  }

  if (!found) {
    return {
      content: {
        ok: false,
        reason: `No ${kind} matches "${query}".`,
      },
    };
  }

  const record = found;
  const entry = APP_AREAS.find((a) => a.area === record.area) ?? APP_AREAS[0];

  // The same gate `open_app_page` applies, for the same reason. A record can
  // live on an admin-only page — a team member is `/team/<id>`, which calls
  // `requireAdmin` — so without this a member is handed a preview pane that
  // redirects to the dashboard while Arc reports it opened the record.
  if (entry.adminOnly && !(await isAdmin(supabase, ctx.userId))) {
    return {
      content: {
        ok: false,
        reason: `${entry.label} is admin-only, and this account is a member.`,
      },
    };
  }

  const result = openedPage(entry, record.href, {
    title: record.title,
    subtitle: record.subtitle,
    summary: entry.blurb,
  });

  return {
    ...result,
    content: {
      ...(result.content as Record<string, unknown>),
      type: kind,
      record: record.facts,
      // Say what else the name caught, so Arc can offer the alternative
      // instead of letting the user believe there was only ever one.
      ...(record.others?.length ? { also_matched: record.others } : {}),
    },
    event: { kind: "read", label: record.title, href: record.href },
  };
}

// ---- Executor ------------------------------------------------------------

/**
 * Run one navigation tool.
 *
 * Returns `null` when the name belongs to another module, so the registry can
 * try the next executor — only the base module in `@/lib/ai/tools` answers an
 * unknown name with an error.
 */
export async function executeNavTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "open_app_page":
      return openAppPage(args, ctx);
    case "app_capabilities":
      return appCapabilities(args);
    case "open_record":
      return openRecord(args, ctx);
    default:
      return null;
  }
}
