import "server-only";

/**
 * The assistant's delivery desk — Client Delivery, Website Progress, the
 * Projects deep-dive, Meetings and Resources.
 *
 * Delivery is the half of the workspace where the answer is almost never a
 * single number: "how is the Silva job going" is a stage, a checklist, a
 * plan, a client mood, an unpaid balance and a week of small events, and any
 * one of them on its own is misleading. So the flagship here is
 * `project_dossier` — one deep read that stitches all of it together — and
 * everything else exists to answer the questions a dossier cannot: what is
 * stuck across the whole board, what is due next month, who is carrying what.
 *
 * Three rules shaped the tool list. First, the model already carries thirty-odd
 * schemas and every extra one costs it accuracy, so `delivery_query` takes a
 * `dataset` enum instead of there being a list tool per table. Second, the
 * arithmetic has owners: `settledAmount()` decides what a project has
 * received, `projectHealth()` decides whether it is in trouble,
 * `projectCostsByProject()` is the only legal merge of the two cost ledgers,
 * and `finishedProjects()`/`benchmarkByService()` decide what "a business
 * website usually takes" means — none of it is re-derived here. Third, margin,
 * profit and cost rates are admin-only in the UI (a member sees "Internal
 * budget", never "Profit"), so this module checks `profiles.role` before a
 * profit figure ever reaches an artifact.
 *
 * Nothing here sends anything. Completing a milestone can text the client and
 * moving a stage can WhatsApp them, so those stay where a human presses the
 * button — the two writes below (logging time, recording why a project is
 * blocked) change the database and nothing else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type {
  AppArea,
  Artifact,
  ArtifactColumn,
  ArtifactField,
  ArtifactFormat,
  ArtifactRow,
  ArtifactTone,
} from "@/lib/assistant-artifacts";
import {
  chartArtifact,
  metricsArtifact,
  recordArtifact,
  rowsToTable,
  tableArtifact,
  timelineArtifact,
} from "@/lib/assistant-artifacts";
import {
  ASSET_CATEGORY_LABELS,
  DELIVERY_STAGES,
  DELIVERY_STAGE_META,
  MILESTONE_STATUS_META,
  PROJECT_EXPENSE_CATEGORY_LABELS,
  PROJECT_STATUS_META,
  SERVICE_TYPE_LABELS,
  WEBSITE_STATUS_META,
} from "@/lib/constants";
import type {
  ApprovalStatus,
  Database,
  DeliveryStage,
  ProjectAnomalyStatus,
  ReviewStatus,
  WebsiteStatus,
} from "@/lib/database.types";
import { projectCostsByProject } from "@/lib/project-costs";
import { benchmarkByService, finishedProjects } from "@/lib/project-history";
import {
  balanceDue,
  commissionEarned,
  daysSince,
  formatMinutes,
  marginIsMeaningful,
  paidPercent,
  projectHealth,
  projectMargin,
  settledAmount,
} from "@/lib/projects";

type DB = SupabaseClient<Database>;

// ---- Tool schemas advertised to the model --------------------------------

/** Tool schemas advertised to the model for this area. */
export const DELIVERY_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "project_dossier",
      description:
        "Everything about ONE project in a single read: where it is in delivery, its health score and why, what the client still owes, the outstanding checklist, the plan and who is on it, approvals and change requests, how the client says it is going, and a full history. Call this for 'show me everything on the Silva project', 'how is Cafe Aroma going', 'what's left on that build', 'has the client approved the homepage' or 'why is that job stuck'. Prefer it over several small lookups — it is one round-trip and it answers almost anything about one project.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project name, matched loosely ('the cafe one' finds 'Cafe Aroma — Business website'). A client's name works too: it falls back to that client's newest project. Archived projects are never matched.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delivery_query",
      description:
        "List any delivery or project record set as a table: pick the `dataset`. projects = the delivery view of every project (stage, balance, days idle, what is blocking it). milestones = client-facing phases and internal launch checks. assets = the client asset checklist. tasks / time / expenses = the work, the hours and the extra costs raised on projects. approvals = sign-offs asked of the client. change_requests = what the client asked for after the quote. comments / pulses / reviews = what the client has said. activity = the delivery event feed. websites = the Website Progress board. resources = the shared files and links. templates = project plan templates. lessons / anomalies = the AI layer's findings. Use this for 'what milestones are due in October', 'which websites are waiting on the client', 'which projects have work nobody approved', 'what did we agree in the last change request', 'what's missing from Nimal's checklist' or 'what happened on delivery this week'.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [
              "projects",
              "milestones",
              "assets",
              "tasks",
              "time",
              "expenses",
              "approvals",
              "change_requests",
              "comments",
              "pulses",
              "reviews",
              "activity",
              "websites",
              "resources",
              "templates",
              "lessons",
              "anomalies",
            ],
          },
          project: {
            type: "string",
            description:
              "Restrict to projects whose name contains this. Ignored by resources and templates, which are workspace-wide.",
          },
          client: {
            type: "string",
            description: "Restrict to the projects of clients whose name contains this.",
          },
          status: {
            type: "string",
            description:
              "Dataset-specific filter. projects: any project status (planning|active|on_hold|completed|cancelled), any delivery stage (onboarding|assets|build|review|delivered|aftercare), or live|not_started|stalled|blocked|waiting_client|overdue|owing. milestones: pending|done|blocked|overdue|launch_check|milestone. assets: pending|submitted|na|outstanding. tasks: todo|in_progress|done|open|overdue. expenses: billable|absorbed|invoiced|uninvoiced. approvals: pending|approved|changes_requested. change_requests: new|quoted|accepted|declined|waiting. comments: client|team. reviews: requested|submitted|declined. activity: any delivery event kind, e.g. stage_changed or chase_sent. resources: file|link. websites: in_progress|waiting_client|launched. templates: active|inactive. lessons: new|kept|dismissed. anomalies: open|dismissed|fixed. 'outstanding', 'overdue', 'stalled' and 'waiting' are worked out, not stored.",
          },
          category: {
            type: "string",
            description:
              "assets: brand|content|photos|access. expenses: hosting|licence|stock|content|design|ads|subcontract|travel|other. lessons: pricing|scope|timeline|delivery|client.",
          },
          member: {
            type: "string",
            description:
              "tasks and time only — whose work to show. 'me' for the signed-in user.",
          },
          from: {
            type: "string",
            description:
              "Window start, YYYY-MM-DD, on the dataset's own date (milestone due date, task due date, day worked, day incurred, when it happened).",
          },
          to: { type: "string", description: "Window end, YYYY-MM-DD (inclusive)." },
          query: {
            type: "string",
            description: "Contains-match on the record's title, body or name.",
          },
          limit: { type: "integer", description: "Rows to return. Default 25, max 100." },
        },
        required: ["dataset"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delivery_board",
      description:
        "The Client Delivery pipeline as a whole: how many projects sit in each stage, what they are worth, what is still owed on them, and — the point of the tool — everything that is stuck. Call this for 'what's stuck in delivery', 'how does delivery look right now', 'what's sitting in client review', 'who are we waiting on' or 'anything gone quiet'. Stalled means a project with a stage set, not yet delivered, and untouched for longer than the delivery settings allow; a project marked blocked is waiting on someone else and is listed separately rather than counted as stalled.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "meetings_agenda",
      description:
        "The diary: scheduled meetings in a date window with who is coming, where, and for how long — plus any calls clients booked themselves through a booking link in the same window. Use for 'what meetings do I have this week', 'who's coming to the Monday call', 'what's on tomorrow' or 'is anything booked with Silva'. Defaults to the next seven days. These are the meetings the workspace schedules, which is a different list from the public booking links on the Meetings page.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Window start, YYYY-MM-DD. Defaults to today." },
          to: {
            type: "string",
            description: "Window end, YYYY-MM-DD (inclusive). Defaults to seven days after `from`.",
          },
          member: {
            type: "string",
            description:
              "Only meetings this person is on, as an attendee or the organiser. 'me' for the signed-in user.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delivery_reports",
      description:
        "The three questions the boards cannot answer. workload = who is carrying what: live projects, open and overdue tasks, hours logged, and the hours booked against each project's internal budget — this is the one to call for 'who is over-running their hours' or 'who is busiest'. cycle_time = how long each delivery stage actually takes, end to end, and how often we hit the due date. benchmarks = what a service type usually takes, quotes and raises in extras, from our own finished projects — for 'how long does a business website take us'.",
      parameters: {
        type: "object",
        properties: {
          report: { type: "string", enum: ["workload", "cycle_time", "benchmarks"] },
          service_type: {
            type: "string",
            description:
              "benchmarks only — narrow to one service, e.g. business_website, ecommerce_website, social_media_marketing.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_project_time",
      description:
        "Record hours worked on a project, the way the Plan tab does. Use for 'log 3 hours on the Aroma build' or 'put 90 minutes against the Silva site for yesterday'. Logs against the signed-in user unless a `member` is named, which only an admin may do.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name, matched loosely." },
          hours: { type: "number", description: "How long, in hours. Use this or `minutes`." },
          minutes: { type: "integer", description: "How long, in minutes." },
          note: { type: "string", description: "What the time went on." },
          date: {
            type: "string",
            description: "The day worked, YYYY-MM-DD. Defaults to today.",
          },
          member: {
            type: "string",
            description: "Log on someone else's behalf. Admins only; defaults to the signed-in user.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_project_blocked",
      description:
        "Record that a project is waiting on someone else, or clear the block. Use for 'the Silva site is blocked, the client hasn't sent the logo' or 'unblock Cafe Aroma'. While blocked the asset chaser and the stalled-project alert stand down — a job waiting on a client is not a job the team is ignoring — and the days lost are kept so they can be quoted back when the deadline slips. No message goes to the client.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name, matched loosely." },
          blocked: {
            type: "boolean",
            description: "True to block it, false to clear an existing block.",
          },
          reason: {
            type: "string",
            description: "Why it is blocked, in the team's words. Required when blocking.",
          },
        },
        required: ["project", "blocked"],
        additionalProperties: false,
      },
    },
  },
];

// ---- Small shared helpers ------------------------------------------------

const WORKSPACE_TZ = "Asia/Colombo";

/** Coerce anything Postgres hands back (numeric arrives as a string) to a number. */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function total<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0);
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * Strip the characters PostgREST reads as filter syntax before they go into
 * an `or()` string. `or()` is appended to the query raw, so a member called
 * "Perera, Nimal" would otherwise split one filter into two malformed ones —
 * and a crafted name could bolt an extra condition onto the match.
 */
function safeLike(s: string): string {
  return s.replace(/[,()%*\\.]/g, " ").replace(/\s+/g, " ").trim();
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function clampLimit(v: unknown, fallback = 25): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** Money cells stay raw numbers — the artifact renderer owns the "Rs. " prefix. */
const money = (v: number): number => Math.round(v * 100) / 100;

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * A human date/time, workspace-local.
 *
 * Timeline entries render `when` verbatim — the canvas does no formatting for
 * them — so a raw UTC timestamp would show a Colombo evening meeting as the
 * previous afternoon. Date-only values are pinned to midday so no zone can
 * push them across a day boundary.
 */
function fmtWhen(value: string | null | undefined): string {
  if (!value) return "—";
  if (isDate(value)) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: WORKSPACE_TZ,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00+05:30`));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WORKSPACE_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/** UTC instant for the start of a Colombo calendar day. */
function colomboStart(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime();
}

/** ISO instant for the very end of a Colombo calendar day. */
function colomboEndIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999+05:30`).toISOString();
}

function shiftDay(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function stageLabel(stage: DeliveryStage | null): string {
  return stage ? DELIVERY_STAGE_META[stage].label : "Not started";
}

function serviceLabel(service: string | null): string {
  if (!service) return "—";
  return SERVICE_TYPE_LABELS[service] ?? service;
}

// Stored statuses the model may push straight into a `.eq()`. Declared with
// their real types so a value that stops being legal fails here at build time
// rather than silently returning nothing at run time.
const APPROVAL_STATUSES: ApprovalStatus[] = ["pending", "approved", "changes_requested"];
const REVIEW_STATUSES: ReviewStatus[] = ["requested", "submitted", "declined"];
const WEBSITE_STATUSES: WebsiteStatus[] = ["in_progress", "waiting_client", "launched"];
const ANOMALY_STATUSES: ProjectAnomalyStatus[] = ["open", "dismissed", "fixed"];

/** Truncate free prose for the model's copy; the artifact keeps it whole. */
function clip(text: string | null | undefined, max = 240): string {
  const s = str(text);
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Whether the caller may see profit, margin and cost rates.
 *
 * RLS hands the rows over either way — this gate is the application's, and it
 * is the same one `/projects` and `/projects/reports` apply. Without it the
 * assistant becomes the back door to a figure the UI deliberately hides.
 */
async function callerIsAdmin(ctx: ToolContext): Promise<boolean> {
  const { data } = await ctx.supabase
    .from("profiles")
    .select("role")
    .eq("id", ctx.userId)
    .maybeSingle();
  return data?.role === "admin";
}

const SELF_WORDS = new Set(["me", "myself", "i", "my", "mine", "my own"]);

/** A team member by spoken name, or the signed-in user for "me". */
async function resolveMember(
  ctx: ToolContext,
  name: unknown,
): Promise<{ id: string; name: string } | null> {
  const asked = str(name);
  if (!asked) return null;
  if (SELF_WORDS.has(asked.toLowerCase())) {
    const { data } = await ctx.supabase
      .from("profiles")
      .select("id, full_name, username")
      .eq("id", ctx.userId)
      .maybeSingle();
    return { id: ctx.userId, name: data?.full_name || data?.username || "you" };
  }
  const safe = safeLike(asked);
  if (!safe) return null;
  const { data } = await ctx.supabase
    .from("profiles")
    .select("id, full_name, username")
    .or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%`)
    .limit(1);
  const match = data?.[0];
  return match ? { id: match.id, name: match.full_name || match.username } : null;
}

/** Display names for a set of profile ids. */
async function memberNames(supabase: DB, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, username")
    .in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.full_name || p.username]));
}

// ---- Projects, loaded once ------------------------------------------------

type ProjectLite = {
  id: string;
  name: string;
  client_id: string | null;
  status: string;
  service_type: string | null;
  currency: string;
  delivery_stage: DeliveryStage | null;
  delivery_stage_changed_at: string | null;
  updated_at: string;
  created_at: string;
  start_date: string | null;
  due_date: string | null;
  total_value: number | null;
  deposit_paid: number | null;
  budget: number | null;
  expense_cap: number | null;
  blocked_reason: string | null;
  blocked_since: string | null;
  risk_rank: number | null;
  risk_note: string | null;
  chaser_paused: boolean;
  automation_paused: boolean;
};

const PROJECT_COLUMNS =
  "id, name, client_id, status, service_type, currency, delivery_stage, delivery_stage_changed_at, updated_at, created_at, start_date, due_date, total_value, deposit_paid, budget, expense_cap, blocked_reason, blocked_since, risk_rank, risk_note, chaser_paused, automation_paused";

/** Every live project. Archived ones never appear — acting on one silently is how a mistake gets made. */
async function loadProjects(supabase: DB): Promise<{ rows: ProjectLite[]; error: string | null }> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as ProjectLite[], error: null };
}

type MoneyRow = { value: number; received: number; balance: number; percent: number };

/**
 * What each project has taken in, through the one rule that owns the answer.
 *
 * `deposit_paid` and the project's own payment rows are the same money and are
 * reconciled with max(), never added; only the Payments board adds on top.
 * Doing it by hand here is how the assistant would end up quoting a different
 * balance from the project page.
 */
async function moneyForProjects(
  supabase: DB,
  projects: Pick<ProjectLite, "id" | "total_value" | "deposit_paid">[],
): Promise<Map<string, MoneyRow>> {
  const out = new Map<string, MoneyRow>();
  if (!projects.length) return out;
  const ids = projects.map((p) => p.id);

  // A short id list goes in the query string; a whole board's worth would make
  // a URL nobody wants to debug, so past a point it is cheaper to read the two
  // small tables whole and filter here.
  const narrow = ids.length <= 100;
  let payQ = supabase.from("payments").select("project_id, amount, status");
  let boardQ = supabase.from("company_payments").select("project_id, price_lkr, is_paid");
  if (narrow) {
    payQ = payQ.in("project_id", ids);
    boardQ = boardQ.in("project_id", ids);
  }
  const [payRes, boardRes] = await Promise.all([payQ.limit(5000), boardQ.limit(5000)]);

  const payments = new Map<string, { amount: number; status: string | null }[]>();
  for (const p of payRes.data ?? []) {
    const list = payments.get(p.project_id) ?? [];
    list.push({ amount: num(p.amount), status: p.status });
    payments.set(p.project_id, list);
  }
  const board = new Map<string, { price_lkr: number; is_paid: boolean }[]>();
  for (const p of boardRes.data ?? []) {
    if (!p.project_id) continue;
    const list = board.get(p.project_id) ?? [];
    list.push({ price_lkr: num(p.price_lkr), is_paid: Boolean(p.is_paid) });
    board.set(p.project_id, list);
  }

  for (const p of projects) {
    const shape = {
      total_value: num(p.total_value),
      deposit_paid: num(p.deposit_paid),
      payments: payments.get(p.id) ?? [],
      company_payments: board.get(p.id) ?? [],
    };
    out.set(p.id, {
      value: num(p.total_value),
      received: settledAmount(shape),
      balance: balanceDue(shape),
      percent: paidPercent(shape),
    });
  }
  return out;
}

/** Required checklist items still not in — the only definition of "outstanding". */
function outstandingAssets(
  rows: { status: string; required: boolean }[],
): number {
  return rows.filter((r) => r.status === "pending" && r.required).length;
}

/** Contains-match on a project name. Archived projects never match. */
async function findProjectRow(
  supabase: DB,
  name: unknown,
): Promise<{ id: string; name: string; currency: string } | null> {
  const q = str(name);
  if (!q) return null;
  const { data } = await supabase
    .from("projects")
    .select("id, name, currency")
    .is("deleted_at", null)
    .ilike("name", `%${q}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

// ---- project_dossier ------------------------------------------------------

/**
 * Find the project a person means.
 *
 * They say a project name most of the time and a client's name the rest, so
 * the client fallback is not a nicety: "everything on Silva" has to work when
 * Silva is the customer and the project is called "Silva Motors — E-commerce".
 */
async function resolveDossierProject(
  supabase: DB,
  asked: string,
): Promise<{ id: string; name: string } | { candidates: string[] } | null> {
  const direct = await findProjectRow(supabase, asked);
  if (direct) return { id: direct.id, name: direct.name };

  const { data: clients } = await supabase
    .from("clients")
    .select("id, name")
    .ilike("name", `%${asked}%`)
    .limit(5);
  if (!clients?.length) return null;

  const { data: theirs } = await supabase
    .from("projects")
    .select("id, name")
    .is("deleted_at", null)
    .in(
      "client_id",
      clients.map((c) => c.id),
    )
    .order("created_at", { ascending: false })
    .limit(5);
  if (!theirs?.length) return null;
  if (theirs.length === 1) return { id: theirs[0].id, name: theirs[0].name };
  // Several projects for that client: naming one would be a guess.
  return { candidates: theirs.map((p) => p.name) };
}

async function projectDossier(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const asked = str(args.project);
  if (!asked) return { content: { ok: false, error: "Say which project." } };

  const found = await resolveDossierProject(supabase, asked);
  if (!found) {
    return {
      content: {
        ok: false,
        reason: `No live project or client matching "${asked}". It may be archived. Say so rather than describing a project that isn't there.`,
      },
    };
  }
  if ("candidates" in found) {
    return {
      content: {
        ok: false,
        reason: `"${asked}" is a client with several projects. Ask which one.`,
        candidates: found.candidates,
      },
    };
  }

  const id = found.id;
  const href = `/projects/${id}`;

  const [
    projectRes,
    assetsRes,
    milestonesRes,
    tasksRes,
    timeRes,
    expensesRes,
    teamRes,
    approvalsRes,
    changesRes,
    commentsRes,
    pulsesRes,
    reviewsRes,
    eventsRes,
    paymentsRes,
    siteRes,
    isAdmin,
  ] = await Promise.all([
    supabase.from("projects").select(PROJECT_COLUMNS).eq("id", id).maybeSingle(),
    supabase
      .from("project_document_requests")
      .select("id, title, status, required, category, submitted_at, chase_count, file_name")
      .eq("project_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("project_milestones")
      .select("id, title, detail, kind, status, due_date, owner_id, completed_at, client_visible")
      .eq("project_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("todos")
      .select("id, title, status, priority, due_date, assigned_to, completed_at")
      .eq("project_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("time_entries")
      .select("id, user_id, minutes, note, worked_on")
      .eq("project_id", id)
      .order("worked_on", { ascending: false }),
    supabase
      .from("project_expenses")
      .select("id, description, category, vendor, amount, billable, incurred_on, invoiced_at")
      .eq("project_id", id)
      .order("incurred_on", { ascending: false }),
    supabase.from("project_members").select("user_id, role, is_owner").eq("project_id", id),
    supabase
      .from("project_approvals")
      .select("id, title, status, signer_name, signed_at, response_note, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_change_requests")
      .select("id, body, status, quoted_amount, quote_note, source, client_name, ai_flagged, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_comments")
      .select("id, author_type, author_name, body, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase.from("project_pulses").select("id, score, note, created_at").eq("project_id", id),
    supabase
      .from("project_reviews")
      .select("id, status, rating, headline, body, client_name, submitted_at, publishable")
      .eq("project_id", id)
      .order("requested_at", { ascending: false }),
    supabase
      .from("delivery_events")
      .select("id, kind, detail, actor, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("payments")
      .select("id, amount, status, paid_at, method, notes")
      .eq("project_id", id)
      .order("paid_at", { ascending: false }),
    supabase
      .from("website_projects")
      .select("id, name, url, progress, status, launched_at")
      .eq("project_id", id),
    callerIsAdmin(ctx),
  ]);

  const firstError =
    projectRes.error ??
    assetsRes.error ??
    milestonesRes.error ??
    tasksRes.error ??
    timeRes.error ??
    expensesRes.error ??
    approvalsRes.error ??
    changesRes.error ??
    eventsRes.error;
  if (firstError) return { content: { ok: false, error: firstError.message } };

  const project = projectRes.data as ProjectLite | null;
  if (!project) return { content: { ok: false, reason: `Project "${asked}" has gone.` } };

  // One row, once the project has told us which one — cheaper than pulling the
  // whole client list to read a single name off it.
  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, company, email, phone")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;

  const assets = assetsRes.data ?? [];
  const milestones = milestonesRes.data ?? [];
  const tasks = tasksRes.data ?? [];
  const timeEntries = timeRes.data ?? [];
  const expenses = expensesRes.data ?? [];
  const approvals = approvalsRes.data ?? [];
  const changes = changesRes.data ?? [];
  const comments = commentsRes.data ?? [];
  const pulses = pulsesRes.data ?? [];
  const reviews = reviewsRes.data ?? [];
  const events = eventsRes.data ?? [];
  const payments = paymentsRes.data ?? [];
  const site = (siteRes.data ?? [])[0] ?? null;

  const moneyMap = await moneyForProjects(supabase, [project]);
  const cash = moneyMap.get(id) ?? { value: 0, received: 0, balance: 0, percent: 0 };

  // Both cost ledgers, merged only where it is legal to merge them: a project
  // whose real costs were all booked in Finance would otherwise read as pure
  // profit. Commissions are restricted rows, so this stays behind the admin gate.
  const costs = await projectCostsByProject(supabase, [id]).then((m) => m.get(id) ?? []);
  const rates = isAdmin
    ? await supabase.from("profiles").select("id, hourly_cost").limit(200)
    : { data: [] as { id: string; hourly_cost: number | null }[] };
  const rateMap = new Map((rates.data ?? []).map((p) => [p.id, num(p.hourly_cost)]));
  const loggedMinutes = total(timeEntries, (t) => num(t.minutes));
  const labourCost = total(timeEntries, (t) => (num(t.minutes) / 60) * (rateMap.get(t.user_id) ?? 0));

  let margin: ReturnType<typeof projectMargin> | null = null;
  if (isAdmin) {
    const { data: commissions } = await supabase
      .from("commissions")
      .select("amount, percentage, basis")
      .eq("project_id", id);
    margin = projectMargin({
      totalValue: cash.value,
      expenses: costs,
      commissions: (commissions ?? []).map((c) => ({
        amount: commissionEarned(c, cash.received),
      })),
      labourCost,
    });
  }

  // ---- Health, assembled exactly as the project page assembles it --------
  const todayStart = colomboStart(ctx.today);
  const overdueTasks = tasks.filter(
    (t) => t.status !== "done" && t.due_date && Date.parse(t.due_date) < todayStart,
  );
  // A milestone due date is a bare DATE, and it is late only once the whole
  // day has passed — which a plain string compare against today says exactly.
  const overdueMilestones = milestones.filter(
    (m) => m.status !== "done" && m.due_date && m.due_date < ctx.today,
  );
  const assetsOut = outstandingAssets(assets);
  const spend = total(costs, (c) => num(c.amount));
  // expense_cap wins, budget is the fallback — the order the board uses.
  const internalBudget = Number(project.expense_cap ?? project.budget ?? 0) || null;
  const health = projectHealth({
    status: project.status,
    deliveryStage: project.delivery_stage,
    stageChangedAt: project.delivery_stage_changed_at,
    updatedAt: project.updated_at,
    dueDate: project.due_date,
    blockedSince: project.blocked_since,
    assetsOutstanding: assetsOut,
    overdueTasks: overdueTasks.length,
    overdueMilestones: overdueMilestones.length,
    balance: cash.balance,
    daysSinceDelivered:
      project.delivery_stage === "delivered" || project.delivery_stage === "aftercare"
        ? daysSince(project.delivery_stage_changed_at)
        : null,
    budget: internalBudget,
    spend,
  });
  const healthTone: ArtifactTone =
    health.tone === "good" ? "positive" : health.tone === "watch" ? "warning" : "danger";

  const waitingOnUs = changes.filter((c) => ["new", "quoted"].includes(c.status));
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  // Averaged, not "latest": one bad day should not define a project, and one
  // good one should not hide it.
  const pulseAverage = pulses.length ? total(pulses, (p) => num(p.score)) / pulses.length : null;
  const openTasks = tasks.filter((t) => t.status !== "done");
  const openMilestones = milestones.filter((m) => m.status !== "done");
  const openLaunchChecks = openMilestones.filter((m) => m.kind === "launch_check");
  const teamIds = (teamRes.data ?? []).map((m) => m.user_id);
  const names = await memberNames(supabase, [
    ...teamIds,
    ...milestones.map((m) => m.owner_id),
    ...tasks.map((t) => t.assigned_to),
  ]);
  const team = (teamRes.data ?? []).map((m) => ({
    name: names.get(m.user_id) ?? "—",
    role: m.role ?? "Team",
    owner: m.is_owner,
  }));
  const idleDays = daysSince(project.delivery_stage_changed_at ?? project.updated_at);

  // ---- Artifact 1: the record -------------------------------------------
  const headline: ArtifactField[] = [
    { label: "Stage", value: stageLabel(project.delivery_stage), format: "status", tone: "info" },
    {
      label: "Status",
      value: PROJECT_STATUS_META[project.status as keyof typeof PROJECT_STATUS_META]?.label ?? project.status,
      format: "status",
    },
    { label: "Health", value: health.score, format: "number", tone: healthTone },
    { label: "Contract value", value: money(cash.value), format: "money" },
    { label: "Received", value: money(cash.received), format: "money", tone: "positive" },
    {
      label: "Balance",
      value: money(cash.balance),
      format: "money",
      tone: cash.balance > 0 ? "warning" : "positive",
    },
    { label: "Due date", value: project.due_date ?? "—", format: "date" },
    {
      label: "Outstanding assets",
      value: assetsOut,
      format: "number",
      tone: assetsOut > 0 ? "warning" : "positive",
    },
  ];

  const groups: { label: string; fields: ArtifactField[] }[] = [
    {
      label: "Delivery",
      fields: [
        { label: "Client", value: client?.name ?? "No client attached", href: "/clients" },
        { label: "Service", value: serviceLabel(project.service_type) },
        { label: "Started", value: project.start_date ?? "—", format: "date" },
        { label: "In this stage since", value: project.delivery_stage_changed_at ?? "—", format: "datetime" },
        {
          label: "Days without movement",
          value: idleDays ?? 0,
          format: "number",
          tone: (idleDays ?? 0) >= 7 ? "warning" : "neutral",
        },
        {
          label: "Blocked",
          value: project.blocked_reason ?? "no",
          format: "status",
          tone: project.blocked_reason ? "warning" : "neutral",
        },
        { label: "Risk radar", value: project.risk_note ?? "nothing flagged", format: "multiline" },
        {
          label: "Chaser",
          value: project.chaser_paused ? "paused" : "running",
          format: "status",
        },
        {
          label: "Automations",
          value: project.automation_paused ? "paused for this project" : "running",
          format: "status",
        },
      ],
    },
    {
      label: "The plan",
      fields: [
        { label: "Open tasks", value: openTasks.length, format: "number" },
        {
          label: "Overdue tasks",
          value: overdueTasks.length,
          format: "number",
          tone: overdueTasks.length ? "danger" : "neutral",
        },
        { label: "Milestones left", value: openMilestones.length - openLaunchChecks.length, format: "number" },
        {
          label: "Launch checks left",
          value: openLaunchChecks.length,
          format: "number",
          tone: openLaunchChecks.length ? "warning" : "positive",
        },
        { label: "Time logged", value: formatMinutes(loggedMinutes), format: "status" },
        { label: "On the job", value: team.map((t) => `${t.name} (${t.role})`).join(", ") || "nobody assigned" },
      ],
    },
    {
      label: "The client desk",
      fields: [
        {
          label: "Approvals pending",
          value: pendingApprovals.length,
          format: "number",
          tone: pendingApprovals.length ? "warning" : "positive",
        },
        {
          label: "Change requests waiting on us",
          value: waitingOnUs.length,
          format: "number",
          tone: waitingOnUs.length ? "warning" : "positive",
        },
        {
          label: "Mood",
          value: pulseAverage === null ? "not asked yet" : `${round1(pulseAverage)} of 3`,
          format: "status",
          tone: pulseAverage === null ? "neutral" : pulseAverage >= 2.5 ? "positive" : pulseAverage >= 1.8 ? "warning" : "danger",
        },
        { label: "Comments", value: comments.length, format: "number" },
        {
          label: "Review",
          value: reviews[0] ? `${reviews[0].status}${reviews[0].rating ? ` — ${reviews[0].rating}/5` : ""}` : "none asked",
          format: "status",
        },
        ...(site
          ? [
              {
                label: "Website build",
                value: `${site.progress}% — ${WEBSITE_STATUS_META[site.status].label}`,
                format: "status" as ArtifactFormat,
                href: "/website-progress",
              },
            ]
          : []),
      ],
    },
    {
      label: "Money",
      fields: [
        { label: "Paid so far", value: cash.percent, format: "percent" },
        { label: "Payments recorded", value: payments.length, format: "number" },
        { label: "Extra costs raised", value: money(total(expenses, (e) => num(e.amount))), format: "money" },
        {
          label: "Internal budget",
          value: internalBudget ?? "none set",
          format: internalBudget === null ? "status" : "money",
        },
        {
          label: "Spend against it",
          value: money(spend),
          format: "money",
          tone: internalBudget !== null && spend > internalBudget ? "danger" : "neutral",
        },
        ...(margin && marginIsMeaningful(margin)
          ? [
              { label: "Profit", value: money(margin.profit), format: "money" as ArtifactFormat, tone: (margin.profit >= 0 ? "positive" : "danger") as ArtifactTone },
              { label: "Margin", value: margin.percent, format: "percent" as ArtifactFormat },
            ]
          : margin
            ? [
                {
                  label: "Margin",
                  value: "no costs recorded",
                  format: "status" as ArtifactFormat,
                },
              ]
            : []),
      ],
    },
  ];

  // ---- Artifact 2: what is still open -----------------------------------
  type OpenItem = {
    id: string;
    kind: string;
    item: string;
    who: string;
    due: string | null;
    status: string;
    tone: ArtifactTone;
  };
  const openItems: OpenItem[] = [
    ...assets
      .filter((a) => a.status === "pending")
      .map((a) => ({
        id: `asset-${a.id}`,
        kind: "Asset",
        item: a.title,
        who: "Client",
        due: null,
        status: a.required ? `required · chased ${a.chase_count}×` : "optional",
        tone: (a.required ? "warning" : "neutral") as ArtifactTone,
      })),
    ...pendingApprovals.map((a) => ({
      id: `approval-${a.id}`,
      kind: "Approval",
      item: a.title,
      who: "Client",
      due: null,
      status: "waiting for sign-off",
      tone: "warning" as ArtifactTone,
    })),
    ...waitingOnUs.map((c) => ({
      id: `change-${c.id}`,
      kind: "Change request",
      item: clip(c.body, 160),
      who: c.client_name ?? "Client",
      due: null,
      status: c.status === "new" ? "needs a quote" : "quoted, awaiting an answer",
      tone: "warning" as ArtifactTone,
    })),
    ...openMilestones.map((m) => ({
      id: `milestone-${m.id}`,
      kind: m.kind === "launch_check" ? "Launch check" : "Milestone",
      item: m.title,
      who: m.owner_id ? (names.get(m.owner_id) ?? "—") : "—",
      due: m.due_date,
      status: MILESTONE_STATUS_META[m.status].label,
      tone: (m.status === "blocked"
        ? "danger"
        : m.due_date && m.due_date < ctx.today
          ? "danger"
          : "neutral") as ArtifactTone,
    })),
    ...openTasks.map((t) => ({
      id: `task-${t.id}`,
      kind: "Task",
      item: t.title,
      who: t.assigned_to ? (names.get(t.assigned_to) ?? "—") : "unassigned",
      due: t.due_date ? t.due_date.slice(0, 10) : null,
      status: t.status === "in_progress" ? "in progress" : t.priority,
      tone: (t.due_date && Date.parse(t.due_date) < todayStart ? "danger" : "neutral") as ArtifactTone,
    })),
  ];

  const openColumns: ArtifactColumn[] = [
    { key: "kind", label: "What", format: "status" },
    { key: "item", label: "Item" },
    { key: "who", label: "Who", secondary: true },
    { key: "due", label: "Due", format: "date" },
    { key: "status", label: "State", format: "status" },
  ];

  // ---- Artifact 3: the history ------------------------------------------
  type Entry = { at: string; label: string; detail?: string; tone?: ArtifactTone };
  const entries: Entry[] = [
    ...events.map((e) => ({
      at: e.created_at,
      label: e.kind.replace(/_/g, " "),
      detail: [e.detail, e.actor ? `by ${e.actor}` : null].filter(Boolean).join(" · ") || undefined,
      tone: (e.kind === "stalled_alert" ? "warning" : e.kind === "change_requested" ? "warning" : "info") as ArtifactTone,
    })),
    ...milestones
      .filter((m) => m.completed_at)
      .map((m) => ({
        at: m.completed_at as string,
        label: `Milestone done — ${m.title}`,
        detail: m.detail ?? undefined,
        tone: "positive" as ArtifactTone,
      })),
    ...approvals
      .filter((a) => a.signed_at)
      .map((a) => ({
        at: a.signed_at as string,
        label: `${a.status === "approved" ? "Approved" : "Changes asked for"} — ${a.title}`,
        detail: [a.signer_name, a.response_note].filter(Boolean).join(" · ") || undefined,
        tone: (a.status === "approved" ? "positive" : "warning") as ArtifactTone,
      })),
    ...changes.map((c) => ({
      at: c.created_at,
      label: `Change request (${c.status})`,
      detail: [clip(c.body, 300), c.quoted_amount ? `Quoted ${money(num(c.quoted_amount))}` : null, c.quote_note]
        .filter(Boolean)
        .join(" · "),
      tone: (c.status === "accepted" ? "positive" : c.status === "declined" ? "neutral" : "warning") as ArtifactTone,
    })),
    ...comments.map((c) => ({
      at: c.created_at,
      label: `${c.author_type === "client" ? "Client" : "Team"} — ${c.author_name}`,
      detail: clip(c.body, 400),
      tone: (c.author_type === "client" ? "info" : "neutral") as ArtifactTone,
    })),
    ...pulses.map((p) => ({
      at: p.created_at,
      label: `Client mood: ${p.score} of 3`,
      detail: p.note ?? undefined,
      tone: (p.score >= 3 ? "positive" : p.score === 2 ? "neutral" : "danger") as ArtifactTone,
    })),
    ...reviews
      .filter((r) => r.submitted_at)
      .map((r) => ({
        at: r.submitted_at as string,
        label: `Review — ${r.rating ?? "?"}/5${r.headline ? ` · ${r.headline}` : ""}`,
        detail: clip(r.body, 400),
        tone: "positive" as ArtifactTone,
      })),
    ...assets
      .filter((a) => a.submitted_at)
      .map((a) => ({
        at: a.submitted_at as string,
        label: `Asset in — ${a.title}`,
        detail: a.file_name ?? undefined,
        tone: "positive" as ArtifactTone,
      })),
    ...payments.map((p) => ({
      at: p.paid_at ?? project.created_at,
      label: `Payment ${p.status} — ${money(num(p.amount))}`,
      detail: [p.method, p.notes].filter(Boolean).join(" · ") || undefined,
      tone: (p.status === "paid" ? "positive" : "warning") as ArtifactTone,
    })),
    ...expenses.map((e) => ({
      at: e.incurred_on,
      label: `Cost — ${e.description} (${money(num(e.amount))})`,
      detail: [e.vendor, e.billable ? "billable" : "absorbed", e.invoiced_at ? "invoiced" : null]
        .filter(Boolean)
        .join(" · "),
      tone: "neutral" as ArtifactTone,
    })),
    ...timeEntries.slice(0, 20).map((t) => ({
      at: t.worked_on,
      label: `${formatMinutes(num(t.minutes))} logged — ${names.get(t.user_id) ?? "someone"}`,
      detail: t.note ?? undefined,
      tone: "neutral" as ArtifactTone,
    })),
  ]
    .filter((e) => Boolean(e.at))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 60);

  const artifacts: Artifact[] = [
    recordArtifact({
      title: project.name,
      subtitle: `${stageLabel(project.delivery_stage)} · ${client?.name ?? "no client"}`,
      summary:
        health.reasons.length > 0
          ? `Health ${health.score}/100 — ${health.reasons.join("; ")}.`
          : `Health ${health.score}/100 — nothing is flagged.`,
      href,
      area: "projects",
      body: project.risk_note ?? undefined,
      fields: headline,
      groups,
      actions: [
        { label: "Open the project", href, icon: "FolderKanban" },
        { label: "What's left", prompt: `What is still outstanding on ${project.name}?` },
      ],
    }),
  ];

  if (openItems.length) {
    artifacts.push(
      tableArtifact({
        title: `${project.name} — still open`,
        subtitle: "Assets, approvals, change requests, milestones and tasks in one list",
        summary:
          "An asset only counts as outstanding when it is required — optional items never hold a project up.",
        href,
        area: "projects",
        columns: openColumns,
        rows: rowsToTable(openItems, openColumns, (o) => ({
          id: o.id,
          href,
          tone: o.tone,
          cells: { kind: o.kind, item: o.item, who: o.who, due: o.due, status: o.status },
        })),
      }),
    );
  }

  if (entries.length) {
    artifacts.push(
      timelineArtifact({
        title: `${project.name} — history`,
        subtitle: "Newest first",
        summary:
          "Stitched from the delivery feed, milestones, approvals, change requests, comments, pulses, assets, payments, costs and logged time.",
        href,
        area: "delivery",
        entries: entries.map((e) => ({
          when: fmtWhen(e.at),
          label: e.label,
          detail: e.detail,
          tone: e.tone,
          href,
        })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      project: project.name,
      href,
      client: client?.name ?? null,
      status: project.status,
      delivery_stage: project.delivery_stage ?? "not started",
      service: serviceLabel(project.service_type),
      currency: project.currency,
      health: { score: health.score, tone: health.tone, reasons: health.reasons },
      money: {
        contract_value: money(cash.value),
        received: money(cash.received),
        balance: money(cash.balance),
        paid_percent: cash.percent,
        extra_costs: money(total(expenses, (e) => num(e.amount))),
        internal_budget: internalBudget,
        spend_against_budget: money(spend),
        ...(margin && marginIsMeaningful(margin)
          ? { profit: money(margin.profit), margin_percent: margin.percent }
          : {}),
        ...(margin && !marginIsMeaningful(margin)
          ? { margin_note: "No costs recorded, so a margin here would be the absence of data." }
          : {}),
        ...(isAdmin ? {} : { margin_note: "Profit and margin are admin-only in this workspace." }),
      },
      dates: {
        started: project.start_date,
        due: project.due_date,
        in_stage_since: fmtWhen(project.delivery_stage_changed_at),
        days_without_movement: idleDays,
        blocked_reason: project.blocked_reason,
      },
      counts: {
        assets_outstanding: assetsOut,
        assets_total: assets.length,
        open_tasks: openTasks.length,
        overdue_tasks: overdueTasks.length,
        open_milestones: openMilestones.length,
        overdue_milestones: overdueMilestones.length,
        launch_checks_left: openLaunchChecks.length,
        approvals_pending: pendingApprovals.length,
        change_requests_waiting_on_us: waitingOnUs.length,
        hours_logged: round1(loggedMinutes / 60),
      },
      team,
      client_mood: pulseAverage === null ? null : round1(pulseAverage),
      latest_change_request: changes[0]
        ? {
            when: fmtWhen(changes[0].created_at),
            status: changes[0].status,
            asked_for: clip(changes[0].body, 500),
            quoted: changes[0].quoted_amount === null ? null : money(num(changes[0].quoted_amount)),
            note: changes[0].quote_note,
          }
        : null,
      still_open: openItems.slice(0, 15).map((o) => ({
        what: o.kind,
        item: o.item,
        who: o.who,
        due: o.due,
        state: o.status,
      })),
      recent_history: entries.slice(0, 12).map((e) => ({
        when: fmtWhen(e.at),
        what: e.label,
        detail: e.detail ?? null,
      })),
      note: "The full checklist, plan and history are in the artifacts beside the conversation.",
    },
    event: { kind: "read", label: project.name, href },
    artifacts,
  };
}

// ---- delivery_query -------------------------------------------------------

type Filters = {
  status: string;
  category: string;
  query: string;
  from: string | null;
  to: string | null;
  memberId: string | null;
  memberName: string | null;
  limit: number;
  today: string;
  todayStart: number;
};

type Scope = {
  /** null = every project; otherwise the ids that matched the filter. */
  ids: string[] | null;
  /** Every live project's name, so a row can always say which project it is. */
  names: Map<string, string>;
  /** The in-scope projects themselves, for the datasets built from them. */
  projects: ProjectLite[];
  label: string | null;
  /**
   * Set when a project or client filter matched nothing. Carried rather than
   * thrown, because the two workspace-wide datasets have no project column and
   * should still answer — refusing them over an irrelevant filter is a worse
   * answer than ignoring it.
   */
  empty: string | null;
};

/** The one table artifact a dataset branch produces, before it is capped. */
type Dataset = {
  title: string;
  subtitle?: string;
  summary?: string;
  href: string;
  area: AppArea;
  columns: ArtifactColumn[];
  rows: ArtifactRow[];
  total_label?: string;
  total_value?: number;
  total_format?: ArtifactFormat;
  footnote?: string;
};

function inWindow(date: string | null | undefined, f: Filters): boolean {
  if (!date) return !f.from && !f.to;
  const d = date.slice(0, 10);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

async function readScope(
  supabase: DB,
  args: Record<string, unknown>,
): Promise<Scope | { error: string }> {
  const { rows, error } = await loadProjects(supabase);
  if (error) return { error };

  const names = new Map(rows.map((p) => [p.id, p.name]));
  const projectQ = str(args.project);
  const clientQ = str(args.client);
  if (!projectQ && !clientQ) {
    return { ids: null, names, projects: rows, label: null, empty: null };
  }

  let matched = rows;
  const labels: string[] = [];
  if (projectQ) {
    matched = matched.filter((p) => contains(p.name, projectQ));
    labels.push(`project "${projectQ}"`);
  }
  if (clientQ) {
    const { data: clients } = await supabase
      .from("clients")
      .select("id, name")
      .ilike("name", `%${clientQ}%`)
      .limit(20);
    const ids = new Set((clients ?? []).map((c) => c.id));
    matched = matched.filter((p) => p.client_id && ids.has(p.client_id));
    labels.push(`client "${clientQ}"`);
  }

  return {
    ids: matched.map((p) => p.id),
    names,
    projects: matched,
    label: labels.join(" · "),
    empty: matched.length ? null : `No live project matches ${labels.join(" and ")}.`,
  };
}

// -- projects ---------------------------------------------------------------

async function datasetProjects(
  supabase: DB,
  scope: Scope,
  f: Filters,
): Promise<Dataset | string> {
  const projects = scope.projects;
  const ids = projects.map((p) => p.id);

  let assetQ = supabase
    .from("project_document_requests")
    .select("project_id, status, required");
  if (ids.length <= 100) assetQ = assetQ.in("project_id", ids);
  const [assetRes, moneyMap, settingsRes, clientRes] = await Promise.all([
    assetQ.limit(5000),
    moneyForProjects(supabase, projects),
    supabase.from("delivery_settings").select("stalled_days").eq("id", 1).maybeSingle(),
    supabase.from("clients").select("id, name").limit(500),
  ]);
  if (assetRes.error) return assetRes.error.message;

  const stalledDays = settingsRes.data?.stalled_days ?? 5;
  const clientNames = new Map((clientRes.data ?? []).map((c) => [c.id, c.name]));
  const byProject = new Map<string, { status: string; required: boolean }[]>();
  for (const a of assetRes.data ?? []) {
    const list = byProject.get(a.project_id) ?? [];
    list.push({ status: a.status, required: a.required });
    byProject.set(a.project_id, list);
  }

  const now = Date.now();
  const rows = projects.map((p) => {
    const checklist = byProject.get(p.id) ?? [];
    const cash = moneyMap.get(p.id) ?? { value: 0, received: 0, balance: 0, percent: 0 };
    const out = outstandingAssets(checklist);
    // Stalled is the delivery board's own test: a stage is set, it is not
    // finished, and nothing has touched it for longer than the settings allow.
    // A blocked project is waiting, not stalled, so it is excluded here.
    const stalled =
      Boolean(p.delivery_stage) &&
      !["delivered", "aftercare"].includes(p.delivery_stage ?? "") &&
      !p.blocked_reason &&
      now - Date.parse(p.updated_at) > stalledDays * 86_400_000;
    const waiting =
      Boolean(p.delivery_stage) &&
      ["onboarding", "assets"].includes(p.delivery_stage ?? "") &&
      out > 0;
    return {
      ...p,
      client: p.client_id ? (clientNames.get(p.client_id) ?? "—") : "—",
      outstanding: out,
      cash,
      stalled,
      waiting,
      idle: daysSince(p.delivery_stage_changed_at ?? p.updated_at) ?? 0,
      overdue: Boolean(p.due_date && p.due_date < f.today && p.status !== "completed"),
    };
  });

  const s = f.status;
  const filtered = rows.filter((r) => {
    if (!s) return true;
    if (s === "live") return ["planning", "active", "on_hold"].includes(r.status);
    if (s === "not_started") return !r.delivery_stage;
    if (s === "stalled") return r.stalled;
    if (s === "blocked") return Boolean(r.blocked_reason);
    if (s === "waiting_client") return r.waiting;
    if (s === "overdue") return r.overdue;
    if (s === "owing") return r.cash.balance > 0;
    if ((DELIVERY_STAGES as readonly string[]).includes(s)) return r.delivery_stage === s;
    return r.status === s;
  });
  const searched = f.query
    ? filtered.filter((r) => contains(r.name, f.query) || contains(r.client, f.query))
    : filtered;
  searched.sort((a, b) => b.idle - a.idle);

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "client", label: "Client", secondary: true },
    { key: "stage", label: "Stage", format: "status" },
    { key: "status", label: "Status", format: "status", secondary: true },
    { key: "due", label: "Due", format: "date" },
    { key: "idle", label: "Idle days", format: "number", align: "right" },
    { key: "assets", label: "Assets out", format: "number", align: "right" },
    { key: "balance", label: "Balance", format: "money", align: "right" },
    { key: "flag", label: "Flag", format: "status" },
  ];

  return {
    title: "Projects in delivery",
    subtitle: f.status ? `Filtered: ${f.status}` : scope.label ?? "Longest without movement first",
    summary:
      "Idle days count from the last stage move. 'Stalled' is the delivery board's own test and deliberately excludes blocked projects — a job waiting on a client is not a job being ignored.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(searched, columns, (r) => ({
      id: r.id,
      href: `/projects/${r.id}`,
      tone: (r.blocked_reason
        ? "warning"
        : r.stalled || r.overdue
          ? "danger"
          : r.delivery_stage === "delivered" || r.delivery_stage === "aftercare"
            ? "positive"
            : "neutral") as ArtifactTone,
      cells: {
        project: r.name,
        client: r.client,
        stage: stageLabel(r.delivery_stage),
        status: PROJECT_STATUS_META[r.status as keyof typeof PROJECT_STATUS_META]?.label ?? r.status,
        due: r.due_date,
        idle: r.idle,
        assets: r.outstanding,
        balance: money(r.cash.balance),
        flag: r.blocked_reason
          ? `blocked — ${r.blocked_reason}`
          : r.stalled
            ? "stalled"
            : r.waiting
              ? "waiting on client"
              : r.overdue
                ? "past due"
                : "—",
      },
    })),
    total_label: "Still owed across these",
    total_value: money(total(searched, (r) => r.cash.balance)),
    total_format: "money",
  };
}

// -- milestones -------------------------------------------------------------

async function datasetMilestones(
  supabase: DB,
  scope: Scope,
  f: Filters,
): Promise<Dataset | string> {
  let q = supabase
    .from("project_milestones")
    .select("id, project_id, title, detail, kind, status, due_date, owner_id, completed_at, client_visible");
  if (scope.ids) q = q.in("project_id", scope.ids);
  const { data, error } = await q.order("due_date", { ascending: true }).limit(800);
  if (error) return error.message;

  let rows = (data ?? []).map((m) => ({
    ...m,
    project: scope.names.get(m.project_id) ?? "—",
    overdue: m.status !== "done" && Boolean(m.due_date) && (m.due_date as string) < f.today,
  }));
  if (f.from || f.to) rows = rows.filter((m) => inWindow(m.due_date, f));
  if (f.query) rows = rows.filter((m) => contains(m.title, f.query) || contains(m.detail, f.query));
  if (f.status === "overdue") rows = rows.filter((m) => m.overdue);
  else if (f.status === "launch_check" || f.status === "milestone") {
    rows = rows.filter((m) => m.kind === f.status);
  } else if (["pending", "done", "blocked"].includes(f.status)) {
    rows = rows.filter((m) => m.status === f.status);
  }

  const owners = await memberNames(supabase, rows.map((m) => m.owner_id));
  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "milestone", label: "Milestone" },
    { key: "kind", label: "Kind", format: "status", secondary: true },
    { key: "due", label: "Due", format: "date" },
    { key: "owner", label: "Owner", secondary: true },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: "Milestones",
    subtitle:
      f.from || f.to
        ? `Due ${f.from ?? "any time"} to ${f.to ?? "any time"}`
        : f.status
          ? `Filtered: ${f.status}`
          : "By due date",
    summary:
      "A launch check is the internal gate before a project may be called delivered — it never appears on the client's portal. Overdue means the whole due day has passed.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (m) => ({
      id: m.id,
      href: `/projects/${m.project_id}`,
      tone: (m.status === "done"
        ? "positive"
        : m.status === "blocked" || m.overdue
          ? "danger"
          : "neutral") as ArtifactTone,
      cells: {
        project: m.project,
        milestone: m.title,
        kind: m.kind === "launch_check" ? "launch check" : "milestone",
        due: m.due_date,
        owner: m.owner_id ? (owners.get(m.owner_id) ?? "—") : "—",
        status: m.overdue ? "overdue" : MILESTONE_STATUS_META[m.status].label,
      },
    })),
  };
}

// -- assets -----------------------------------------------------------------

async function datasetAssets(
  supabase: DB,
  scope: Scope,
  f: Filters,
): Promise<Dataset | string> {
  let q = supabase
    .from("project_document_requests")
    .select(
      "id, project_id, title, description, status, required, category, source, submitted_at, file_name, chase_count, last_chased_at",
    );
  if (scope.ids) q = q.in("project_id", scope.ids);
  const { data, error } = await q.order("position", { ascending: true }).limit(800);
  if (error) return error.message;

  let rows = (data ?? []).map((a) => ({ ...a, project: scope.names.get(a.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((a) => contains(a.title, f.query) || contains(a.description, f.query));
  if (f.category) rows = rows.filter((a) => a.category === f.category);
  if (f.status === "outstanding") rows = rows.filter((a) => a.status === "pending" && a.required);
  else if (["pending", "submitted", "na"].includes(f.status)) {
    rows = rows.filter((a) => a.status === f.status);
  }
  if (f.from || f.to) rows = rows.filter((a) => inWindow(a.submitted_at, f));

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "item", label: "Item" },
    { key: "category", label: "Category", format: "status", secondary: true },
    { key: "required", label: "Required", format: "status" },
    { key: "status", label: "Status", format: "status" },
    { key: "in", label: "Received", format: "datetime" },
    { key: "chased", label: "Chased", format: "number", align: "right", secondary: true },
  ];

  return {
    title: "Client asset checklist",
    subtitle: f.status === "outstanding" ? "Required and still missing" : scope.label ?? "In checklist order",
    summary:
      "Only required items count as outstanding — an optional item never holds delivery up and is never chased.",
    href: "/delivery",
    area: "delivery",
    columns,
    rows: rowsToTable(rows, columns, (a) => ({
      id: a.id,
      href: `/projects/${a.project_id}`,
      tone: (a.status === "submitted"
        ? "positive"
        : a.status === "na"
          ? "neutral"
          : a.required
            ? "warning"
            : "neutral") as ArtifactTone,
      cells: {
        project: a.project,
        item: a.title,
        category: a.category ? (ASSET_CATEGORY_LABELS[a.category] ?? a.category) : "—",
        required: a.required ? "required" : "optional",
        status: a.status === "na" ? "not applicable" : a.status,
        in: a.submitted_at,
        chased: a.chase_count,
      },
    })),
    footnote: "Assets arrive through the portal or WhatsApp; the source is recorded on each item.",
  };
}

// -- tasks ------------------------------------------------------------------

async function datasetTasks(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("todos")
    .select("id, project_id, title, status, priority, due_date, assigned_to, completed_at")
    .not("project_id", "is", null);
  if (scope.ids) q = q.in("project_id", scope.ids);
  if (f.memberId) q = q.eq("assigned_to", f.memberId);
  const { data, error } = await q.order("due_date", { ascending: true }).limit(800);
  if (error) return error.message;

  let rows = (data ?? []).map((t) => ({
    ...t,
    project: t.project_id ? (scope.names.get(t.project_id) ?? "—") : "—",
    // A timestamp, not a date: work due later today is not late yet.
    overdue: t.status !== "done" && Boolean(t.due_date) && Date.parse(t.due_date as string) < f.todayStart,
  }));
  if (f.query) rows = rows.filter((t) => contains(t.title, f.query));
  if (f.from || f.to) rows = rows.filter((t) => inWindow(t.due_date, f));
  if (f.status === "open") rows = rows.filter((t) => t.status !== "done");
  else if (f.status === "overdue") rows = rows.filter((t) => t.overdue);
  else if (["todo", "in_progress", "done"].includes(f.status)) {
    rows = rows.filter((t) => t.status === f.status);
  }

  const assignees = await memberNames(supabase, rows.map((t) => t.assigned_to));
  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "task", label: "Task" },
    { key: "who", label: "Assigned to" },
    { key: "priority", label: "Priority", format: "status", secondary: true },
    { key: "due", label: "Due", format: "datetime" },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: f.memberName ? `Project tasks — ${f.memberName}` : "Project tasks",
    subtitle: f.status ? `Filtered: ${f.status}` : scope.label ?? "By due date",
    summary: "Only tasks attached to a project. The general to-do list is a separate tool.",
    href: "/todos",
    area: "todos",
    columns,
    rows: rowsToTable(rows, columns, (t) => ({
      id: t.id,
      href: t.project_id ? `/projects/${t.project_id}` : "/todos",
      tone: (t.status === "done" ? "positive" : t.overdue ? "danger" : "neutral") as ArtifactTone,
      cells: {
        project: t.project,
        task: t.title,
        who: t.assigned_to ? (assignees.get(t.assigned_to) ?? "—") : "unassigned",
        priority: t.priority,
        due: t.due_date,
        status: t.overdue ? "overdue" : t.status === "in_progress" ? "in progress" : t.status,
      },
    })),
  };
}

// -- time -------------------------------------------------------------------

async function datasetTime(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase.from("time_entries").select("id, project_id, user_id, minutes, note, worked_on");
  if (scope.ids) q = q.in("project_id", scope.ids);
  if (f.memberId) q = q.eq("user_id", f.memberId);
  if (f.from) q = q.gte("worked_on", f.from);
  if (f.to) q = q.lte("worked_on", f.to);
  const { data, error } = await q.order("worked_on", { ascending: false }).limit(800);
  if (error) return error.message;

  let rows = (data ?? []).map((t) => ({ ...t, project: scope.names.get(t.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((t) => contains(t.note, f.query) || contains(t.project, f.query));

  const people = await memberNames(supabase, rows.map((t) => t.user_id));
  const columns: ArtifactColumn[] = [
    { key: "date", label: "Day", format: "date" },
    { key: "project", label: "Project" },
    { key: "who", label: "Who" },
    { key: "time", label: "Time", format: "status", align: "right" },
    { key: "hours", label: "Hours", format: "number", align: "right", secondary: true },
    { key: "note", label: "On what", secondary: true },
  ];
  const minutes = total(rows, (t) => num(t.minutes));

  return {
    title: f.memberName ? `Time logged — ${f.memberName}` : "Time logged",
    subtitle: `${formatMinutes(minutes)} across ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`,
    summary: "Logged hours only — nothing here is an estimate, so a project with no entries is untracked, not free.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (t) => ({
      id: t.id,
      href: `/projects/${t.project_id}`,
      cells: {
        date: t.worked_on,
        project: t.project,
        who: people.get(t.user_id) ?? "—",
        time: formatMinutes(num(t.minutes)),
        hours: round1(num(t.minutes) / 60),
        note: t.note ?? "—",
      },
    })),
    total_label: "Hours in this list",
    total_value: round1(minutes / 60),
    total_format: "number",
  };
}

// -- expenses ---------------------------------------------------------------

async function datasetExpenses(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("project_expenses")
    .select(
      "id, project_id, description, detail, category, vendor, qty, unit_amount, amount, currency, incurred_on, billable, invoiced_at, receipt_url",
    );
  if (scope.ids) q = q.in("project_id", scope.ids);
  if (f.from) q = q.gte("incurred_on", f.from);
  if (f.to) q = q.lte("incurred_on", f.to);
  if (f.category) q = q.eq("category", f.category);
  const { data, error } = await q.order("incurred_on", { ascending: false }).limit(800);
  if (error) return error.message;

  let rows = (data ?? []).map((e) => ({ ...e, project: scope.names.get(e.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((e) => contains(e.description, f.query) || contains(e.vendor, f.query));
  if (f.status === "billable") rows = rows.filter((e) => e.billable);
  else if (f.status === "absorbed") rows = rows.filter((e) => !e.billable);
  else if (f.status === "invoiced") rows = rows.filter((e) => e.invoiced_at);
  else if (f.status === "uninvoiced") rows = rows.filter((e) => e.billable && !e.invoiced_at);

  const columns: ArtifactColumn[] = [
    { key: "date", label: "Incurred", format: "date" },
    { key: "project", label: "Project" },
    { key: "description", label: "Cost" },
    { key: "category", label: "Category", format: "status", secondary: true },
    { key: "vendor", label: "Vendor", secondary: true },
    { key: "amount", label: "Amount", format: "money", align: "right" },
    { key: "billable", label: "Billable", format: "status" },
    { key: "invoiced", label: "Invoiced", format: "status", secondary: true },
  ];

  return {
    title: "Additional project costs",
    subtitle: f.status ? `Filtered: ${f.status}` : scope.label ?? "Newest first",
    summary:
      "Costs raised ON a project after it was quoted. A billable one goes on the client's invoice and nets out of the margin; an absorbed one is ours and eats it.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (e) => ({
      id: e.id,
      href: `/projects/${e.project_id}`,
      tone: (e.billable ? (e.invoiced_at ? "positive" : "info") : "warning") as ArtifactTone,
      cells: {
        date: e.incurred_on,
        project: e.project,
        description: e.description,
        category: e.category ? (PROJECT_EXPENSE_CATEGORY_LABELS[e.category] ?? e.category) : "—",
        vendor: e.vendor ?? "—",
        amount: money(num(e.amount)),
        billable: e.billable ? "billable" : "absorbed",
        invoiced: e.invoiced_at ? "yes" : "no",
      },
    })),
    total_label: "Total raised",
    total_value: money(total(rows, (e) => num(e.amount))),
    total_format: "money",
    footnote:
      "Costs booked in Money & Finance against a project are a separate ledger and are not listed here, though they do count against the project's margin.",
  };
}

// -- approvals --------------------------------------------------------------

async function datasetApprovals(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("project_approvals")
    .select("id, project_id, title, detail, status, signer_name, signed_at, response_note, created_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  if ((APPROVAL_STATUSES as string[]).includes(f.status)) {
    q = q.eq("status", f.status as ApprovalStatus);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((a) => ({ ...a, project: scope.names.get(a.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((a) => contains(a.title, f.query) || contains(a.detail, f.query));
  if (f.from || f.to) rows = rows.filter((a) => inWindow(a.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "item", label: "Up for approval" },
    { key: "status", label: "Status", format: "status" },
    { key: "signer", label: "Signed by", secondary: true },
    { key: "signed", label: "Signed", format: "datetime" },
    { key: "note", label: "They said", secondary: true },
    { key: "asked", label: "Asked", format: "datetime", secondary: true },
  ];

  return {
    title: "Client approvals",
    subtitle: f.status === "pending" ? "Waiting on the client" : scope.label ?? "Newest first",
    summary: "Work put in front of the client for sign-off. Pending means nobody has answered yet.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (a) => ({
      id: a.id,
      href: `/projects/${a.project_id}`,
      tone: (a.status === "approved"
        ? "positive"
        : a.status === "changes_requested"
          ? "warning"
          : "info") as ArtifactTone,
      cells: {
        project: a.project,
        item: a.title,
        status: a.status === "changes_requested" ? "changes asked for" : a.status,
        signer: a.signer_name ?? "—",
        signed: a.signed_at,
        note: a.response_note ?? "—",
        asked: a.created_at,
      },
    })),
  };
}

// -- change requests --------------------------------------------------------

async function datasetChangeRequests(
  supabase: DB,
  scope: Scope,
  f: Filters,
): Promise<Dataset | string> {
  let q = supabase
    .from("project_change_requests")
    .select(
      "id, project_id, body, status, quoted_amount, quote_note, source, client_name, ai_flagged, ai_reason, created_at, updated_at",
    );
  if (scope.ids) q = q.in("project_id", scope.ids);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((c) => ({ ...c, project: scope.names.get(c.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((c) => contains(c.body, f.query));
  if (f.from || f.to) rows = rows.filter((c) => inWindow(c.created_at, f));
  // "Waiting on us" is the project page's own definition, not a stored status.
  if (f.status === "waiting") rows = rows.filter((c) => ["new", "quoted"].includes(c.status));
  else if (["new", "quoted", "accepted", "declined"].includes(f.status)) {
    rows = rows.filter((c) => c.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "when", label: "Asked", format: "datetime" },
    { key: "project", label: "Project" },
    { key: "request", label: "What they asked for", format: "multiline" },
    { key: "status", label: "Status", format: "status" },
    { key: "quoted", label: "Quoted", format: "money", align: "right" },
    { key: "note", label: "Our note", secondary: true },
    { key: "source", label: "Came in via", format: "status", secondary: true },
  ];

  return {
    title: "Change requests",
    subtitle: f.status === "waiting" ? "Waiting on us" : scope.label ?? "Newest first",
    summary:
      "Anything asked for after the quote. 'Waiting on us' means new or quoted — the client is holding, not the team.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: `/projects/${c.project_id}`,
      tone: (c.status === "accepted"
        ? "positive"
        : c.status === "declined"
          ? "neutral"
          : "warning") as ArtifactTone,
      cells: {
        when: c.created_at,
        project: c.project,
        request: c.body,
        status: c.status,
        quoted: c.quoted_amount === null ? null : money(num(c.quoted_amount)),
        note: c.quote_note ?? (c.ai_flagged ? `AI: ${c.ai_reason ?? "possible scope creep"}` : "—"),
        source: c.source,
      },
    })),
    total_label: "Quoted across these",
    total_value: money(total(rows, (c) => num(c.quoted_amount))),
    total_format: "money",
  };
}

// -- comments ---------------------------------------------------------------

async function datasetComments(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("project_comments")
    .select("id, project_id, author_type, author_name, body, created_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((c) => ({ ...c, project: scope.names.get(c.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((c) => contains(c.body, f.query) || contains(c.author_name, f.query));
  if (f.from || f.to) rows = rows.filter((c) => inWindow(c.created_at, f));
  if (f.status === "client" || f.status === "team") rows = rows.filter((c) => c.author_type === f.status);

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "project", label: "Project" },
    { key: "who", label: "Who" },
    { key: "side", label: "Side", format: "status", secondary: true },
    { key: "body", label: "Said", format: "multiline" },
  ];

  return {
    title: "Project conversation",
    subtitle: scope.label ?? "Newest first",
    summary: "Comments on the project, from the team and from the client's portal.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: `/projects/${c.project_id}`,
      tone: (c.author_type === "client" ? "info" : "neutral") as ArtifactTone,
      cells: {
        when: c.created_at,
        project: c.project,
        who: c.author_name,
        side: c.author_type,
        body: c.body,
      },
    })),
  };
}

// -- pulses -----------------------------------------------------------------

const PULSE_WORDS: Record<number, string> = { 1: "unhappy", 2: "fine", 3: "delighted" };

async function datasetPulses(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase.from("project_pulses").select("id, project_id, score, note, created_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((p) => ({ ...p, project: scope.names.get(p.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((p) => contains(p.note, f.query) || contains(p.project, f.query));
  if (f.from || f.to) rows = rows.filter((p) => inWindow(p.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "project", label: "Project" },
    { key: "score", label: "Score", format: "number", align: "right" },
    { key: "mood", label: "Mood", format: "status" },
    { key: "note", label: "They said", secondary: true },
  ];

  return {
    title: "How the client says it is going",
    subtitle: scope.label ?? "Newest first",
    summary:
      "A pulse is 1 to 3: unhappy, fine, delighted. The project page averages them rather than showing the latest, so one bad day does not define a job.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (p) => ({
      id: p.id,
      href: `/projects/${p.project_id}`,
      tone: (p.score >= 3 ? "positive" : p.score === 2 ? "neutral" : "danger") as ArtifactTone,
      cells: {
        when: p.created_at,
        project: p.project,
        score: p.score,
        mood: PULSE_WORDS[p.score] ?? String(p.score),
        note: p.note ?? "—",
      },
    })),
  };
}

// -- reviews ----------------------------------------------------------------

async function datasetReviews(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("project_reviews")
    .select(
      "id, project_id, status, rating, headline, body, publishable, client_name, requested_at, submitted_at",
    );
  if (scope.ids) q = q.in("project_id", scope.ids);
  if ((REVIEW_STATUSES as string[]).includes(f.status)) {
    q = q.eq("status", f.status as ReviewStatus);
  }
  const { data, error } = await q.order("requested_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((r) => ({ ...r, project: scope.names.get(r.project_id) ?? "—" }));
  if (f.query) rows = rows.filter((r) => contains(r.headline, f.query) || contains(r.body, f.query));
  if (f.from || f.to) rows = rows.filter((r) => inWindow(r.submitted_at ?? r.requested_at, f));

  const columns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "status", label: "Status", format: "status" },
    { key: "rating", label: "Rating", format: "number", align: "right" },
    { key: "headline", label: "Headline" },
    { key: "body", label: "In full", format: "multiline", secondary: true },
    { key: "client", label: "Client", secondary: true },
    { key: "when", label: "Submitted", format: "datetime" },
    { key: "publish", label: "May publish", format: "status", secondary: true },
  ];

  return {
    title: "Client reviews",
    subtitle: scope.label ?? "Newest first",
    summary: "Consent to publish is given by the client, never assumed — check 'May publish' before quoting one anywhere.",
    href: "/projects",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: `/projects/${r.project_id}`,
      tone: (r.status === "submitted"
        ? (r.rating ?? 0) >= 4
          ? "positive"
          : "warning"
        : r.status === "declined"
          ? "neutral"
          : "info") as ArtifactTone,
      cells: {
        project: r.project,
        status: r.status,
        rating: r.rating,
        headline: r.headline ?? "—",
        body: r.body ?? "—",
        client: r.client_name ?? "—",
        when: r.submitted_at,
        publish: r.publishable ? "yes" : "no",
      },
    })),
  };
}

// -- activity ---------------------------------------------------------------

async function datasetActivity(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase.from("delivery_events").select("id, project_id, kind, detail, actor, created_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  if (f.from) q = q.gte("created_at", `${f.from}T00:00:00+05:30`);
  if (f.to) q = q.lte("created_at", colomboEndIso(f.to));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return error.message;

  let rows = (data ?? []).map((e) => ({ ...e, project: scope.names.get(e.project_id) ?? "—" }));
  // `status` doubles as the event kind here — there are twenty-one of them and
  // an enum that long in the schema would cost more than it buys.
  if (f.status) rows = rows.filter((e) => e.kind === f.status);
  if (f.query) rows = rows.filter((e) => contains(e.detail, f.query) || contains(e.project, f.query));

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "project", label: "Project" },
    { key: "event", label: "What happened", format: "status" },
    { key: "detail", label: "Detail" },
    { key: "actor", label: "By", format: "status", secondary: true },
  ];

  return {
    title: "Delivery activity",
    subtitle: f.status ? `Only ${f.status.replace(/_/g, " ")}` : scope.label ?? "Newest first",
    summary: "Every stage move, chase, asset, portal send, approval and review, as it happened.",
    href: "/delivery",
    area: "delivery",
    columns,
    rows: rowsToTable(rows, columns, (e) => ({
      id: e.id,
      href: `/projects/${e.project_id}`,
      tone: (e.kind === "stalled_alert"
        ? "danger"
        : e.kind === "chase_sent" || e.kind === "change_requested"
          ? "warning"
          : e.kind === "assets_complete" || e.kind === "approval_signed" || e.kind === "review_received"
            ? "positive"
            : "neutral") as ArtifactTone,
      cells: {
        when: e.created_at,
        project: e.project,
        event: e.kind.replace(/_/g, " "),
        detail: e.detail ?? "—",
        actor: e.actor ?? "—",
      },
    })),
  };
}

// -- websites ---------------------------------------------------------------

async function datasetWebsites(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("website_projects")
    .select("id, name, url, progress, status, notes, launched_at, project_id, client_id, updated_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  if ((WEBSITE_STATUSES as string[]).includes(f.status)) {
    q = q.eq("status", f.status as WebsiteStatus);
  }
  const { data, error } = await q.order("progress", { ascending: false }).limit(300);
  if (error) return error.message;

  let rows = (data ?? []).map((w) => ({
    ...w,
    project: w.project_id ? (scope.names.get(w.project_id) ?? "—") : "not linked",
  }));
  if (f.query) rows = rows.filter((w) => contains(w.name, f.query) || contains(w.url, f.query));
  if (f.from || f.to) rows = rows.filter((w) => inWindow(w.launched_at, f));

  const columns: ArtifactColumn[] = [
    { key: "site", label: "Website" },
    { key: "url", label: "Address", format: "url", secondary: true },
    { key: "progress", label: "Progress", format: "percent", align: "right" },
    { key: "status", label: "Status", format: "status" },
    { key: "project", label: "Project", secondary: true },
    { key: "launched", label: "Launched", format: "datetime" },
    { key: "notes", label: "Notes", secondary: true },
  ];

  return {
    title: "Website builds",
    subtitle:
      f.status === "waiting_client"
        ? "Waiting on the client"
        : f.status
          ? `Filtered: ${f.status}`
          : "Furthest along first",
    summary: "Launching a site sets it to 100% and stamps the launch date, so progress and status never disagree.",
    href: "/website-progress",
    area: "website",
    columns,
    rows: rowsToTable(rows, columns, (w) => ({
      id: w.id,
      href: w.project_id ? `/projects/${w.project_id}` : "/website-progress",
      tone: (w.status === "launched"
        ? "positive"
        : w.status === "waiting_client"
          ? "warning"
          : "info") as ArtifactTone,
      cells: {
        site: w.name,
        url: w.url,
        progress: w.progress,
        status: WEBSITE_STATUS_META[w.status].label,
        project: w.project,
        launched: w.launched_at,
        notes: w.notes || "—",
      },
    })),
  };
}

// -- resources --------------------------------------------------------------

async function datasetResources(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("resources")
    .select("id, name, description, kind, file_url, file_type, file_size, link_url, uploaded_by, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) {
    rows = rows.filter((r) => contains(r.name, f.query) || contains(r.description, f.query));
  }
  if (f.status === "file" || f.status === "link") rows = rows.filter((r) => r.kind === f.status);
  if (f.from || f.to) rows = rows.filter((r) => inWindow(r.created_at, f));

  const uploaders = await memberNames(supabase, rows.map((r) => r.uploaded_by));
  const columns: ArtifactColumn[] = [
    { key: "name", label: "Resource" },
    { key: "kind", label: "Kind", format: "status" },
    { key: "where", label: "Opens", format: "url" },
    { key: "description", label: "What it is", secondary: true },
    { key: "who", label: "Added by", secondary: true },
    { key: "when", label: "Added", format: "datetime" },
  ];

  return {
    title: "Resources",
    subtitle: "Newest first",
    summary: "Shared files and links. Workspace-wide — resources are not attached to a project.",
    href: "/resources",
    area: "resources",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: "/resources",
      cells: {
        name: r.name,
        kind: r.kind,
        where: r.kind === "link" ? r.link_url : r.file_url,
        description: r.description ?? "—",
        who: r.uploaded_by ? (uploaders.get(r.uploaded_by) ?? "—") : "—",
        when: r.created_at,
      },
    })),
  };
}

// -- templates --------------------------------------------------------------

async function datasetTemplates(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [templateRes, itemRes] = await Promise.all([
    supabase
      .from("project_templates")
      .select("id, name, service_type, description, default_value, default_currency, default_days, is_active")
      .order("name", { ascending: true })
      .limit(200),
    supabase.from("project_template_items").select("template_id, kind").limit(2000),
  ]);
  if (templateRes.error) return templateRes.error.message;
  if (itemRes.error) return itemRes.error.message;

  const counts = new Map<string, Record<string, number>>();
  for (const i of itemRes.data ?? []) {
    const c = counts.get(i.template_id) ?? { task: 0, asset: 0, milestone: 0, launch_check: 0 };
    c[i.kind] = (c[i.kind] ?? 0) + 1;
    counts.set(i.template_id, c);
  }

  let rows = templateRes.data ?? [];
  if (f.query) rows = rows.filter((t) => contains(t.name, f.query) || contains(t.description, f.query));
  if (f.status === "active") rows = rows.filter((t) => t.is_active);
  else if (f.status === "inactive") rows = rows.filter((t) => !t.is_active);

  const columns: ArtifactColumn[] = [
    { key: "name", label: "Template" },
    { key: "service", label: "Service", format: "status" },
    { key: "value", label: "Default value", format: "money", align: "right" },
    { key: "days", label: "Days", format: "number", align: "right", secondary: true },
    { key: "plan", label: "What it seeds" },
    { key: "active", label: "Active", format: "status" },
  ];

  return {
    title: "Project templates",
    subtitle: "The plans a new project can be built from",
    summary:
      "Applying a template is idempotent — it skips anything already on the project — and its dates come from the project's start date plus each item's offset.",
    href: "/projects/templates",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (t) => {
      const c = counts.get(t.id) ?? { task: 0, asset: 0, milestone: 0, launch_check: 0 };
      return {
        id: t.id,
        href: "/projects/templates",
        tone: (t.is_active ? "positive" : "neutral") as ArtifactTone,
        cells: {
          name: t.name,
          service: serviceLabel(t.service_type),
          value: t.default_value === null ? null : money(num(t.default_value)),
          days: t.default_days,
          plan: `${c.task ?? 0} tasks · ${c.asset ?? 0} assets · ${c.milestone ?? 0} milestones · ${c.launch_check ?? 0} launch checks`,
          active: t.is_active ? "active" : "off",
        },
      };
    }),
  };
}

// -- lessons ----------------------------------------------------------------

async function datasetLessons(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("project_lessons")
    .select("id, project_id, project_name, title, body, category, status, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) return error.message;

  let rows = data ?? [];
  if (scope.ids) {
    const ids = new Set(scope.ids);
    // project_name is denormalised so a lesson outlives its project — match on
    // either, or a lesson from an archived job disappears from its own client.
    const names = new Set(scope.projects.map((p) => p.name.toLowerCase()));
    rows = rows.filter(
      (l) => (l.project_id && ids.has(l.project_id)) || names.has(l.project_name.toLowerCase()),
    );
  }
  if (f.query) rows = rows.filter((l) => contains(l.title, f.query) || contains(l.body, f.query));
  if (f.category) rows = rows.filter((l) => l.category === f.category);
  if (["new", "kept", "dismissed"].includes(f.status)) rows = rows.filter((l) => l.status === f.status);
  if (f.from || f.to) rows = rows.filter((l) => inWindow(l.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "title", label: "Lesson" },
    { key: "project", label: "From", secondary: true },
    { key: "category", label: "About", format: "status" },
    { key: "body", label: "In full", format: "multiline" },
    { key: "status", label: "Kept", format: "status" },
    { key: "when", label: "Noticed", format: "datetime", secondary: true },
  ];

  return {
    title: "Lessons from finished work",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary: "What the AI layer noticed about past projects. 'New' means nobody has decided whether to keep it.",
    href: "/projects/insights",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (l) => ({
      id: l.id,
      href: l.project_id ? `/projects/${l.project_id}` : "/projects/insights",
      tone: (l.status === "kept" ? "positive" : l.status === "dismissed" ? "neutral" : "info") as ArtifactTone,
      cells: {
        title: l.title,
        project: l.project_name,
        category: l.category,
        body: l.body,
        status: l.status,
        when: l.created_at,
      },
    })),
  };
}

// -- anomalies --------------------------------------------------------------

async function datasetAnomalies(supabase: DB, scope: Scope, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("project_anomalies")
    .select("id, project_id, kind, detail, status, created_at, resolved_at");
  if (scope.ids) q = q.in("project_id", scope.ids);
  if ((ANOMALY_STATUSES as string[]).includes(f.status)) {
    q = q.eq("status", f.status as ProjectAnomalyStatus);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(300);
  if (error) return error.message;

  let rows = (data ?? []).map((a) => ({
    ...a,
    project: a.project_id ? (scope.names.get(a.project_id) ?? "—") : "—",
  }));
  if (f.query) rows = rows.filter((a) => contains(a.detail, f.query));
  if (f.from || f.to) rows = rows.filter((a) => inWindow(a.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "kind", label: "What was spotted", format: "status" },
    { key: "project", label: "Project" },
    { key: "detail", label: "Detail", format: "multiline" },
    { key: "status", label: "Status", format: "status" },
    { key: "when", label: "Spotted", format: "datetime" },
  ];

  return {
    title: "Bookkeeping guards",
    subtitle: f.status ? `Filtered: ${f.status}` : "Open first",
    summary:
      "Pairs of records that look like the same thing entered twice, or a payment larger than the project's value. Flagged, never auto-corrected — only a person knows which row is the real one.",
    href: "/projects/insights",
    area: "projects",
    columns,
    rows: rowsToTable(rows, columns, (a) => ({
      id: a.id,
      href: a.project_id ? `/projects/${a.project_id}` : "/projects/insights",
      tone: (a.status === "open" ? "warning" : a.status === "fixed" ? "positive" : "neutral") as ArtifactTone,
      cells: {
        kind: a.kind.replace(/_/g, " "),
        project: a.project,
        detail: a.detail,
        status: a.status,
        when: a.created_at,
      },
    })),
  };
}

// -- the tool ---------------------------------------------------------------

/** Datasets with no project column — a project filter cannot narrow them. */
const WORKSPACE_WIDE = new Set(["resources", "templates"]);

async function deliveryQuery(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const dataset = str(args.dataset).toLowerCase();

  const scopeResult = await readScope(supabase, args);
  if ("error" in scopeResult) return { content: { ok: false, error: scopeResult.error } };

  // Resources and templates have no project column, so a project filter cannot
  // narrow them and must not be allowed to refuse them either.
  const scope: Scope = WORKSPACE_WIDE.has(dataset)
    ? { ...scopeResult, ids: null, empty: null }
    : scopeResult;
  if (scope.empty) {
    return {
      content: {
        ok: false,
        reason: `${scope.empty} Say so rather than answering about a different project.`,
      },
    };
  }

  const member = await resolveMember(ctx, args.member);
  if (str(args.member) && !member) {
    return { content: { ok: false, reason: `No team member matching "${str(args.member)}".` } };
  }

  const from = isDate(str(args.from)) ? str(args.from) : null;
  const to = isDate(str(args.to)) ? str(args.to) : null;
  const f: Filters = {
    status: str(args.status).toLowerCase(),
    category: str(args.category).toLowerCase(),
    query: str(args.query),
    from,
    to,
    memberId: member?.id ?? null,
    memberName: member?.name ?? null,
    limit: clampLimit(args.limit),
    today: ctx.today,
    todayStart: colomboStart(ctx.today),
  };

  let built: Dataset | string;
  switch (dataset) {
    case "projects": built = await datasetProjects(supabase, scope, f); break;
    case "milestones": built = await datasetMilestones(supabase, scope, f); break;
    case "assets": built = await datasetAssets(supabase, scope, f); break;
    case "tasks": built = await datasetTasks(supabase, scope, f); break;
    case "time": built = await datasetTime(supabase, scope, f); break;
    case "expenses": built = await datasetExpenses(supabase, scope, f); break;
    case "approvals": built = await datasetApprovals(supabase, scope, f); break;
    case "change_requests": built = await datasetChangeRequests(supabase, scope, f); break;
    case "comments": built = await datasetComments(supabase, scope, f); break;
    case "pulses": built = await datasetPulses(supabase, scope, f); break;
    case "reviews": built = await datasetReviews(supabase, scope, f); break;
    case "activity": built = await datasetActivity(supabase, scope, f); break;
    case "websites": built = await datasetWebsites(supabase, scope, f); break;
    case "resources": built = await datasetResources(supabase, f); break;
    case "templates": built = await datasetTemplates(supabase, f); break;
    case "lessons": built = await datasetLessons(supabase, scope, f); break;
    case "anomalies": built = await datasetAnomalies(supabase, scope, f); break;
    default:
      return { content: { ok: false, error: `"${dataset}" is not a delivery dataset.` } };
  }
  if (typeof built === "string") return { content: { ok: false, error: built } };

  const matched = built.rows.length;
  const shown = built.rows.slice(0, f.limit);

  if (!matched) {
    return {
      content: {
        ok: false,
        dataset,
        reason: `Nothing in ${built.title.toLowerCase()} matches that. Relay it plainly rather than filling the gap.`,
        filters: {
          project: str(args.project) || null,
          client: str(args.client) || null,
          status: f.status || null,
          category: f.category || null,
          member: f.memberName,
          from: f.from,
          to: f.to,
        },
      },
      event: { kind: "read", label: built.title, href: built.href },
      artifacts: [
        tableArtifact({
          title: built.title,
          subtitle: "No matching records",
          summary: built.summary,
          href: built.href,
          area: built.area,
          columns: built.columns,
          rows: [],
        }),
      ],
    };
  }

  return {
    content: {
      ok: true,
      dataset,
      currency: "LKR",
      matched,
      shown: shown.length,
      scope: scope.label,
      total_label: built.total_label ?? null,
      total_value: built.total_value ?? null,
      note: built.summary ?? null,
      // The same cells the artifact shows, capped: the full list is already in
      // the preview canvas, and the model should not pay for it twice.
      rows: shown.slice(0, 15).map((r) => r.cells),
    },
    event: { kind: "read", label: built.title, href: built.href },
    artifacts: [
      tableArtifact({
        title: built.title,
        subtitle: built.subtitle,
        summary: built.summary,
        href: built.href,
        area: built.area,
        columns: built.columns,
        rows: shown,
        ...(matched > shown.length ? { truncated: matched - shown.length } : {}),
        ...(built.total_label
          ? {
              total_label: built.total_label,
              total_value: built.total_value ?? 0,
              total_format: built.total_format ?? "money",
            }
          : {}),
        ...(built.footnote ? { footnote: built.footnote } : {}),
      }),
    ],
  };
}

// ---- delivery_board -------------------------------------------------------

async function deliveryBoard(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const { rows: projects, error } = await loadProjects(supabase);
  if (error) return { content: { ok: false, error } };
  if (!projects.length) {
    return {
      content: { ok: false, reason: "There are no live projects — the delivery board is empty." },
    };
  }

  const [assetRes, settingsRes, clientRes, moneyMap] = await Promise.all([
    supabase.from("project_document_requests").select("project_id, status, required").limit(5000),
    supabase.from("delivery_settings").select("stalled_days, chaser_enabled").eq("id", 1).maybeSingle(),
    supabase.from("clients").select("id, name").limit(500),
    moneyForProjects(supabase, projects),
  ]);
  if (assetRes.error) return { content: { ok: false, error: assetRes.error.message } };

  const stalledDays = settingsRes.data?.stalled_days ?? 5;
  const clientNames = new Map((clientRes.data ?? []).map((c) => [c.id, c.name]));
  const checklists = new Map<string, { status: string; required: boolean }[]>();
  for (const a of assetRes.data ?? []) {
    const list = checklists.get(a.project_id) ?? [];
    list.push({ status: a.status, required: a.required });
    checklists.set(a.project_id, list);
  }

  const now = Date.now();
  const enriched = projects.map((p) => {
    const cash = moneyMap.get(p.id) ?? { value: 0, received: 0, balance: 0, percent: 0 };
    const out = outstandingAssets(checklists.get(p.id) ?? []);
    const finished = ["delivered", "aftercare"].includes(p.delivery_stage ?? "");
    return {
      ...p,
      client: p.client_id ? (clientNames.get(p.client_id) ?? "—") : "—",
      cash,
      outstanding: out,
      idle: daysSince(p.delivery_stage_changed_at ?? p.updated_at) ?? 0,
      blocked: Boolean(p.blocked_reason),
      // A blocked project is waiting on someone else — the nightly scan skips
      // it for exactly this reason, and so does the board.
      stalled:
        Boolean(p.delivery_stage) &&
        !finished &&
        !p.blocked_reason &&
        now - Date.parse(p.updated_at) > stalledDays * 86_400_000,
      waiting:
        Boolean(p.delivery_stage) &&
        ["onboarding", "assets"].includes(p.delivery_stage ?? "") &&
        out > 0,
      overdue: Boolean(p.due_date && p.due_date < ctx.today && p.status !== "completed"),
    };
  });

  const live = enriched.filter((p) => ["planning", "active", "on_hold"].includes(p.status));
  const stageRows = [
    ...DELIVERY_STAGES.map((stage) => ({
      key: stage as string,
      label: DELIVERY_STAGE_META[stage].label,
      items: enriched.filter((p) => p.delivery_stage === stage),
    })),
    { key: "none", label: "Not started", items: enriched.filter((p) => !p.delivery_stage) },
  ].map((s) => ({
    ...s,
    count: s.items.length,
    value: total(s.items, (p) => p.cash.value),
    received: total(s.items, (p) => p.cash.received),
    balance: total(s.items, (p) => p.cash.balance),
    assets: total(s.items, (p) => p.outstanding),
    stalled: s.items.filter((p) => p.stalled).length,
  }));

  const stuck = enriched
    .filter((p) => p.stalled || p.blocked || p.waiting || p.overdue)
    .filter((p) => !["completed", "cancelled"].includes(p.status))
    .sort((a, b) => b.idle - a.idle);

  const metrics: ArtifactField[] = [
    { label: "Live projects", value: live.length, format: "number", tone: "info" },
    {
      label: "In a delivery stage",
      value: enriched.filter((p) => p.delivery_stage).length,
      format: "number",
    },
    {
      label: "Waiting on the client",
      value: enriched.filter((p) => p.waiting).length,
      format: "number",
      tone: "warning",
    },
    {
      label: "Stalled",
      value: enriched.filter((p) => p.stalled).length,
      format: "number",
      tone: enriched.some((p) => p.stalled) ? "danger" : "positive",
    },
    {
      label: "Blocked",
      value: enriched.filter((p) => p.blocked).length,
      format: "number",
      tone: "warning",
    },
    {
      label: "Not started",
      value: enriched.filter((p) => !p.delivery_stage).length,
      format: "number",
    },
    {
      label: "Value in flight",
      value: money(total(live, (p) => p.cash.value)),
      format: "money",
    },
    {
      label: "Owed on delivered work",
      value: money(
        total(
          enriched.filter((p) => ["delivered", "aftercare"].includes(p.delivery_stage ?? "")),
          (p) => p.cash.balance,
        ),
      ),
      format: "money",
      tone: "warning",
    },
  ];

  const stageColumns: ArtifactColumn[] = [
    { key: "stage", label: "Stage" },
    { key: "count", label: "Projects", format: "number", align: "right" },
    { key: "value", label: "Value", format: "money", align: "right" },
    { key: "received", label: "Received", format: "money", align: "right", secondary: true },
    { key: "balance", label: "Still owed", format: "money", align: "right" },
    { key: "assets", label: "Assets out", format: "number", align: "right", secondary: true },
    { key: "stalled", label: "Stalled", format: "number", align: "right" },
  ];

  const stuckColumns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "client", label: "Client", secondary: true },
    { key: "stage", label: "Stage", format: "status" },
    { key: "why", label: "Why it needs you" },
    { key: "idle", label: "Idle days", format: "number", align: "right" },
    { key: "balance", label: "Balance", format: "money", align: "right", secondary: true },
  ];

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: "Client Delivery",
      subtitle: `Stalled after ${stalledDays} days without movement`,
      summary:
        "A blocked project is waiting on someone else, so it is never counted as stalled — that is the whole point of marking it blocked.",
      href: "/delivery",
      area: "delivery",
      metrics,
      actions: [{ label: "Open Client Delivery", href: "/delivery", icon: "PackageCheck" }],
    }),
    chartArtifact({
      title: "Projects by stage",
      subtitle: "The delivery pipeline, left to right",
      href: "/delivery",
      area: "delivery",
      chart: "bar",
      format: "number",
      points: stageRows.map((s) => ({
        label: s.label,
        value: s.count,
        tone: (s.stalled > 0 ? "warning" : s.key === "none" ? "neutral" : "info") as ArtifactTone,
      })),
    }),
    tableArtifact({
      title: "Each stage, and what it is worth",
      href: "/delivery",
      area: "delivery",
      columns: stageColumns,
      rows: rowsToTable(stageRows, stageColumns, (s) => ({
        id: s.key,
        href: "/delivery",
        tone: (s.stalled > 0 ? "warning" : "neutral") as ArtifactTone,
        cells: {
          stage: s.label,
          count: s.count,
          value: money(s.value),
          received: money(s.received),
          balance: money(s.balance),
          assets: s.assets,
          stalled: s.stalled,
        },
      })),
      total_label: "Still owed across the board",
      total_value: money(total(stageRows, (s) => s.balance)),
      total_format: "money",
    }),
  ];

  if (stuck.length) {
    artifacts.push(
      tableArtifact({
        title: "Needs a nudge",
        subtitle: "Longest without movement first",
        summary:
          "Stalled, blocked, waiting on the client, or past its due date — the four ways a delivery goes quiet.",
        href: "/delivery",
        area: "delivery",
        columns: stuckColumns,
        rows: rowsToTable(stuck, stuckColumns, (p) => ({
          id: p.id,
          href: `/projects/${p.id}`,
          tone: (p.stalled || p.overdue ? "danger" : "warning") as ArtifactTone,
          cells: {
            project: p.name,
            client: p.client,
            stage: stageLabel(p.delivery_stage),
            why: [
              p.blocked ? `blocked — ${p.blocked_reason}` : null,
              p.stalled ? `no movement for ${p.idle} days` : null,
              p.waiting ? `${p.outstanding} asset${p.outstanding === 1 ? "" : "s"} outstanding` : null,
              p.overdue ? `past its ${p.due_date} due date` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            idle: p.idle,
            balance: money(p.cash.balance),
          },
        })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      currency: "LKR",
      stalled_after_days: stalledDays,
      chaser_enabled: settingsRes.data?.chaser_enabled ?? null,
      totals: {
        live: live.length,
        in_delivery: enriched.filter((p) => p.delivery_stage).length,
        waiting_on_client: enriched.filter((p) => p.waiting).length,
        stalled: enriched.filter((p) => p.stalled).length,
        blocked: enriched.filter((p) => p.blocked).length,
        not_started: enriched.filter((p) => !p.delivery_stage).length,
        value_in_flight: money(total(live, (p) => p.cash.value)),
      },
      stages: stageRows.map((s) => ({
        stage: s.label,
        projects: s.count,
        value: money(s.value),
        still_owed: money(s.balance),
        assets_outstanding: s.assets,
        stalled: s.stalled,
      })),
      needs_a_nudge: stuck.slice(0, 15).map((p) => ({
        project: p.name,
        client: p.client,
        stage: stageLabel(p.delivery_stage),
        idle_days: p.idle,
        blocked: p.blocked_reason,
        stalled: p.stalled,
        assets_outstanding: p.outstanding,
        past_due: p.overdue,
        balance: money(p.cash.balance),
      })),
      note: "Stalled excludes blocked projects on purpose. Use project_dossier for the full picture on any one of these.",
    },
    event: { kind: "read", label: "Client Delivery board", href: "/delivery" },
    artifacts,
  };
}

// ---- meetings_agenda ------------------------------------------------------

async function meetingsAgenda(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const from = isDate(str(args.from)) ? str(args.from) : ctx.today;
  const to = isDate(str(args.to)) ? str(args.to) : shiftDay(from, 7);
  if (to < from) {
    return { content: { ok: false, error: "The window ends before it starts." } };
  }

  const member = await resolveMember(ctx, args.member);
  if (str(args.member) && !member) {
    return { content: { ok: false, reason: `No team member matching "${str(args.member)}".` } };
  }

  const startIso = new Date(`${from}T00:00:00+05:30`).toISOString();
  const endIso = colomboEndIso(to);

  const [meetingRes, bookingRes, linkRes, clientRes] = await Promise.all([
    supabase
      .from("meetings")
      .select(
        "id, title, description, meeting_at, duration_minutes, location_type, location, meeting_url, client_id, created_by, reminder_hours, reminder_sent_at",
      )
      .gte("meeting_at", startIso)
      .lte("meeting_at", endIso)
      .order("meeting_at", { ascending: true })
      .limit(200),
    supabase
      .from("meeting_bookings")
      .select("id, meeting_link_id, client_name, client_email, client_phone, notes, booking_date, start_time, end_time, status")
      .gte("booking_date", from)
      .lte("booking_date", to)
      .eq("status", "confirmed")
      .order("booking_date", { ascending: true })
      .limit(200),
    supabase.from("meeting_links").select("id, title, slug, duration_minutes").limit(100),
    supabase.from("clients").select("id, name, company, phone").limit(500),
  ]);
  if (meetingRes.error) return { content: { ok: false, error: meetingRes.error.message } };
  if (bookingRes.error) return { content: { ok: false, error: bookingRes.error.message } };

  const meetings = meetingRes.data ?? [];
  const attendeeRes = meetings.length
    ? await supabase
        .from("meeting_attendees")
        .select("meeting_id, user_id, attendance")
        .in(
          "meeting_id",
          meetings.map((m) => m.id),
        )
    : { data: [] as { meeting_id: string; user_id: string; attendance: string | null }[], error: null };
  if (attendeeRes.error) return { content: { ok: false, error: attendeeRes.error.message } };

  const attendees = new Map<string, { user_id: string; attendance: string | null }[]>();
  for (const a of attendeeRes.data ?? []) {
    const list = attendees.get(a.meeting_id) ?? [];
    list.push({ user_id: a.user_id, attendance: a.attendance });
    attendees.set(a.meeting_id, list);
  }
  const people = await memberNames(supabase, [
    ...(attendeeRes.data ?? []).map((a) => a.user_id),
    ...meetings.map((m) => m.created_by),
  ]);
  const clients = new Map((clientRes.data ?? []).map((c) => [c.id, c]));
  const links = new Map((linkRes.data ?? []).map((l) => [l.id, l]));

  let rows = meetings.map((m) => {
    const list = attendees.get(m.id) ?? [];
    return {
      ...m,
      client: m.client_id ? (clients.get(m.client_id)?.name ?? "—") : "—",
      organiser: m.created_by ? (people.get(m.created_by) ?? "—") : "—",
      attendeeIds: list.map((a) => a.user_id),
      who: list.map((a) => people.get(a.user_id) ?? "someone"),
    };
  });
  if (member) {
    rows = rows.filter((m) => m.attendeeIds.includes(member.id) || m.created_by === member.id);
  }

  // A self-service booking belongs to a link, not to a person, so there is no
  // honest way to say it is on someone's diary. Asked for one member's day,
  // the answer is their meetings only — padding it with the workspace's
  // bookings would overstate what is actually on their plate.
  const bookings = member
    ? []
    : (bookingRes.data ?? []).map((b) => ({
        ...b,
        link: links.get(b.meeting_link_id)?.title ?? "Booking link",
      }));

  if (!rows.length && !bookings.length) {
    return {
      content: {
        ok: false,
        reason: `Nothing is scheduled between ${from} and ${to}${member ? ` for ${member.name}` : ""}. Say the diary is clear rather than inventing something.`,
        window: { from, to },
      },
      event: { kind: "read", label: "Diary", href: "/dashboard" },
    };
  }

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "title", label: "Meeting" },
    { key: "client", label: "Client", secondary: true },
    { key: "who", label: "Who's coming" },
    { key: "length", label: "Length", format: "status", align: "right" },
    { key: "where", label: "Where" },
  ];

  const artifacts: Artifact[] = [
    timelineArtifact({
      title: member ? `${member.name}'s diary` : "The diary",
      subtitle: `${fmtWhen(from)} to ${fmtWhen(to)} — soonest first`,
      summary:
        "Meetings the workspace scheduled. Times are Colombo local; these live on the dashboard, not on the Meetings page, which holds the public booking links.",
      href: "/dashboard",
      area: "meetings",
      entries: [
        ...rows.map((m) => ({
          when: fmtWhen(m.meeting_at),
          label: m.title,
          detail: [
            m.who.length ? `With ${m.who.join(", ")}` : "No attendees added",
            m.client !== "—" ? `Client: ${m.client}` : null,
            m.location_type === "online" ? m.meeting_url || "Online" : m.location || "In person",
            `${m.duration_minutes} min`,
            m.description,
          ]
            .filter(Boolean)
            .join(" · "),
          tone: "info" as ArtifactTone,
          href: "/dashboard",
        })),
        ...bookings.map((b) => ({
          when: `${fmtWhen(b.booking_date)}, ${b.start_time}`,
          label: `${b.link} — ${b.client_name}`,
          detail: [b.client_email, b.client_phone, b.notes].filter(Boolean).join(" · ") || undefined,
          tone: "positive" as ArtifactTone,
          href: `/meetings/${b.meeting_link_id}`,
        })),
      ],
    }),
  ];

  if (rows.length) {
    artifacts.push(
      tableArtifact({
        title: member ? `Meetings — ${member.name}` : "Scheduled meetings",
        subtitle: `${fmtWhen(from)} to ${fmtWhen(to)}`,
        href: "/dashboard",
        area: "meetings",
        columns,
        rows: rowsToTable(rows, columns, (m) => ({
          id: m.id,
          href: "/dashboard",
          tone: "info" as ArtifactTone,
          cells: {
            when: m.meeting_at,
            title: m.title,
            client: m.client,
            who: m.who.length ? m.who.join(", ") : "nobody added",
            length: `${m.duration_minutes} min`,
            where:
              m.location_type === "online"
                ? m.meeting_url || "Online"
                : m.location || "In person",
          },
        })),
        footnote:
          "Scheduled meetings render on the dashboard. The Meetings page is the public booking links, and their bookings are the second table.",
      }),
    );
  }

  if (bookings.length) {
    const bookingColumns: ArtifactColumn[] = [
      { key: "date", label: "Date", format: "date" },
      { key: "time", label: "Time" },
      { key: "link", label: "Booked through" },
      { key: "who", label: "Who booked" },
      { key: "email", label: "Email", format: "email", secondary: true },
      { key: "phone", label: "Phone", format: "phone", secondary: true },
      { key: "notes", label: "Notes", secondary: true },
    ];
    artifacts.push(
      tableArtifact({
        title: "Clients who booked themselves in",
        subtitle: `${fmtWhen(from)} to ${fmtWhen(to)} — confirmed only`,
        href: "/meetings",
        area: "meetings",
        columns: bookingColumns,
        rows: rowsToTable(bookings, bookingColumns, (b) => ({
          id: b.id,
          href: `/meetings/${b.meeting_link_id}`,
          tone: "positive" as ArtifactTone,
          cells: {
            date: b.booking_date,
            time: `${b.start_time}–${b.end_time}`,
            link: b.link,
            who: b.client_name,
            email: b.client_email ?? "—",
            phone: b.client_phone ?? "—",
            notes: b.notes ?? "—",
          },
        })),
        footnote: "Booking times are already workspace-local wall clock.",
      }),
    );
  }

  return {
    content: {
      ok: true,
      window: { from, to },
      member: member?.name ?? null,
      timezone: WORKSPACE_TZ,
      scheduled_meetings: rows.length,
      client_bookings: bookings.length,
      meetings: rows.slice(0, 15).map((m) => ({
        when: fmtWhen(m.meeting_at),
        title: m.title,
        client: m.client === "—" ? null : m.client,
        attendees: m.who,
        organiser: m.organiser,
        minutes: m.duration_minutes,
        where: m.location_type === "online" ? m.meeting_url || "online" : m.location || "in person",
      })),
      bookings: bookings.slice(0, 10).map((b) => ({
        date: b.booking_date,
        time: `${b.start_time}–${b.end_time}`,
        booked_through: b.link,
        who: b.client_name,
        notes: b.notes,
      })),
      note: "Scheduled meetings and self-service bookings are two different lists; both are shown.",
    },
    event: { kind: "read", label: "Diary", href: "/dashboard" },
    artifacts,
  };
}

// ---- delivery_reports -----------------------------------------------------

async function reportWorkload(ctx: ToolContext, isAdmin: boolean): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const [projectsRes, peopleRes, teamRes, tasksRes, timeRes] = await Promise.all([
    loadProjects(supabase),
    supabase.from("profiles").select("id, full_name, username, role").limit(200),
    supabase.from("project_members").select("project_id, user_id, is_owner").limit(3000),
    supabase
      .from("todos")
      .select("project_id, assigned_to, status, due_date")
      .not("project_id", "is", null)
      .limit(3000),
    supabase.from("time_entries").select("project_id, user_id, minutes").limit(5000),
  ]);
  if (projectsRes.error) return { content: { ok: false, error: projectsRes.error } };
  if (peopleRes.error) return { content: { ok: false, error: peopleRes.error.message } };

  // A cost rate is never shown to the member it belongs to, so it is read in
  // its own query and only when the caller is allowed to see money at all.
  const rateRes = isAdmin
    ? await supabase.from("profiles").select("id, hourly_cost").limit(200)
    : { data: [] as { id: string; hourly_cost: number | null }[] };
  const rates = new Map((rateRes.data ?? []).map((p) => [p.id, num(p.hourly_cost)]));

  const projects = projectsRes.rows;
  const liveIds = new Set(
    projects.filter((p) => ["planning", "active", "on_hold"].includes(p.status)).map((p) => p.id),
  );
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const todayStart = colomboStart(ctx.today);

  const members = (peopleRes.data ?? []).map((m) => {
    const theirs = (teamRes.data ?? []).filter(
      (t) => t.user_id === m.id && liveIds.has(t.project_id),
    );
    const tasks = (tasksRes.data ?? []).filter((t) => t.assigned_to === m.id && t.status !== "done");
    const overdue = tasks.filter((t) => t.due_date && Date.parse(t.due_date) < todayStart).length;
    const minutes = total(
      (timeRes.data ?? []).filter((t) => t.user_id === m.id),
      (t) => num(t.minutes),
    );
    return {
      id: m.id,
      name: m.full_name || m.username,
      projects: theirs.length,
      owned: theirs.filter((t) => t.is_owner).length,
      open: tasks.length,
      overdue,
      minutes,
      cost: (minutes / 60) * (rates.get(m.id) ?? 0),
    };
  });
  // Same weighting the Workload tab uses: a project counts for two tasks.
  members.sort((a, b) => b.open + b.projects * 2 - (a.open + a.projects * 2));

  const byProject = new Map<string, { minutes: number; people: Set<string> }>();
  for (const t of timeRes.data ?? []) {
    if (!t.project_id) continue;
    const entry = byProject.get(t.project_id) ?? { minutes: 0, people: new Set<string>() };
    entry.minutes += num(t.minutes);
    entry.people.add(t.user_id);
    byProject.set(t.project_id, entry);
  }
  const burn = [...byProject.entries()]
    .map(([id, e]) => {
      const project = projects.find((p) => p.id === id);
      const budget = Number(project?.expense_cap ?? project?.budget ?? 0) || null;
      const labour = total(
        (timeRes.data ?? []).filter((t) => t.project_id === id),
        (t) => (num(t.minutes) / 60) * (rates.get(t.user_id) ?? 0),
      );
      return {
        id,
        name: projectName.get(id) ?? "—",
        minutes: e.minutes,
        people: e.people.size,
        labour,
        budget,
        over: budget !== null && isAdmin && labour > budget,
      };
    })
    .sort((a, b) => (isAdmin ? b.labour - a.labour : b.minutes - a.minutes));

  const memberColumns: ArtifactColumn[] = [
    { key: "member", label: "Member" },
    { key: "projects", label: "Live projects", format: "number", align: "right" },
    { key: "owned", label: "Owns", format: "number", align: "right", secondary: true },
    { key: "open", label: "Open tasks", format: "number", align: "right" },
    { key: "overdue", label: "Overdue", format: "number", align: "right" },
    { key: "logged", label: "Time logged", format: "status", align: "right" },
  ];

  const burnColumns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "logged", label: "Time logged", format: "status", align: "right" },
    { key: "hours", label: "Hours", format: "number", align: "right", secondary: true },
    { key: "people", label: "People", format: "number", align: "right", secondary: true },
    ...(isAdmin
      ? ([
          { key: "labour", label: "That time costs", format: "money", align: "right" },
          { key: "budget", label: "Internal budget", format: "money", align: "right" },
        ] as ArtifactColumn[])
      : []),
  ];

  const artifacts: Artifact[] = [
    tableArtifact({
      title: "Who is carrying what",
      subtitle: "Live projects and open tasks, busiest first",
      summary:
        "A project counts double against a task, the same weighting the Workload report uses. Time logged is everything ever recorded, not just this month.",
      href: "/projects/reports?tab=workload",
      area: "projects",
      columns: memberColumns,
      rows: rowsToTable(members, memberColumns, (m) => ({
        id: m.id,
        href: "/projects/reports?tab=workload",
        tone: (m.overdue > 0 ? "danger" : m.open === 0 ? "neutral" : "info") as ArtifactTone,
        cells: {
          member: m.name,
          projects: m.projects,
          owned: m.owned,
          open: m.open,
          overdue: m.overdue,
          logged: formatMinutes(m.minutes),
        },
      })),
    }),
  ];

  if (burn.length) {
    artifacts.push(
      tableArtifact({
        title: "Hours against the job",
        subtitle: isAdmin ? "What the logged time costs, per project" : "Logged time per project",
        summary: isAdmin
          ? "Labour only — materials and subcontracting are in the profitability report. A project over its internal budget on labour alone is over-running."
          : "Cost rates are admin-only, so this shows the hours without the money.",
        href: "/projects/reports?tab=workload",
        area: "projects",
        columns: burnColumns,
        rows: rowsToTable(burn.slice(0, 40), burnColumns, (b) => ({
          id: b.id,
          href: `/projects/${b.id}`,
          tone: (b.over ? "danger" : "neutral") as ArtifactTone,
          cells: {
            project: b.name,
            logged: formatMinutes(b.minutes),
            hours: round1(b.minutes / 60),
            people: b.people,
            ...(isAdmin ? { labour: money(b.labour), budget: b.budget } : {}),
          },
        })),
        total_label: "Hours logged in total",
        total_value: round1(total(burn, (b) => b.minutes) / 60),
        total_format: "number",
      }),
    );
  }

  return {
    content: {
      ok: true,
      report: "workload",
      members: members.slice(0, 15).map((m) => ({
        member: m.name,
        live_projects: m.projects,
        owns: m.owned,
        open_tasks: m.open,
        overdue_tasks: m.overdue,
        hours_logged: round1(m.minutes / 60),
        ...(isAdmin ? { labour_cost: money(m.cost) } : {}),
      })),
      projects_over_budget_on_labour: isAdmin
        ? burn.filter((b) => b.over).map((b) => ({
            project: b.name,
            hours: round1(b.minutes / 60),
            labour_cost: money(b.labour),
            internal_budget: b.budget,
          }))
        : null,
      busiest_projects: burn.slice(0, 10).map((b) => ({
        project: b.name,
        hours: round1(b.minutes / 60),
        people: b.people,
      })),
      note: isAdmin
        ? "Over-running means the logged hours alone cost more than the project's internal budget; materials are extra."
        : "Cost rates and margins are admin-only, so this is hours without money.",
    },
    event: { kind: "read", label: "Workload", href: "/projects/reports?tab=workload" },
    artifacts,
  };
}

async function reportCycleTime(ctx: ToolContext): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const [projectsRes, eventsRes] = await Promise.all([
    loadProjects(supabase),
    supabase
      .from("delivery_events")
      .select("project_id, meta, created_at")
      .eq("kind", "stage_changed")
      .order("created_at", { ascending: true })
      .limit(4000),
  ]);
  if (projectsRes.error) return { content: { ok: false, error: projectsRes.error } };
  if (eventsRes.error) return { content: { ok: false, error: eventsRes.error.message } };

  const projects = projectsRes.rows;
  const known = new Set(projects.map((p) => p.id));
  const byProject = new Map<string, { stage: string; at: string }[]>();
  for (const e of eventsRes.data ?? []) {
    if (!known.has(e.project_id)) continue;
    const stage = str((e.meta as Record<string, unknown> | null)?.new_stage);
    if (!stage) continue;
    const list = byProject.get(e.project_id) ?? [];
    list.push({ stage, at: e.created_at });
    byProject.set(e.project_id, list);
  }

  const durations = new Map<string, number[]>();
  const endToEnd: { id: string; days: number; deliveredAt: string }[] = [];
  for (const [projectId, moves] of byProject) {
    let firstAt: string | null = null;
    for (let i = 0; i < moves.length; i++) {
      if (!firstAt) firstAt = moves[i].at;
      const next = moves[i + 1];
      // No closing move means the project is sitting in this stage right now.
      // Counting it would drag every average down as work in progress ages.
      if (!next) break;
      const days = (Date.parse(next.at) - Date.parse(moves[i].at)) / 86_400_000;
      if (days < 0) continue;
      const list = durations.get(moves[i].stage) ?? [];
      list.push(days);
      durations.set(moves[i].stage, list);
      if (moves[i].stage !== "delivered" && next.stage === "delivered") {
        endToEnd.push({
          id: projectId,
          days: (Date.parse(next.at) - Date.parse(firstAt)) / 86_400_000,
          deliveredAt: next.at,
        });
      }
    }
  }

  const stageRows = DELIVERY_STAGES.map((stage) => {
    const list = (durations.get(stage) ?? []).slice().sort((a, b) => a - b);
    return {
      stage,
      label: DELIVERY_STAGE_META[stage].label,
      count: list.length,
      // Median over mean: one project that sat in review over a holiday should
      // not become "how long review takes".
      median: list.length ? list[Math.floor(list.length / 2)] : null,
      average: list.length ? total(list, (d) => d) / list.length : null,
      longest: list.length ? list[list.length - 1] : null,
    };
  });

  const deliveredAt = new Map(endToEnd.map((e) => [e.id, e.deliveredAt]));
  let onTime = 0;
  let measurable = 0;
  for (const p of projects) {
    if (!p.due_date) continue;
    if (!["delivered", "aftercare"].includes(p.delivery_stage ?? "")) continue;
    const at = deliveredAt.get(p.id);
    if (!at) continue;
    measurable++;
    if (at.slice(0, 10) <= p.due_date) onTime++;
  }

  if (!endToEnd.length && stageRows.every((s) => s.count === 0)) {
    return {
      content: {
        ok: false,
        reason:
          "No completed spells in any stage yet — cycle time is measured from recorded stage moves, and a project sitting in its first stage has not finished one. Say so rather than estimating.",
      },
      event: { kind: "read", label: "Cycle time", href: "/projects/reports?tab=cycle" },
    };
  }

  const byMonth = new Map<string, number[]>();
  for (const e of endToEnd) {
    const key = e.deliveredAt.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(e.days);
    byMonth.set(key, list);
  }
  const trend = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([key, list]) => ({ key, average: total(list, (d) => d) / list.length, count: list.length }));

  const averageEndToEnd = endToEnd.length ? total(endToEnd, (e) => e.days) / endToEnd.length : null;

  const columns: ArtifactColumn[] = [
    { key: "stage", label: "Stage" },
    { key: "count", label: "Completed spells", format: "number", align: "right" },
    { key: "median", label: "Median days", format: "number", align: "right" },
    { key: "average", label: "Average days", format: "number", align: "right", secondary: true },
    { key: "longest", label: "Longest", format: "number", align: "right", secondary: true },
  ];

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: "Cycle time",
      subtitle: "Measured from recorded stage moves",
      summary:
        "The stage a project is sitting in right now is deliberately excluded — it has not finished, and counting it would make every figure look worse as work ages.",
      href: "/projects/reports?tab=cycle",
      area: "projects",
      metrics: [
        { label: "Deliveries measured", value: endToEnd.length, format: "number" },
        {
          label: "Average start to delivery",
          value: averageEndToEnd === null ? "—" : round1(averageEndToEnd),
          format: averageEndToEnd === null ? "status" : "number",
        },
        {
          label: "Hit the due date",
          value: measurable ? Math.round((onTime / measurable) * 100) : "not measurable",
          format: measurable ? "percent" : "status",
          tone: measurable && onTime / measurable >= 0.7 ? "positive" : "warning",
        },
        { label: "Projects with a due date and a delivery", value: measurable, format: "number" },
      ],
    }),
    tableArtifact({
      title: "How long each stage takes",
      href: "/projects/reports?tab=cycle",
      area: "projects",
      columns,
      rows: rowsToTable(stageRows, columns, (s) => ({
        id: s.stage,
        href: "/projects/reports?tab=cycle",
        tone: (s.count === 0 ? "neutral" : "info") as ArtifactTone,
        cells: {
          stage: s.label,
          count: s.count,
          median: s.median === null ? null : round1(s.median),
          average: s.average === null ? null : round1(s.average),
          longest: s.longest === null ? null : round1(s.longest),
        },
      })),
      footnote: "Medians, not averages — one job that ran over a holiday is not how long that stage takes.",
    }),
  ];

  if (trend.length) {
    artifacts.push(
      chartArtifact({
        title: "Start to delivery, by the month it landed",
        subtitle: "Average days",
        href: "/projects/reports?tab=cycle",
        area: "projects",
        chart: "line",
        format: "number",
        points: trend.map((t) => ({ label: t.key, value: round1(t.average), tone: "info" as ArtifactTone })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      report: "cycle_time",
      deliveries_measured: endToEnd.length,
      average_start_to_delivery_days: averageEndToEnd === null ? null : round1(averageEndToEnd),
      on_time_percent: measurable ? Math.round((onTime / measurable) * 100) : null,
      measurable_projects: measurable,
      stages: stageRows.map((s) => ({
        stage: s.label,
        completed_spells: s.count,
        median_days: s.median === null ? null : round1(s.median),
        average_days: s.average === null ? null : round1(s.average),
        longest_days: s.longest === null ? null : round1(s.longest),
      })),
      trend: trend.map((t) => ({ month: t.key, average_days: round1(t.average), deliveries: t.count })),
      note: "The stage a project is in right now is excluded — it has no closing event yet.",
    },
    event: { kind: "read", label: "Cycle time", href: "/projects/reports?tab=cycle" },
    artifacts,
  };
}

async function reportBenchmarks(
  args: Record<string, unknown>,
  ctx: ToolContext,
  isAdmin: boolean,
): Promise<ToolResult> {
  const serviceType = str(args.service_type) || null;
  const finished = await finishedProjects(ctx.supabase, { serviceType, limit: 60 });
  if (!finished.length) {
    return {
      content: {
        ok: false,
        reason: serviceType
          ? `Nothing has been finished for "${serviceType}" yet, so there is no history to benchmark against.`
          : "No project has been completed or delivered yet, so there is nothing to benchmark against. Say so rather than estimating.",
      },
      event: { kind: "read", label: "Benchmarks", href: "/projects/reports?tab=estimates" },
    };
  }
  const benchmarks = benchmarkByService(finished);

  const benchColumns: ArtifactColumn[] = [
    { key: "service", label: "Service" },
    { key: "count", label: "Finished", format: "number", align: "right" },
    { key: "days", label: "Typical days", format: "number", align: "right" },
    { key: "quoted", label: "Typical quote", format: "money", align: "right" },
    { key: "extras", label: "Extras raised", format: "money", align: "right" },
    ...(isAdmin
      ? ([{ key: "margin", label: "Typical margin", format: "percent", align: "right" }] as ArtifactColumn[])
      : []),
  ];

  const projectColumns: ArtifactColumn[] = [
    { key: "project", label: "Project" },
    { key: "service", label: "Service", format: "status", secondary: true },
    { key: "days", label: "Days", format: "number", align: "right" },
    { key: "quoted", label: "Quoted", format: "money", align: "right" },
    { key: "received", label: "Received", format: "money", align: "right", secondary: true },
    { key: "extras", label: "Extras", format: "money", align: "right", secondary: true },
    ...(isAdmin
      ? ([
          { key: "profit", label: "Profit", format: "money", align: "right" },
          { key: "margin", label: "Margin", format: "percent", align: "right" },
        ] as ArtifactColumn[])
      : []),
    { key: "delivered", label: "Delivered", format: "datetime" },
  ];

  const artifacts: Artifact[] = [
    tableArtifact({
      title: "What each kind of job actually takes",
      subtitle: "Medians from our own finished work",
      summary:
        "'Finished' means completed or delivered; a cancelled project teaches you about sales, not delivery, so it is excluded. A service with fewer than two finished projects is dropped — an average of one is an anecdote.",
      href: "/projects/reports?tab=estimates",
      area: "projects",
      columns: benchColumns,
      rows: rowsToTable(benchmarks, benchColumns, (b) => ({
        id: b.serviceType,
        href: "/projects/reports?tab=estimates",
        tone: "info" as ArtifactTone,
        cells: {
          service: serviceLabel(b.serviceType === "other" ? null : b.serviceType),
          count: b.count,
          days: b.medianDays,
          quoted: money(b.medianQuoted),
          extras: money(b.medianExtras),
          ...(isAdmin ? { margin: b.medianMarginPercent } : {}),
        },
      })),
      footnote: benchmarks.length
        ? undefined
        : "Two finished projects of the same service type are needed before a median means anything.",
    }),
    tableArtifact({
      title: "The finished projects behind those numbers",
      subtitle: serviceType ? serviceLabel(serviceType) : "Newest first",
      href: "/projects/reports?tab=estimates",
      area: "projects",
      columns: projectColumns,
      rows: rowsToTable(finished.slice(0, 40), projectColumns, (p) => ({
        id: p.id,
        href: `/projects/${p.id}`,
        tone: (isAdmin && p.profit < 0 ? "danger" : "neutral") as ArtifactTone,
        cells: {
          project: p.name,
          service: serviceLabel(p.serviceType),
          days: p.days,
          quoted: money(p.quoted),
          received: money(p.received),
          extras: money(p.extras),
          ...(isAdmin ? { profit: money(p.profit), margin: p.marginPercent } : {}),
          delivered: p.deliveredOn,
        },
      })),
    }),
  ];

  return {
    content: {
      ok: true,
      report: "benchmarks",
      currency: "LKR",
      finished_projects: finished.length,
      service_type: serviceType,
      benchmarks: benchmarks.map((b) => ({
        service: serviceLabel(b.serviceType === "other" ? null : b.serviceType),
        finished: b.count,
        median_days: b.medianDays,
        median_quote: money(b.medianQuoted),
        median_extras: money(b.medianExtras),
        ...(isAdmin ? { median_margin_percent: b.medianMarginPercent } : {}),
      })),
      recent: finished.slice(0, 10).map((p) => ({
        project: p.name,
        service: serviceLabel(p.serviceType),
        days: p.days,
        quoted: money(p.quoted),
        extras: money(p.extras),
        delivered: p.deliveredOn,
        ...(isAdmin ? { profit: money(p.profit), margin_percent: p.marginPercent } : {}),
      })),
      note: isAdmin
        ? "Medians, not averages. Days run from the start date to the recorded delivery."
        : "Medians, not averages. Profit and margin are admin-only in this workspace.",
    },
    event: { kind: "read", label: "Benchmarks", href: "/projects/reports?tab=estimates" },
    artifacts,
  };
}

async function deliveryReports(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const report = str(args.report).toLowerCase();
  const isAdmin = await callerIsAdmin(ctx);
  switch (report) {
    case "workload":
      return reportWorkload(ctx, isAdmin);
    case "cycle_time":
      return reportCycleTime(ctx);
    case "benchmarks":
      return reportBenchmarks(args, ctx, isAdmin);
    default:
      return { content: { ok: false, error: `"${report}" is not a delivery report.` } };
  }
}

// ---- log_project_time -----------------------------------------------------

async function logProjectTime(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const project = await findProjectRow(ctx.supabase, args.project);
  if (!project) {
    return { content: { ok: false, reason: `No live project matching "${str(args.project)}".` } };
  }

  const hours = Number(args.hours);
  const rawMinutes = Number(args.minutes);
  const minutes = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : Math.round(rawMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { content: { ok: false, error: "Say how long it took, in hours or minutes." } };
  }

  let member: { id: string; name: string } | null = null;
  if (str(args.member)) {
    member = await resolveMember(ctx, args.member);
    if (!member) {
      return { content: { ok: false, reason: `No team member matching "${str(args.member)}".` } };
    }
  }

  const workedOn = isDate(str(args.date)) ? str(args.date) : ctx.today;

  // Through the page's own action: it holds the day cap, the admin check for
  // logging on someone else's behalf, and the revalidation the boards need.
  const { logTime } = await import("@/app/(app)/projects/plan-actions");
  const res = await logTime({
    project_id: project.id,
    minutes,
    note: str(args.note) || null,
    worked_on: workedOn,
    user_id: member?.id ?? null,
  });
  if (!res.ok) return { content: { ok: false, error: res.error } };

  return {
    content: {
      ok: true,
      project: project.name,
      logged: formatMinutes(minutes),
      minutes,
      hours: round1(minutes / 60),
      worked_on: workedOn,
      member: member?.name ?? "you",
      note: str(args.note) || null,
    },
    event: {
      kind: "created",
      label: `${formatMinutes(minutes)} on ${project.name}`,
      href: `/projects/${project.id}`,
    },
  };
}

// ---- set_project_blocked --------------------------------------------------

async function setBlocked(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const project = await findProjectRow(ctx.supabase, args.project);
  if (!project) {
    return { content: { ok: false, reason: `No live project matching "${str(args.project)}".` } };
  }

  const blocked = args.blocked === true;
  const reason = str(args.reason);
  if (blocked && !reason) {
    return {
      content: {
        ok: false,
        error:
          "Say what it is waiting on. A block with no reason tells nobody anything when the deadline slips.",
      },
    };
  }

  const { setProjectBlocked } = await import("@/app/(app)/projects/actions");
  const res = await setProjectBlocked(project.id, blocked ? reason : null);
  if (!res.ok) return { content: { ok: false, error: res.error } };

  return {
    content: {
      ok: true,
      project: project.name,
      blocked,
      reason: blocked ? reason : null,
      note: blocked
        ? "While blocked, the asset chaser and the stalled-project alert stand down for this project, and the days lost are counted. Nothing was sent to the client."
        : "Unblocked. The chaser and the stalled alert can fire again from here.",
    },
    event: {
      kind: "updated",
      label: blocked ? `Blocked — ${project.name}` : `Unblocked — ${project.name}`,
      href: `/projects/${project.id}`,
    },
  };
}

// ---- Executor -------------------------------------------------------------

/**
 * Run one of this module's tools. Returns null when `name` belongs to a
 * different module, so the registry can try the next one.
 */
export async function executeDeliveryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "project_dossier":
      return projectDossier(args, ctx);
    case "delivery_query":
      return deliveryQuery(args, ctx);
    case "delivery_board":
      return deliveryBoard(args, ctx);
    case "meetings_agenda":
      return meetingsAgenda(args, ctx);
    case "delivery_reports":
      return deliveryReports(args, ctx);
    case "log_project_time":
      return logProjectTime(args, ctx);
    case "set_project_blocked":
      return setBlocked(args, ctx);
    default:
      return null;
  }
}
