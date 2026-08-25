import "server-only";

/**
 * The assistant's front office — CRM, WhatsApp, SMS, Automation, AI &
 * Intelligence, Content Studio and the team.
 *
 * Where the finance module answers "what happened to the money", this one
 * answers "where is the work coming from, what was actually said, and who is
 * carrying it". That difference shapes three decisions.
 *
 * First, everything here is READ-ONLY on the messaging side. The workspace
 * already has a WhatsApp agent that talks to prospects unattended; an
 * assistant that could also send would give one conversation two mouths. So
 * this module reads `wa_messages` and `sms_messages` and never writes them —
 * anything outbound belongs to the existing prepare_sms confirm-card path,
 * where a person presses Send.
 *
 * Second, the numbers have owners and this module borrows rather than
 * re-derives them: `wa_funnel_stats` (migration 0074) aggregates the
 * WhatsApp funnel in the database, `summariseMemberMoney()` decides what a
 * member is owed, `TRIGGER_META`/`STEP_META` name every automation trigger in
 * English. Where a definition genuinely differs between two screens —
 * staleness is `pipelines.stale_after_days` on the board but a hardcoded
 * seven days in the weekly digest — the figure is labelled with the rule that
 * produced it instead of being quietly averaged.
 *
 * Third, six tools rather than twenty. The model already carries thirty-odd
 * schemas and every extra one costs it accuracy, so `crm_query` and
 * `growth_query` each take a `dataset` enum instead of shipping a list tool
 * per table. Every read returns an artifact for the preview canvas plus a
 * compact JSON summary for the model — the detail lives in the artifact, and
 * the model should not pay for it twice.
 *
 * One privacy rule runs through all of it: commissions, loans, login sessions
 * and the member change trail are visible only to their owner or an admin, so
 * a member asking about a colleague gets a plain refusal rather than a
 * silently empty (and therefore wrong) answer. `profiles.hourly_cost` never
 * leaves this file at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type {
  AppArea,
  Artifact,
  ArtifactCell,
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
  textArtifact,
  timelineArtifact,
} from "@/lib/assistant-artifacts";
import { STEP_META, TRIGGER_META } from "@/lib/automation-meta";
import type {
  AutomationStepKind,
  AutomationTrigger,
  Database,
  LeadActivityKind,
} from "@/lib/database.types";
import {
  attachRepayments,
  loanBalance,
  loanRepaid,
  summariseMemberMoney,
} from "@/lib/loans";
import { ONLINE_WINDOW_MS } from "@/lib/ping";
import { parseResearchReport } from "@/lib/research-report";
import { formatCurrency } from "@/lib/utils";
import { WA_LANGUAGE_LABELS } from "@/lib/wa-lang";

type DB = SupabaseClient<Database>;

// ---- Tool schemas advertised to the model --------------------------------

/** Tool schemas advertised to the model for this area. */
export const GROWTH_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "pipeline_report",
      description:
        "The CRM pipeline and what moved in it: open value, leads and value per stage, new leads, deals won and lost, win rate, how many are going cold, and the weighted forecast. Call this for 'how's the pipeline looking', 'what moved this week', 'which stage is everything stuck in', 'how many did we win last month' or 'how much can I expect to close'. Counts open, untrashed leads only — closed and deleted deals are excluded, so this figure is deliberately smaller than a raw sum of every lead.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "integer",
            description:
              "How far back 'what moved' looks, in days. Default 7 (this week), max 365.",
          },
          pipeline: {
            type: "string",
            description:
              "Pipeline name, when there is more than one. Defaults to the first pipeline on the board.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crm_query",
      description:
        "List any CRM record set as a table: pick the `dataset`. leads = filter the pipeline by stage, owner, score, source or keyword (deeper than list_leads, and it excludes trashed leads). stale_leads = open deals nobody has touched. activities = the event log of what happened to leads. tasks = CRM follow-up tasks. companies = accounts with their deal count and open value. research = the prospect briefings on /crm/research. outreach_drafts = cold emails written and waiting for approval. campaigns = bulk cold-email runs with live progress. suppressions = addresses that bounced, complained or unsubscribed. prospect_scans / prospect_candidates = the Find Leads area scans and the businesses they turned up. Use for 'which leads are going cold', 'what's my hot list', 'what happened on that lead', 'how many drafts are waiting for me', 'is the Kandy campaign still running', 'did anyone unsubscribe' and 'did that scan find anything'.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [
              "leads",
              "stale_leads",
              "activities",
              "tasks",
              "companies",
              "research",
              "outreach_drafts",
              "campaigns",
              "suppressions",
              "prospect_scans",
              "prospect_candidates",
            ],
          },
          status: {
            type: "string",
            description:
              "Dataset-specific filter. leads: open|won|lost|all. tasks: open|done|overdue. research: pending|running|done|error. outreach_drafts: ready|sent|failed|skipped|in_progress. campaigns: running|paused|done|cancelled. prospect_scans: done|error|running. prospect_candidates: qualified|imported|skipped|emailed|pending.",
          },
          stage: { type: "string", description: "leads / stale_leads — pipeline stage name." },
          owner: {
            type: "string",
            description:
              "Assignee name, or 'me' for the signed-in user. Applies to leads, stale_leads and tasks.",
          },
          score: {
            type: "string",
            enum: ["hot", "warm", "cold", "unscored"],
            description: "leads only — the AI lead score.",
          },
          source: {
            type: "string",
            description:
              "leads only — where the lead came from (website, referral, whatsapp, prospecting, facebook…). Free text, matched as a contains.",
          },
          query: {
            type: "string",
            description: "Keyword: lead title, company, contact, task title, business name.",
          },
          days: {
            type: "integer",
            description:
              "Look back this many days (activities, tasks, research, outreach_drafts, campaigns, suppressions, scans). For stale_leads it overrides the pipeline's own staleness setting.",
          },
          on: {
            type: "string",
            description:
              "Restrict to one calendar day in Sri Lanka time, as YYYY-MM-DD. Use this for 'yesterday' rather than days=1.",
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
      name: "conversation_history",
      description:
        "Read the ACTUAL messages exchanged with one person, in order, with timestamps — the real WhatsApp thread (including everything the AI agent said) or the SMS log. Use for 'what did the agent say to Dilan', 'show me that WhatsApp chat', 'did we text them', 'what did we promise her'. Read-only: this tool can never send a message. To send one, use prepare_sms, which builds a message for the user to approve and send.",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description:
              "Who: a name, a company, or a phone number. WhatsApp also matches the linked lead's name.",
          },
          channel: {
            type: "string",
            enum: ["whatsapp", "sms"],
            description:
              "whatsapp = the two-way inbox thread. sms = the outbound Notify.lk send log (there are no inbound texts).",
          },
          limit: {
            type: "integer",
            description: "How many messages to read. Default 40, max 150 — the most recent ones.",
          },
        },
        required: ["contact", "channel"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "whatsapp_report",
      description:
        "How the WhatsApp agent is performing: conversations, replies, BOOKED CALLS (the agent's win), win rate, first-reply speed, what prospects objected to, who needs a human, promised follow-ups, and the cold-outreach numbers. Use for 'how's the WhatsApp agent doing', 'how many calls has it booked', 'who's coming up', 'which chats need me', 'what are people objecting to' or 'is the ad campaign converting'. A booked call is the headline metric — everything after the call (quote, signature, revenue) is the team's half of the funnel.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "integer",
            description: "Window in days. Default 30, max 365.",
          },
          campaign: {
            type: "string",
            description:
              "Narrow to one Meta-ad campaign by name. Omit for every conversation in the window.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "growth_query",
      description:
        "List any automation, intelligence, content or SMS record set as a table: pick the `dataset`. automations = the rules and whether they are firing. automation_runs = individual runs, including failures. sms = the text-message send log with segment counts. sms_workflows = multi-step text sequences. digests = the weekly AI business digest, in full. churn_alerts = clients going quiet. content = generated Content Studio images. carousels = scheduled Instagram carousel posts. competitors = the competitor watch list. ads = ad spend with ROAS. visitors = website traffic and form funnel. Use for 'did any automation fail', 'what SMS went out yesterday', 'what does the latest digest say', 'what content is scheduled this week', 'which clients are going cold', 'how are the ads performing' and 'how much traffic did the site get'.",
      parameters: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [
              "automations",
              "automation_runs",
              "sms",
              "sms_workflows",
              "digests",
              "churn_alerts",
              "content",
              "carousels",
              "competitors",
              "ads",
              "visitors",
            ],
          },
          status: {
            type: "string",
            description:
              "Dataset-specific filter. automations: active|inactive. automation_runs: running|completed|failed|cancelled. sms: sent|failed, or an SMS kind (custom, payment_reminder, automation, promotion, todo_reminder, meeting_reminder, prospecting, team_alert). churn_alerts: open|actioned|dismissed. carousels: planned|copywriting|rendering|ready|approved|error. ads: meta|google|tiktok|other.",
          },
          query: {
            type: "string",
            description:
              "Keyword: automation name, recipient or client, topic, competitor, ad campaign, page path.",
          },
          days: {
            type: "integer",
            description:
              "Look back this many days. Default 30 for visitors and ads, 14 for runs and SMS. For carousels it means the next N days instead, since scheduled content is in the future.",
          },
          on: {
            type: "string",
            description:
              "Restrict to one calendar day in Sri Lanka time, as YYYY-MM-DD. Use this for 'yesterday' rather than days=1.",
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
      name: "team_report",
      description:
        "One team member's whole picture: the leads and tasks on their plate, how much they have been online and what they changed, and what they are owed in commission. Use for 'what's on Kasun's plate', 'how much commission does Ayesha have pending', 'how much was I online last week' or 'what has the team been working on'. Workload is visible to everyone; money and activity are private to that member and admins, so it refuses rather than showing a member a colleague's half-empty figures. For the full loan and repayment ledger use member_money.",
      parameters: {
        type: "object",
        properties: {
          member: {
            type: "string",
            description: "Member name, or 'me' for the signed-in user. Defaults to 'me'.",
          },
          days: {
            type: "integer",
            description: "Activity window in days. Default 30, max 90.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

// ---- Small shared helpers ------------------------------------------------

const WORKSPACE_TZ = "Asia/Colombo";
const DAY_MS = 86_400_000;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

/** Postgres numeric arrives as a string; anything unparseable is zero. */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function total<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0);
}

function clampLimit(v: unknown, fallback = 25): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function clampDays(v: unknown, fallback: number, max = 365): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * Strip the characters PostgREST reads as filter syntax before they go into
 * an `ilike` or an `or`. A company called "Silva, Perera & Co" would
 * otherwise split one filter into two malformed ones.
 */
function safeLike(s: string): string {
  return s.replace(/[,()%*\\.]/g, " ").replace(/\s+/g, " ").trim();
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** ISO timestamp `days` ago — the start of a rolling window. */
function sinceIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * The UTC range covering one Colombo calendar day.
 *
 * Timestamps are stored in UTC, so "yesterday" filtered with a bare date
 * would start five and a half hours late and swallow half of the wrong day.
 * Mirrors `colomboDayRange` in `@/lib/ai/tools`, which is module-private.
 */
function colomboDay(day: string): { start: string; end: string } {
  const start = new Date(`${day}T00:00:00+05:30`);
  return { start: start.toISOString(), end: new Date(start.getTime() + DAY_MS).toISOString() };
}

/**
 * Render a stored timestamp in workspace-local (Sri Lanka) time.
 *
 * Everything in these tables is UTC, so without this the model reads a
 * 9:30pm Colombo message as "16:00" and tells the user the wrong hour.
 * Deliberately duplicated from `fmtDateTime` in `@/lib/ai/tools` rather than
 * exported from there — that file is being edited concurrently.
 */
function fmtDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isDate(value)) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: WORKSPACE_TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00+05:30`));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: WORKSPACE_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/** Whole days between a stored timestamp and now — the board's staleness rule. */
function daysSince(iso: string | null | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER;
  return Math.floor((Date.now() - t) / DAY_MS);
}

/** Money cells stay raw numbers — the artifact renderer owns the "Rs. " prefix. */
const money = (v: number): number => Math.round(v * 100) / 100;

/** Trim a message body for the model without hiding that it was trimmed. */
function clip(text: string | null | undefined, max: number): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pretty-print a wa_id: 94771234567 → +94 77 123 4567.
 *
 * Deliberately a copy of `formatWaPhone` rather than an import: this module
 * is strictly read-only on WhatsApp, and `@/lib/whatsapp` is the module that
 * can send. Not importing it at all makes that impossible to get wrong.
 */
function waPhone(waId: string): string {
  const m = waId.match(/^94(\d{2})(\d{3})(\d{4})$/);
  return m ? `+94 ${m[1]} ${m[2]} ${m[3]}` : `+${waId}`;
}

/** display_name || profile_name || wa_id — the precedence the inbox uses. */
function waName(c: {
  display_name: string | null;
  profile_name: string | null;
  wa_id: string;
}): string {
  return c.display_name || c.profile_name || waPhone(c.wa_id);
}

const SELF_WORDS = new Set(["me", "myself", "i", "my", "mine", "my own"]);

/** Resolve a spoken member name (or "me") to a profile id. */
async function resolveMember(
  supabase: DB,
  userId: string,
  name: unknown,
): Promise<{ id: string; name: string } | null> {
  const asked = str(name);
  if (!asked || SELF_WORDS.has(asked.toLowerCase())) {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, username")
      .eq("id", userId)
      .maybeSingle();
    return { id: userId, name: data?.full_name || data?.username || "you" };
  }
  const safe = safeLike(asked);
  if (!safe) return null;
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, username")
    .or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%`)
    .limit(1);
  const row = data?.[0];
  return row ? { id: row.id, name: row.full_name || row.username } : null;
}

/** Names for a set of profile ids, for tables that show an owner column. */
async function memberNames(supabase: DB, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, username")
    .in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.full_name || p.username]));
}

// ---- Shared filter reading ----------------------------------------------

type Filters = {
  status: string;
  stage: string;
  score: string;
  source: string;
  query: string;
  /** Resolved from `owner`; null when nothing was asked for or nothing matched. */
  ownerId: string | null;
  ownerName: string;
  days: number | null;
  on: string | null;
  /** Window bounds as ISO timestamps, derived from `on` or `days`. */
  since: string | null;
  until: string | null;
  limit: number;
  today: string;
};

function readFilters(args: Record<string, unknown>, ctx: ToolContext): Filters {
  const on = isDate(str(args.on)) ? str(args.on) : null;
  const daysRaw = Number(args.days);
  const days = Number.isFinite(daysRaw) ? clampDays(daysRaw, 30) : null;
  const window = on ? colomboDay(on) : null;
  return {
    status: str(args.status).toLowerCase(),
    stage: str(args.stage),
    score: str(args.score).toLowerCase(),
    source: str(args.source),
    query: str(args.query),
    ownerId: null,
    ownerName: "",
    days,
    on,
    since: window ? window.start : days ? sinceIso(days) : null,
    until: window ? window.end : null,
    limit: clampLimit(args.limit),
    today: ctx.today,
  };
}

/** True when a stored timestamp falls inside the requested window. */
function inWindow(iso: string | null | undefined, f: Filters): boolean {
  if (!f.since && !f.until) return true;
  if (!iso) return false;
  if (f.since && iso < f.since) return false;
  if (f.until && iso >= f.until) return false;
  return true;
}

/** How the window reads in a subtitle, so a filtered table never looks total. */
function windowLabel(f: Filters, fallback: string): string {
  if (f.on) return fmtDateTime(f.on) ?? f.on;
  if (f.days) return `Last ${f.days} days`;
  return fallback;
}

// ---- The dataset contract shared by crm_query and growth_query ----------

/** One table artifact a dataset branch produces, before it is capped. */
type Dataset = {
  title: string;
  subtitle?: string;
  summary?: string;
  href: string;
  area: AppArea;
  columns: ArtifactColumn[];
  rows: ArtifactRow[];
  total_label?: string;
  total_value?: ArtifactCell;
  total_format?: ArtifactFormat;
  footnote?: string;
  /** Numbers for the model that the table itself does not carry. */
  facts?: Record<string, unknown>;
  /** Overrides the generic "nothing matched" copy when emptiness is meaningful. */
  empty_reason?: string;
};

/** Turn a built dataset into the artifact + compact JSON the model reads. */
function datasetResult(dataset: string, built: Dataset, f: Filters): ToolResult {
  const matched = built.rows.length;
  const shown = built.rows.slice(0, f.limit);

  if (!matched) {
    return {
      content: {
        ok: false,
        dataset,
        reason:
          built.empty_reason ??
          `Nothing in ${built.title.toLowerCase()} matches that. Say so plainly rather than estimating.`,
        filters: {
          status: f.status || null,
          query: f.query || null,
          on: f.on,
          days: f.days,
        },
        ...(built.facts ?? {}),
      },
      event: { kind: "read", label: built.title, href: built.href },
      artifacts: [
        tableArtifact({
          title: built.title,
          subtitle: "Nothing matched",
          summary: built.summary,
          href: built.href,
          area: built.area,
          columns: built.columns,
          rows: [],
          ...(built.footnote ? { footnote: built.footnote } : {}),
        }),
      ],
    };
  }

  return {
    content: {
      ok: true,
      dataset,
      matched,
      shown: shown.length,
      window: f.on ? `${f.on} (Sri Lanka)` : f.days ? `last ${f.days} days` : "all time",
      total_label: built.total_label ?? null,
      total_value: built.total_value ?? null,
      note: built.summary ?? null,
      ...(built.facts ?? {}),
      // The same cells the artifact shows, capped — the full list is already
      // in the preview canvas beside the conversation.
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
              total_format: built.total_format ?? "number",
            }
          : {}),
        ...(built.footnote ? { footnote: built.footnote } : {}),
      }),
    ],
  };
}

// ---- pipeline_report -----------------------------------------------------

type LeadRow = {
  id: string;
  title: string;
  company: string | null;
  contact_name: string | null;
  value: number | null;
  stage_id: string | null;
  pipeline_id: string;
  status: string;
  score: string | null;
  source: string;
  assigned_to: string | null;
  last_activity_at: string;
  created_at: string;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  expected_close_date: string | null;
  probability: number | null;
};

const LEAD_COLUMNS =
  "id, title, company, contact_name, value, stage_id, pipeline_id, status, score, source, assigned_to, last_activity_at, created_at, won_at, lost_at, lost_reason, expected_close_date, probability";

/** The lead activity kinds that count as "something moved". */
const MOVEMENT_KINDS: LeadActivityKind[] = [
  "created",
  "stage_changed",
  "status_changed",
  "call",
  "meeting",
  "quote",
  "note",
  "email",
  "sms",
];

async function pipelineReport(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const days = clampDays(args.days, 7);
  const since = sinceIso(days);

  const { data: pipes, error: pipeError } = await supabase
    .from("pipelines")
    .select("id, name, stale_after_days, position")
    .order("position");
  if (pipeError) return { content: { ok: false, error: pipeError.message } };
  if (!pipes?.length) {
    return { content: { ok: false, reason: "There are no CRM pipelines set up yet." } };
  }

  const asked = str(args.pipeline);
  const pipeline = asked ? pipes.find((p) => contains(p.name, asked)) : pipes[0];
  if (!pipeline) {
    return {
      content: {
        ok: false,
        reason: `No pipeline matching "${asked}".`,
        pipelines: pipes.map((p) => p.name),
      },
    };
  }

  const [stageRes, leadRes, actRes] = await Promise.all([
    supabase
      .from("pipeline_stages")
      .select("id, name, position")
      .eq("pipeline_id", pipeline.id)
      .order("position"),
    supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("pipeline_id", pipeline.id)
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(2000),
    supabase
      .from("lead_activities")
      .select("id, lead_id, kind, title, body, created_at, actor_id")
      .gte("created_at", since)
      .in("kind", MOVEMENT_KINDS)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  const error = stageRes.error ?? leadRes.error ?? actRes.error;
  if (error) return { content: { ok: false, error: error.message } };

  const stages = stageRes.data ?? [];
  const leads = (leadRes.data ?? []) as LeadRow[];
  const open = leads.filter((l) => l.status === "open");

  const openValue = total(open, (l) => num(l.value));
  const won = leads.filter((l) => l.won_at && l.won_at >= since);
  const lost = leads.filter((l) => l.lost_at && l.lost_at >= since);
  const fresh = leads.filter((l) => l.created_at >= since);
  const closed = won.length + lost.length;
  const winRate = closed > 0 ? Math.round((won.length / closed) * 100) : null;

  // Staleness follows THIS pipeline's own setting, which is what the board
  // colours a card by. The weekly digest hardcodes seven days instead, so the
  // rule is named in the summary rather than left to be guessed at.
  const staleAfter = pipeline.stale_after_days || 7;
  const cold = open
    .filter((l) => daysSince(l.last_activity_at) >= staleAfter)
    .sort((a, b) => daysSince(b.last_activity_at) - daysSince(a.last_activity_at));

  // The forecast mirrors the CRM's own Forecast tab exactly: weighted value
  // over SCHEDULED deals only (a value AND a close date). Reporting it
  // against every open lead would inflate it against what the screen shows.
  const scheduled = open.filter((l) => num(l.value) > 0 && l.expected_close_date);
  const weighted = total(scheduled, (l) => num(l.value) * ((l.probability ?? 100) / 100));

  const scoreMix = {
    hot: open.filter((l) => l.score === "hot").length,
    warm: open.filter((l) => l.score === "warm").length,
    cold: open.filter((l) => l.score === "cold").length,
    unscored: open.filter((l) => !l.score).length,
  };

  const byStage = stages.map((s) => {
    const rows = open.filter((l) => l.stage_id === s.id);
    const oldest = rows.length ? Math.max(...rows.map((l) => daysSince(l.last_activity_at))) : 0;
    return {
      id: s.id,
      name: s.name,
      count: rows.length,
      value: total(rows, (l) => num(l.value)),
      hot: rows.filter((l) => l.score === "hot").length,
      oldest,
    };
  });
  const unstaged = open.filter((l) => !l.stage_id);
  if (unstaged.length) {
    byStage.push({
      id: "unstaged",
      name: "No stage",
      count: unstaged.length,
      value: total(unstaged, (l) => num(l.value)),
      hot: unstaged.filter((l) => l.score === "hot").length,
      oldest: Math.max(...unstaged.map((l) => daysSince(l.last_activity_at))),
    });
  }

  const leadById = new Map(leads.map((l) => [l.id, l]));
  const movements = (actRes.data ?? []).filter((a) => leadById.has(a.lead_id));
  const actorNames = await memberNames(supabase, movements.map((a) => a.actor_id));

  const boardHref = `/crm?p=${pipeline.id}`;
  const metrics: ArtifactField[] = [
    { label: "Open pipeline", value: money(openValue), format: "money", tone: "info" },
    { label: "Open deals", value: open.length, format: "number" },
    { label: `New in ${days}d`, value: fresh.length, format: "number", tone: "positive" },
    {
      label: `Won in ${days}d`,
      value: money(total(won, (l) => num(l.value))),
      format: "money",
      tone: "positive",
    },
    {
      label: `Lost in ${days}d`,
      value: money(total(lost, (l) => num(l.value))),
      format: "money",
      tone: lost.length ? "danger" : "neutral",
    },
    {
      label: "Win rate",
      value: winRate,
      format: "percent",
      tone: winRate === null ? "neutral" : winRate >= 50 ? "positive" : "warning",
    },
    {
      label: `Going cold (${staleAfter}d+)`,
      value: cold.length,
      format: "number",
      tone: cold.length ? "warning" : "positive",
    },
    { label: "Weighted forecast", value: money(weighted), format: "money", tone: "info" },
  ];

  const stageColumns: ArtifactColumn[] = [
    { key: "stage", label: "Stage" },
    { key: "deals", label: "Open deals", format: "number", align: "right" },
    { key: "value", label: "Value", format: "money", align: "right" },
    { key: "hot", label: "Hot", format: "number", align: "right", secondary: true },
    { key: "oldest", label: "Oldest touch (days)", format: "number", align: "right" },
  ];

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: `Pipeline — ${pipeline.name}`,
      subtitle: `Open deals now, movement over the last ${days} days`,
      summary: `Open, untrashed leads only — won, lost and deleted deals are excluded, so this is smaller than a raw sum of every lead. "Going cold" uses this pipeline's own ${staleAfter}-day rule. The weighted forecast covers only the ${scheduled.length} deals that have both a value and a close date.`,
      href: boardHref,
      area: "crm",
      metrics,
      actions: [
        { label: "Open the board", href: boardHref },
        { label: "Forecast and reports", href: "/projects/reports" },
      ],
    }),
    chartArtifact({
      title: "Open value by stage",
      subtitle: pipeline.name,
      href: boardHref,
      area: "crm",
      chart: "bar",
      format: "money",
      points: byStage.map((s) => ({
        label: s.name,
        value: money(s.value),
        tone: (s.oldest >= staleAfter ? "warning" : "info") as ArtifactTone,
      })),
    }),
    tableArtifact({
      title: "Stage by stage",
      subtitle: "Where the open work is sitting",
      href: boardHref,
      area: "crm",
      columns: stageColumns,
      rows: rowsToTable(byStage, stageColumns, (s) => ({
        id: s.id,
        href: boardHref,
        tone: (s.count === 0
          ? "neutral"
          : s.oldest >= staleAfter
            ? "warning"
            : "info") as ArtifactTone,
        cells: {
          stage: s.name,
          deals: s.count,
          value: money(s.value),
          hot: s.hot,
          oldest: s.count ? s.oldest : 0,
        },
      })),
      total_label: "Open pipeline",
      total_value: money(openValue),
      total_format: "money",
      footnote:
        "A stage total is the value of the open deals sitting in it right now, not everything that ever passed through it.",
    }),
  ];

  if (movements.length) {
    artifacts.push(
      timelineArtifact({
        title: `What moved — last ${days} days`,
        subtitle: `${movements.length} events across ${new Set(movements.map((m) => m.lead_id)).size} deals`,
        summary:
          "Written by the CRM itself: stage moves, status changes and logged calls, notes and quotes.",
        href: boardHref,
        area: "crm",
        entries: movements.slice(0, 40).map((a) => {
          const lead = leadById.get(a.lead_id);
          return {
            when: fmtDateTime(a.created_at) ?? a.created_at,
            label: `${lead?.title ?? "Lead"} — ${a.title}`,
            detail: [
              clip(a.body, 160),
              a.actor_id ? actorNames.get(a.actor_id) : "system",
            ]
              .filter(Boolean)
              .join(" · "),
            href: `/crm/lead/${a.lead_id}`,
            tone: (a.kind === "status_changed"
              ? "positive"
              : a.kind === "stage_changed"
                ? "info"
                : "neutral") as ArtifactTone,
          };
        }),
      }),
    );
  }

  if (won.length || lost.length) {
    const closeColumns: ArtifactColumn[] = [
      { key: "lead", label: "Deal" },
      { key: "company", label: "Company", secondary: true },
      { key: "value", label: "Value", format: "money", align: "right" },
      { key: "outcome", label: "Outcome", format: "status" },
      { key: "when", label: "Closed", format: "date" },
      { key: "why", label: "Reason", secondary: true },
    ];
    const closedRows = [...won, ...lost].sort((a, b) =>
      (b.won_at ?? b.lost_at ?? "").localeCompare(a.won_at ?? a.lost_at ?? ""),
    );
    artifacts.push(
      tableArtifact({
        title: `Closed in the last ${days} days`,
        href: boardHref,
        area: "crm",
        columns: closeColumns,
        rows: rowsToTable(closedRows, closeColumns, (l) => ({
          id: l.id,
          href: `/crm/lead/${l.id}`,
          tone: (l.status === "won" ? "positive" : "danger") as ArtifactTone,
          cells: {
            lead: l.title,
            company: l.company ?? "—",
            value: money(num(l.value)),
            outcome: l.status,
            when: (l.won_at ?? l.lost_at ?? "").slice(0, 10),
            why: l.lost_reason ?? "—",
          },
        })),
        total_label: "Won value",
        total_value: money(total(won, (l) => num(l.value))),
        total_format: "money",
      }),
    );
  }

  return {
    content: {
      ok: true,
      pipeline: pipeline.name,
      window_days: days,
      currency: "LKR",
      open_deals: open.length,
      open_pipeline_value: money(openValue),
      basis: "open, untrashed leads only — won, lost and deleted deals excluded",
      new_leads: fresh.length,
      won: { count: won.length, value: money(total(won, (l) => num(l.value))) },
      lost: { count: lost.length, value: money(total(lost, (l) => num(l.value))) },
      win_rate_percent: winRate,
      win_rate_note:
        winRate === null
          ? "Nothing closed in this window, so there is no win rate to report."
          : "Won ÷ (won + lost) over the window.",
      going_cold: {
        count: cold.length,
        rule: `open and untouched for ${staleAfter}+ days (this pipeline's own setting)`,
        value: money(total(cold, (l) => num(l.value))),
      },
      weighted_forecast: money(weighted),
      weighted_forecast_note: `Σ value × (probability ÷ 100) over the ${scheduled.length} open deals that have both a value and an expected close date — not every open deal.`,
      score_mix: scoreMix,
      stages: byStage.map((s) => ({
        stage: s.name,
        deals: s.count,
        value: money(s.value),
        oldest_touch_days: s.count ? s.oldest : null,
      })),
      recent_movement: movements.slice(0, 15).map((a) => ({
        when: fmtDateTime(a.created_at),
        lead: leadById.get(a.lead_id)?.title ?? "Lead",
        what: a.title,
      })),
      truncated:
        leads.length >= 2000
          ? "The lead read was capped at 2000 rows; older deals may be missing."
          : null,
    },
    event: { kind: "read", label: `Pipeline — ${pipeline.name}`, href: boardHref },
    artifacts,
  };
}

// ---- crm_query datasets --------------------------------------------------

type CrmBase = {
  leads: LeadRow[];
  stages: Map<string, { name: string; pipeline_id: string }>;
  pipelines: Map<string, { name: string; stale_after_days: number }>;
  owners: Map<string, string>;
  capped: boolean;
};

/** Every live lead plus the lookups a lead table needs, fetched once. */
async function loadCrmLeads(supabase: DB): Promise<CrmBase | string> {
  const [leadRes, stageRes, pipeRes] = await Promise.all([
    supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(2000),
    supabase.from("pipeline_stages").select("id, name, pipeline_id").limit(300),
    supabase.from("pipelines").select("id, name, stale_after_days").limit(50),
  ]);
  const error = leadRes.error ?? stageRes.error ?? pipeRes.error;
  if (error) return error.message;

  const leads = (leadRes.data ?? []) as LeadRow[];
  return {
    leads,
    stages: new Map(
      (stageRes.data ?? []).map((s) => [s.id, { name: s.name, pipeline_id: s.pipeline_id }]),
    ),
    pipelines: new Map(
      (pipeRes.data ?? []).map((p) => [
        p.id,
        { name: p.name, stale_after_days: p.stale_after_days || 7 },
      ]),
    ),
    owners: await memberNames(supabase, leads.map((l) => l.assigned_to)),
    capped: leads.length >= 2000,
  };
}

function leadTone(l: LeadRow, staleAfter: number): ArtifactTone {
  if (l.status === "won") return "positive";
  if (l.status === "lost") return "danger";
  if (daysSince(l.last_activity_at) >= staleAfter) return "warning";
  return l.score === "hot" ? "positive" : "info";
}

const LEAD_TABLE_COLUMNS: ArtifactColumn[] = [
  { key: "lead", label: "Deal" },
  { key: "company", label: "Company", secondary: true },
  { key: "stage", label: "Stage", format: "status" },
  { key: "value", label: "Value", format: "money", align: "right" },
  { key: "score", label: "Score", format: "status" },
  { key: "owner", label: "Owner", secondary: true },
  { key: "idle", label: "Days idle", format: "number", align: "right" },
  { key: "status", label: "Status", format: "status" },
];

function leadRows(rows: LeadRow[], base: CrmBase): ArtifactRow[] {
  return rowsToTable(rows, LEAD_TABLE_COLUMNS, (l) => {
    const staleAfter = base.pipelines.get(l.pipeline_id)?.stale_after_days ?? 7;
    return {
      id: l.id,
      href: `/crm/lead/${l.id}`,
      tone: leadTone(l, staleAfter),
      cells: {
        lead: l.title,
        company: l.company ?? l.contact_name ?? "—",
        stage: l.stage_id ? (base.stages.get(l.stage_id)?.name ?? "—") : "No stage",
        value: money(num(l.value)),
        score: l.score ?? "unscored",
        owner: l.assigned_to ? (base.owners.get(l.assigned_to) ?? "—") : "Unassigned",
        idle: Math.min(9999, daysSince(l.last_activity_at)),
        status: l.status,
      },
    };
  });
}

async function datasetLeads(supabase: DB, f: Filters): Promise<Dataset | string> {
  const base = await loadCrmLeads(supabase);
  if (typeof base === "string") return base;

  const wantStatus = ["open", "won", "lost"].includes(f.status) ? f.status : f.status === "all" ? "" : "open";
  let rows = base.leads;
  if (wantStatus) rows = rows.filter((l) => l.status === wantStatus);
  if (f.stage) {
    rows = rows.filter((l) => l.stage_id && contains(base.stages.get(l.stage_id)?.name, f.stage));
  }
  if (f.ownerId) rows = rows.filter((l) => l.assigned_to === f.ownerId);
  if (f.score === "unscored") rows = rows.filter((l) => !l.score);
  else if (["hot", "warm", "cold"].includes(f.score)) rows = rows.filter((l) => l.score === f.score);
  if (f.source) rows = rows.filter((l) => contains(l.source, f.source));
  if (f.query) {
    rows = rows.filter(
      (l) =>
        contains(l.title, f.query) ||
        contains(l.company, f.query) ||
        contains(l.contact_name, f.query),
    );
  }
  if (f.since || f.until) rows = rows.filter((l) => inWindow(l.created_at, f));

  // Highest value first — "who should I call" is a money question before it
  // is a recency one; ties fall back to the freshest touch.
  rows = [...rows].sort(
    (a, b) => num(b.value) - num(a.value) || b.last_activity_at.localeCompare(a.last_activity_at),
  );

  return {
    title: "CRM leads",
    subtitle: [
      wantStatus ? `${wantStatus} deals` : "every deal",
      f.score ? f.score : "",
      f.ownerName ? `owned by ${f.ownerName}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    summary:
      "Trashed leads are excluded. Sorted by value, highest first. 'Days idle' counts from the last logged activity, which is what the board colours a card by — editing a lead does not reset it.",
    href: "/crm",
    area: "crm",
    columns: LEAD_TABLE_COLUMNS,
    rows: leadRows(rows, base),
    total_label: "Value listed",
    total_value: money(total(rows, (l) => num(l.value))),
    total_format: "money",
    facts: {
      currency: "LKR",
      hot: rows.filter((l) => l.score === "hot").length,
      unassigned: rows.filter((l) => !l.assigned_to).length,
      capped: base.capped ? "the lead read was capped at 2000 rows" : null,
    },
  };
}

async function datasetStaleLeads(supabase: DB, f: Filters): Promise<Dataset | string> {
  const base = await loadCrmLeads(supabase);
  if (typeof base === "string") return base;

  let rows = base.leads.filter((l) => l.status === "open");
  if (f.ownerId) rows = rows.filter((l) => l.assigned_to === f.ownerId);
  if (f.stage) {
    rows = rows.filter((l) => l.stage_id && contains(base.stages.get(l.stage_id)?.name, f.stage));
  }
  if (f.query) {
    rows = rows.filter((l) => contains(l.title, f.query) || contains(l.company, f.query));
  }

  // Per-pipeline threshold unless the caller named their own number of days.
  rows = rows.filter((l) => {
    const threshold = f.days ?? base.pipelines.get(l.pipeline_id)?.stale_after_days ?? 7;
    return daysSince(l.last_activity_at) >= threshold;
  });
  rows = [...rows].sort(
    (a, b) => daysSince(b.last_activity_at) - daysSince(a.last_activity_at) || num(b.value) - num(a.value),
  );

  return {
    title: "Deals going cold",
    subtitle: f.days
      ? `Untouched for ${f.days}+ days`
      : "Past each pipeline's own staleness setting",
    summary: f.days
      ? `Open deals with no logged activity for ${f.days} days or more.`
      : "Open deals past the staleness threshold their own pipeline sets (the same rule that greys a card on the board). The weekly AI digest uses a flat 7 days instead, so the two can disagree.",
    href: "/crm",
    area: "crm",
    columns: LEAD_TABLE_COLUMNS,
    rows: leadRows(rows, base),
    total_label: "Value at risk",
    total_value: money(total(rows, (l) => num(l.value))),
    total_format: "money",
    empty_reason:
      "Nothing is going cold — every open deal has been touched inside its pipeline's window.",
    facts: { currency: "LKR" },
  };
}

async function datasetActivities(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("lead_activities")
    .select("id, lead_id, kind, title, body, created_at, actor_id")
    .order("created_at", { ascending: false })
    .limit(400);
  if (f.since) q = q.gte("created_at", f.since);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  const rows = data ?? [];
  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const [leadRes, actors] = await Promise.all([
    leadIds.length
      ? supabase.from("leads").select("id, title, company").in("id", leadIds)
      : Promise.resolve({ data: [], error: null }),
    memberNames(supabase, rows.map((r) => r.actor_id)),
  ]);
  if (leadRes.error) return leadRes.error.message;
  const leads = new Map((leadRes.data ?? []).map((l) => [l.id, l]));

  let filtered = rows;
  if (f.query) {
    filtered = filtered.filter((r) => {
      const lead = leads.get(r.lead_id);
      return (
        contains(lead?.title, f.query) ||
        contains(lead?.company, f.query) ||
        contains(r.title, f.query) ||
        contains(r.body, f.query)
      );
    });
  }
  if (f.status) filtered = filtered.filter((r) => r.kind === f.status);

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "lead", label: "Deal" },
    { key: "kind", label: "Kind", format: "status" },
    { key: "what", label: "What happened" },
    { key: "who", label: "Who", secondary: true },
  ];

  return {
    title: "CRM activity",
    subtitle: windowLabel(f, "Newest first"),
    summary:
      "Written by the CRM itself — stage moves, field edits and logged calls, notes, emails and quotes. Rows with no 'who' were done by an automation or the WhatsApp agent, which have no signed-in user.",
    href: "/crm",
    area: "crm",
    columns,
    rows: rowsToTable(filtered, columns, (r) => ({
      id: r.id,
      href: `/crm/lead/${r.lead_id}`,
      tone: (r.kind === "status_changed"
        ? "positive"
        : r.kind === "stage_changed"
          ? "info"
          : "neutral") as ArtifactTone,
      cells: {
        when: fmtDateTime(r.created_at),
        lead: leads.get(r.lead_id)?.title ?? "Lead",
        kind: r.kind,
        what: [r.title, clip(r.body, 120)].filter(Boolean).join(" — "),
        who: r.actor_id ? (actors.get(r.actor_id) ?? "—") : "system",
      },
    })),
  };
}

async function datasetTasks(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("crm_tasks")
    .select("id, lead_id, company_id, title, notes, due_at, assigned_to, status, completed_at, created_at")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(400);
  if (error) return error.message;

  const nowIso = new Date().toISOString();
  let rows = (data ?? []).map((t) => ({
    ...t,
    // There is no 'overdue' status — it is an open task whose due date has
    // passed, and a task with no due date can never be overdue at all.
    overdue: t.status === "open" && Boolean(t.due_at) && (t.due_at as string) < nowIso,
  }));
  if (f.status === "overdue") rows = rows.filter((t) => t.overdue);
  else if (f.status === "open" || f.status === "done") rows = rows.filter((t) => t.status === f.status);
  else rows = rows.filter((t) => t.status === "open");
  if (f.ownerId) rows = rows.filter((t) => t.assigned_to === f.ownerId);
  if (f.query) rows = rows.filter((t) => contains(t.title, f.query) || contains(t.notes, f.query));
  if (f.since || f.until) rows = rows.filter((t) => inWindow(t.due_at ?? t.created_at, f));

  const leadIds = [...new Set(rows.map((t) => t.lead_id).filter((id): id is string => Boolean(id)))];
  const [leadRes, owners] = await Promise.all([
    leadIds.length
      ? supabase.from("leads").select("id, title").in("id", leadIds)
      : Promise.resolve({ data: [], error: null }),
    memberNames(supabase, rows.map((t) => t.assigned_to)),
  ]);
  if (leadRes.error) return leadRes.error.message;
  const leads = new Map((leadRes.data ?? []).map((l) => [l.id, l.title]));

  const columns: ArtifactColumn[] = [
    { key: "task", label: "Task" },
    { key: "lead", label: "Deal", secondary: true },
    { key: "due", label: "Due", format: "datetime" },
    { key: "owner", label: "Assigned", secondary: true },
    { key: "status", label: "Status", format: "status" },
  ];

  return {
    title: "CRM tasks",
    subtitle: f.status === "overdue" ? "Overdue" : f.status === "done" ? "Completed" : "Still open",
    summary:
      "'Overdue' means an open task whose due date has passed — a task with no due date is never counted as overdue.",
    href: "/crm",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (t) => ({
      id: t.id,
      href: t.lead_id ? `/crm/lead/${t.lead_id}` : "/crm",
      tone: (t.status === "done" ? "positive" : t.overdue ? "danger" : "info") as ArtifactTone,
      cells: {
        task: t.title,
        lead: t.lead_id ? (leads.get(t.lead_id) ?? "—") : "—",
        due: t.due_at ? fmtDateTime(t.due_at) : "no date",
        owner: t.assigned_to ? (owners.get(t.assigned_to) ?? "—") : "Unassigned",
        status: t.overdue ? "overdue" : t.status,
      },
    })),
    total_label: "Overdue in this list",
    total_value: rows.filter((t) => t.overdue).length,
    total_format: "number",
  };
}

async function datasetCompanies(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [compRes, leadRes] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, website, email, phone, city, industry, created_at")
      .order("name")
      .limit(500),
    supabase
      .from("leads")
      .select("id, company_id, value, status")
      .not("company_id", "is", null)
      .is("deleted_at", null)
      .limit(2000),
  ]);
  if (compRes.error) return compRes.error.message;
  if (leadRes.error) return leadRes.error.message;

  // The /crm/companies page rolls these up client-side for the same reason —
  // there are no cached deal-count or value columns on `companies`.
  const rollup = new Map<string, { deals: number; open: number; value: number; won: number }>();
  for (const l of leadRes.data ?? []) {
    if (!l.company_id) continue;
    const entry = rollup.get(l.company_id) ?? { deals: 0, open: 0, value: 0, won: 0 };
    entry.deals += 1;
    if (l.status === "open") {
      entry.open += 1;
      entry.value += num(l.value);
    }
    if (l.status === "won") entry.won += num(l.value);
    rollup.set(l.company_id, entry);
  }

  let rows = (compRes.data ?? []).map((c) => ({ ...c, ...(rollup.get(c.id) ?? { deals: 0, open: 0, value: 0, won: 0 }) }));
  if (f.query) {
    rows = rows.filter(
      (c) => contains(c.name, f.query) || contains(c.industry, f.query) || contains(c.city, f.query),
    );
  }
  rows = rows.sort((a, b) => b.value - a.value || b.deals - a.deals);

  const columns: ArtifactColumn[] = [
    { key: "company", label: "Company" },
    { key: "industry", label: "Industry", secondary: true },
    { key: "city", label: "City", secondary: true },
    { key: "deals", label: "Deals", format: "number", align: "right" },
    { key: "open", label: "Open", format: "number", align: "right" },
    { key: "value", label: "Open value", format: "money", align: "right" },
    { key: "won", label: "Won value", format: "money", align: "right", secondary: true },
    { key: "website", label: "Website", format: "url", secondary: true },
  ];

  return {
    title: "Companies",
    subtitle: f.query ? `Matching "${f.query}"` : "Highest open value first",
    summary:
      "Deal counts and values are rolled up live from untrashed leads — there is no stored total on a company, so this always matches the board.",
    href: "/crm/companies",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: "/crm/companies",
      tone: (c.open > 0 ? "info" : c.won > 0 ? "positive" : "neutral") as ArtifactTone,
      cells: {
        company: c.name,
        industry: c.industry ?? "—",
        city: c.city ?? "—",
        deals: c.deals,
        open: c.open,
        value: money(c.value),
        won: money(c.won),
        website: c.website ?? "—",
      },
    })),
    total_label: "Open value across these accounts",
    total_value: money(total(rows, (c) => c.value)),
    total_format: "money",
  };
}

async function datasetResearch(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("lead_research")
    .select("id, lead_id, company_name, status, error, report, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (f.since) q = q.gte("updated_at", f.since);
  if (f.until) q = q.lt("updated_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = (data ?? []).map((r) => {
    // The jsonb column is untyped; parsing it is the only safe way to read a
    // score, and a half-written report parses to sensible empties.
    const report = parseResearchReport(r.report);
    return {
      ...r,
      audit: report.audit?.overall ?? null,
      measured: report.audit?.measured ?? null,
      confidence: report.match_confidence || "—",
      overview: report.overview,
      issues: report.audit?.issues.length ?? 0,
    };
  });
  if (f.query) rows = rows.filter((r) => contains(r.company_name, f.query));
  if (f.status === "done" || f.status === "error" || f.status === "pending") {
    rows = rows.filter((r) => r.status === f.status);
  } else if (f.status === "running") {
    rows = rows.filter((r) => !["done", "error"].includes(r.status));
  }

  const columns: ArtifactColumn[] = [
    { key: "company", label: "Company" },
    { key: "status", label: "Status", format: "status" },
    { key: "audit", label: "Site score", format: "number", align: "right" },
    { key: "issues", label: "Issues found", format: "number", align: "right", secondary: true },
    { key: "confidence", label: "Match", format: "status", secondary: true },
    { key: "updated", label: "Updated", format: "datetime" },
  ];

  return {
    title: "Prospect research",
    subtitle: windowLabel(f, "Newest first"),
    summary:
      "The dossier pipeline runs pending → running → done; only 'done' and 'error' are finished. A 'limited' site score means Google PageSpeed could not run, so the number is capped and must not read as a confident pass.",
    href: "/crm/research",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: `/crm/research?lead=${r.lead_id}`,
      tone: (r.status === "error"
        ? "danger"
        : r.status === "done"
          ? "positive"
          : "info") as ArtifactTone,
      cells: {
        company: r.company_name,
        status: r.status === "error" ? `error: ${clip(r.error, 60)}` : r.status,
        audit: r.audit,
        issues: r.issues,
        confidence: r.measured === "limited" ? `${r.confidence} (limited)` : r.confidence,
        updated: fmtDateTime(r.updated_at),
      },
    })),
  };
}

async function datasetOutreachDrafts(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("lead_outreach")
    .select("id, lead_id, status, recipients, sent_to, subject, audit_score, error, campaign_id, auto_send, created_at, updated_at, sent_at")
    .order("updated_at", { ascending: false })
    .limit(300);
  if (f.since) q = q.gte("updated_at", f.since);
  if (f.until) q = q.lt("updated_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.status === "in_progress") {
    rows = rows.filter((r) => ["pending", "researching", "drafting"].includes(r.status));
  } else if (f.status === "sent") {
    rows = rows.filter((r) => ["sent", "sending"].includes(r.status));
  } else if (f.status === "skipped") {
    rows = rows.filter((r) => ["skipped", "discarded"].includes(r.status));
  } else if (["ready", "failed"].includes(f.status)) {
    rows = rows.filter((r) => r.status === f.status);
  }

  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter((id): id is string => Boolean(id)))];
  const [leadRes, campRes] = await Promise.all([
    leadIds.length
      ? supabase.from("leads").select("id, title, company").in("id", leadIds)
      : Promise.resolve({ data: [], error: null }),
    campaignIds.length
      ? supabase.from("outreach_campaigns").select("id, name").in("id", campaignIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (leadRes.error) return leadRes.error.message;
  if (campRes.error) return campRes.error.message;
  const leads = new Map((leadRes.data ?? []).map((l) => [l.id, l]));
  const camps = new Map((campRes.data ?? []).map((c) => [c.id, c.name]));

  if (f.query) {
    rows = rows.filter((r) => {
      const lead = leads.get(r.lead_id);
      return contains(lead?.company, f.query) || contains(lead?.title, f.query) || contains(r.subject, f.query);
    });
  }

  const columns: ArtifactColumn[] = [
    { key: "company", label: "Company" },
    { key: "status", label: "Status", format: "status" },
    { key: "subject", label: "Subject" },
    { key: "to", label: "To", format: "email", secondary: true },
    { key: "score", label: "Draft score", format: "number", align: "right", secondary: true },
    { key: "campaign", label: "Campaign", secondary: true },
    { key: "when", label: "Updated", format: "datetime" },
  ];

  return {
    title: "Cold email drafts",
    subtitle: f.status === "ready" ? "Waiting for approval" : windowLabel(f, "Newest first"),
    summary:
      "One draft per lead, ever. 'ready' means written and waiting for a human to approve it. Opens and clicks are NOT tracked, so never report an open rate — 'sent' means the mail provider accepted it.",
    href: "/crm/outreach",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: `/crm/lead/${r.lead_id}`,
      tone: (r.status === "sent"
        ? "positive"
        : r.status === "failed"
          ? "danger"
          : r.status === "ready"
            ? "warning"
            : "info") as ArtifactTone,
      cells: {
        company: leads.get(r.lead_id)?.company ?? leads.get(r.lead_id)?.title ?? "—",
        status: r.status,
        subject: clip(r.subject, 90) || "—",
        to: (r.sent_to.length ? r.sent_to : r.recipients)[0] ?? "no address",
        score: r.audit_score,
        campaign: r.campaign_id ? (camps.get(r.campaign_id) ?? "—") : "one-off",
        when: fmtDateTime(r.updated_at),
      },
    })),
    total_label: "Awaiting approval",
    total_value: rows.filter((r) => r.status === "ready").length,
    total_format: "number",
  };
}

async function datasetCampaigns(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [campRes, rowRes] = await Promise.all([
    supabase
      .from("outreach_campaigns")
      .select("id, name, status, auto_send, daily_cap, queued, created_at, updated_at, finished_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("lead_outreach").select("campaign_id, status").not("campaign_id", "is", null).limit(5000),
  ]);
  if (campRes.error) return campRes.error.message;
  if (rowRes.error) return rowRes.error.message;

  // One grouped read instead of a campaignStats() round-trip per campaign,
  // folded exactly as campaignStats folds it: sending counts as sent,
  // discarded counts as skipped.
  const progress = new Map<string, { total: number; working: number; ready: number; sent: number; failed: number; skipped: number }>();
  for (const r of rowRes.data ?? []) {
    if (!r.campaign_id) continue;
    const e = progress.get(r.campaign_id) ?? { total: 0, working: 0, ready: 0, sent: 0, failed: 0, skipped: 0 };
    e.total += 1;
    if (["pending", "researching", "drafting"].includes(r.status)) e.working += 1;
    else if (r.status === "ready") e.ready += 1;
    else if (r.status === "sent" || r.status === "sending") e.sent += 1;
    else if (r.status === "failed") e.failed += 1;
    else e.skipped += 1;
    progress.set(r.campaign_id, e);
  }

  let rows = (campRes.data ?? []).map((c) => ({
    ...c,
    ...(progress.get(c.id) ?? { total: 0, working: 0, ready: 0, sent: 0, failed: 0, skipped: 0 }),
  }));
  if (f.query) rows = rows.filter((c) => contains(c.name, f.query));
  if (["running", "paused", "done", "cancelled"].includes(f.status)) {
    rows = rows.filter((c) => c.status === f.status);
  }
  if (f.since || f.until) rows = rows.filter((c) => inWindow(c.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "campaign", label: "Campaign" },
    { key: "status", label: "Status", format: "status" },
    { key: "queued", label: "Queued", format: "number", align: "right" },
    { key: "working", label: "Writing", format: "number", align: "right", secondary: true },
    { key: "ready", label: "To approve", format: "number", align: "right" },
    { key: "sent", label: "Sent", format: "number", align: "right" },
    { key: "failed", label: "Failed", format: "number", align: "right", secondary: true },
    { key: "cap", label: "Daily cap", format: "number", align: "right", secondary: true },
    { key: "auto", label: "Auto-send", format: "status", secondary: true },
  ];

  return {
    title: "Cold email campaigns",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary:
      "Progress is counted live from each campaign's drafts. 'paused' is reversible, 'cancelled' is terminal, and neither unsends anything already delivered — which is what the daily cap is for.",
    href: "/crm/outreach",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: "/crm/outreach",
      tone: (c.status === "running"
        ? "info"
        : c.status === "done"
          ? "positive"
          : c.status === "cancelled"
            ? "danger"
            : "warning") as ArtifactTone,
      cells: {
        campaign: c.name,
        status: c.status,
        queued: c.total || c.queued,
        working: c.working,
        ready: c.ready,
        sent: c.sent,
        failed: c.failed,
        cap: c.daily_cap,
        auto: c.auto_send ? "on" : "approve first",
      },
    })),
    total_label: "Emails sent across these campaigns",
    total_value: total(rows, (c) => c.sent),
    total_format: "number",
  };
}

async function datasetSuppressions(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("outreach_suppressions")
    .select("email, reason, lead_id, created_at")
    .order("created_at", { ascending: false })
    .limit(400);
  if (f.since) q = q.gte("created_at", f.since);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) rows = rows.filter((r) => contains(r.email, f.query));
  if (f.status) rows = rows.filter((r) => contains(r.reason, f.status));

  const columns: ArtifactColumn[] = [
    { key: "email", label: "Address", format: "email" },
    { key: "reason", label: "Why", format: "status" },
    { key: "when", label: "When", format: "datetime" },
  ];

  return {
    title: "Suppressed addresses",
    subtitle: windowLabel(f, "Newest first"),
    summary:
      "Addresses the mail provider told us to stop using: bounced, marked as spam, or unsubscribed. They are excluded from every future campaign automatically.",
    href: "/crm/outreach",
    area: "crm",
    columns,
    // No id column on this table — the address is the primary key.
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.email,
      href: r.lead_id ? `/crm/lead/${r.lead_id}` : "/crm/outreach",
      tone: (r.reason === "complaint" ? "danger" : "warning") as ArtifactTone,
      cells: { email: r.email, reason: r.reason, when: fmtDateTime(r.created_at) },
    })),
    total_label: "Suppressed in this window",
    total_value: rows.length,
    total_format: "number",
    empty_reason: "Nobody bounced, complained or unsubscribed in that window.",
  };
}

async function datasetProspectScans(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("prospect_scans")
    .select("id, status, country, city, categories, max_results, min_score, found, qualified, skipped, imported, error, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (f.since) q = q.gte("created_at", f.since);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) {
    rows = rows.filter(
      (s) => contains(s.city, f.query) || s.categories.some((c) => contains(c, f.query)),
    );
  }
  if (f.status === "running") rows = rows.filter((s) => !["done", "error"].includes(s.status));
  else if (f.status === "done" || f.status === "error") rows = rows.filter((s) => s.status === f.status);

  const columns: ArtifactColumn[] = [
    { key: "area", label: "Area" },
    { key: "categories", label: "Looking for" },
    { key: "status", label: "Status", format: "status" },
    { key: "found", label: "Found", format: "number", align: "right" },
    { key: "qualified", label: "Qualified", format: "number", align: "right" },
    { key: "imported", label: "Imported", format: "number", align: "right" },
    { key: "when", label: "Started", format: "datetime" },
  ];

  return {
    title: "Find Leads scans",
    subtitle: windowLabel(f, "Newest first"),
    summary:
      "The area scans behind Find Leads. Found → qualified → imported are counters the scan maintains as it runs; 'imported' is the number that actually became CRM leads.",
    href: "/crm/prospecting",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (s) => ({
      id: s.id,
      href: `/crm/prospecting?scan=${s.id}`,
      tone: (s.status === "error"
        ? "danger"
        : s.status === "done"
          ? "positive"
          : "info") as ArtifactTone,
      cells: {
        area: [s.city, s.country].filter(Boolean).join(", "),
        categories: s.categories.join(", ") || "—",
        status: s.status === "error" ? `error: ${clip(s.error, 60)}` : s.status,
        found: s.found,
        qualified: s.qualified,
        imported: s.imported,
        when: fmtDateTime(s.created_at),
      },
    })),
    total_label: "Leads imported",
    total_value: total(rows, (s) => s.imported),
    total_format: "number",
  };
}

async function datasetProspectCandidates(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("prospect_candidates")
    .select("id, scan_id, name, category, address, phone, website, rating, rating_count, website_verdict, score, issues, emails, status, reason, lead_id, created_at")
    .order("score", { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) return error.message;

  const scanIds = [...new Set((data ?? []).map((c) => c.scan_id))];
  const { data: scans, error: scanError } = scanIds.length
    ? await supabase.from("prospect_scans").select("id, city, categories, created_at").in("id", scanIds)
    : { data: [], error: null };
  if (scanError) return scanError.message;
  const scanBy = new Map((scans ?? []).map((s) => [s.id, s]));

  let rows = data ?? [];
  if (f.query) {
    rows = rows.filter(
      (c) =>
        contains(c.name, f.query) ||
        contains(c.category, f.query) ||
        contains(c.address, f.query) ||
        contains(scanBy.get(c.scan_id)?.city, f.query),
    );
  }
  if (["qualified", "imported", "skipped", "emailed", "pending"].includes(f.status)) {
    rows = rows.filter((c) => c.status === f.status);
  }
  if (f.since || f.until) rows = rows.filter((c) => inWindow(c.created_at, f));

  const columns: ArtifactColumn[] = [
    { key: "business", label: "Business" },
    { key: "category", label: "Category", secondary: true },
    { key: "verdict", label: "Website", format: "status" },
    { key: "score", label: "Score", format: "number", align: "right" },
    { key: "phone", label: "Phone", format: "phone", secondary: true },
    { key: "email", label: "Email", format: "email", secondary: true },
    { key: "status", label: "Status", format: "status" },
    { key: "scan", label: "Scan", secondary: true },
  ];

  return {
    title: "Prospect candidates",
    subtitle: f.status ? `Filtered: ${f.status}` : "Highest score first",
    summary:
      "Businesses the area scans turned up. The website verdict is the pitch: 'no_website', 'facebook_only', 'bad_website' and 'broken' are the ones worth chasing; 'good_website' and 'duplicate' are not.",
    href: "/crm/prospecting",
    area: "crm",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: c.lead_id ? `/crm/lead/${c.lead_id}` : `/crm/prospecting?scan=${c.scan_id}`,
      tone: (c.status === "imported"
        ? "positive"
        : c.status === "skipped"
          ? "neutral"
          : "info") as ArtifactTone,
      cells: {
        business: c.name,
        category: c.category || "—",
        verdict: c.website_verdict,
        score: c.score,
        phone: c.phone || "—",
        email: c.emails[0] ?? "—",
        status: c.status,
        scan: scanBy.get(c.scan_id)?.city ?? "—",
      },
    })),
    total_label: "Already imported",
    total_value: rows.filter((c) => c.status === "imported").length,
    total_format: "number",
  };
}

async function crmQuery(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = str(args.dataset).toLowerCase();
  const f = readFilters(args, ctx);
  const supabase = ctx.supabase;

  if (str(args.owner)) {
    const member = await resolveMember(supabase, ctx.userId, args.owner);
    if (!member) {
      return { content: { ok: false, reason: `No team member matching "${str(args.owner)}".` } };
    }
    f.ownerId = member.id;
    f.ownerName = member.name;
  }

  let built: Dataset | string;
  switch (dataset) {
    case "leads": built = await datasetLeads(supabase, f); break;
    case "stale_leads": built = await datasetStaleLeads(supabase, f); break;
    case "activities": built = await datasetActivities(supabase, f); break;
    case "tasks": built = await datasetTasks(supabase, f); break;
    case "companies": built = await datasetCompanies(supabase, f); break;
    case "research": built = await datasetResearch(supabase, f); break;
    case "outreach_drafts": built = await datasetOutreachDrafts(supabase, f); break;
    case "campaigns": built = await datasetCampaigns(supabase, f); break;
    case "suppressions": built = await datasetSuppressions(supabase, f); break;
    case "prospect_scans": built = await datasetProspectScans(supabase, f); break;
    case "prospect_candidates": built = await datasetProspectCandidates(supabase, f); break;
    default:
      return { content: { ok: false, error: `"${dataset}" is not a CRM dataset.` } };
  }
  if (typeof built === "string") return { content: { ok: false, error: built } };
  return datasetResult(dataset, built, f);
}

// ---- conversation_history ------------------------------------------------

type WaContactRow = {
  id: string;
  wa_id: string;
  profile_name: string | null;
  display_name: string | null;
  lead_id: string | null;
  client_id: string | null;
  agent_enabled: boolean;
  needs_attention: boolean;
  unread: number;
  do_not_contact: boolean;
  language: string | null;
  mode: string;
  campaign_id: string | null;
  call_booked_at: string | null;
  first_reply_seconds: number | null;
  last_message_at: string | null;
  last_direction: string | null;
  created_at: string;
};

const WA_CONTACT_COLUMNS =
  "id, wa_id, profile_name, display_name, lead_id, client_id, agent_enabled, needs_attention, unread, do_not_contact, language, mode, campaign_id, call_booked_at, first_reply_seconds, last_message_at, last_direction, created_at";

/** Who sent a WhatsApp message, in words a person would use. */
function waAuthor(
  m: { direction: string; sent_by: string | null; author_id: string | null },
  contactName: string,
  teamNames: Map<string, string>,
): string {
  if (m.direction === "in") return contactName;
  if (m.sent_by === "agent") return "Arc (AI agent)";
  if (m.sent_by === "automation") return "Automation";
  if (m.sent_by === "keyword") return "Keyword auto-reply";
  if (m.author_id) return teamNames.get(m.author_id) ?? "Team";
  return "Us";
}

async function whatsappHistory(
  args: Record<string, unknown>,
  ctx: ToolContext,
  limit: number,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const asked = str(args.contact);
  const safe = safeLike(asked);
  const digits = asked.replace(/\D/g, "");

  const parts: string[] = [];
  if (safe) {
    parts.push(`display_name.ilike.%${safe}%`, `profile_name.ilike.%${safe}%`);
  }
  if (digits.length >= 6) parts.push(`wa_id.ilike.%${digits.slice(-9)}%`);
  if (!parts.length) return { content: { ok: false, error: "Say who the conversation is with." } };

  const { data, error } = await supabase
    .from("wa_contacts")
    .select(WA_CONTACT_COLUMNS)
    .or(parts.join(","))
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(25);
  if (error) return { content: { ok: false, error: error.message } };

  let matches = (data ?? []) as WaContactRow[];

  // Fall back to the linked lead, so "what did the agent say to Cafe Aroma"
  // works even when the chat is saved under a person's own name.
  if (!matches.length && safe) {
    const { data: leads } = await supabase
      .from("leads")
      .select("id")
      .is("deleted_at", null)
      .or(`title.ilike.%${safe}%,company.ilike.%${safe}%,contact_name.ilike.%${safe}%`)
      .limit(10);
    const leadIds = (leads ?? []).map((l) => l.id);
    if (leadIds.length) {
      const { data: viaLead } = await supabase
        .from("wa_contacts")
        .select(WA_CONTACT_COLUMNS)
        .in("lead_id", leadIds)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(25);
      matches = (viaLead ?? []) as WaContactRow[];
    }
  }

  if (!matches.length) {
    return {
      content: {
        ok: false,
        reason: `No WhatsApp conversation with anyone matching "${asked}". Relay that rather than describing a chat that does not exist.`,
      },
    };
  }
  if (matches.length > 1) {
    return {
      content: {
        ok: false,
        reason: `"${asked}" matches ${matches.length} WhatsApp threads. Ask which one — nothing was read.`,
        candidates: matches.slice(0, 8).map((c) => ({
          name: waName(c),
          phone: waPhone(c.wa_id),
          last_message: fmtDateTime(c.last_message_at),
        })),
      },
    };
  }

  const contact = matches[0];
  const name = waName(contact);

  const [msgRes, campRes, leadRes, promiseRes] = await Promise.all([
    supabase
      .from("wa_messages")
      .select("id, direction, message_type, body, status, error, sent_by, author_id, created_at")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    contact.campaign_id
      ? supabase.from("wa_campaigns").select("id, name").eq("id", contact.campaign_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    contact.lead_id
      ? supabase.from("leads").select("id, title, company, status, value").eq("id", contact.lead_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("wa_promises")
      .select("summary, due_at, status")
      .eq("contact_id", contact.id)
      .order("due_at", { ascending: true })
      .limit(10),
  ]);
  const readError = msgRes.error ?? campRes.error ?? leadRes.error ?? promiseRes.error;
  if (readError) return { content: { ok: false, error: readError.message } };

  // Newest-first from the database (so a cap keeps the RECENT end of a long
  // thread), then flipped: a conversation only makes sense read downwards.
  const messages = [...(msgRes.data ?? [])].reverse();
  if (!messages.length) {
    return {
      content: {
        ok: false,
        reason: `${name} is in the WhatsApp inbox but the thread has no messages stored.`,
      },
    };
  }

  const teamNames = await memberNames(supabase, messages.map((m) => m.author_id));
  const lead = leadRes.data;
  const campaign = campRes.data;
  const promises = promiseRes.data ?? [];

  const fields: ArtifactField[] = [
    { label: "Phone", value: waPhone(contact.wa_id), format: "phone" },
    {
      label: "AI agent",
      value: contact.agent_enabled ? "answering" : "paused — a human has this thread",
      format: "status",
      tone: contact.agent_enabled ? "positive" : "warning",
    },
    {
      label: "Flagged for a human",
      value: contact.needs_attention ? "yes" : "no",
      format: "status",
      tone: contact.needs_attention ? "danger" : "neutral",
    },
    {
      label: "Language",
      value: contact.language
        ? (WA_LANGUAGE_LABELS[contact.language as keyof typeof WA_LANGUAGE_LABELS] ?? contact.language)
        : "not detected",
    },
    { label: "Thread type", value: contact.mode === "onboarding" ? "project onboarding" : "sales" },
    {
      label: "Call booked",
      value: contact.call_booked_at ? (fmtDateTime(contact.call_booked_at) ?? "—") : "no call booked",
      format: "status",
      tone: contact.call_booked_at ? "positive" : "neutral",
    },
    {
      label: "First reply speed",
      value: contact.first_reply_seconds ?? "—",
      format: "number",
    },
    { label: "Unread", value: contact.unread, format: "number" },
    {
      label: "Do not contact",
      value: contact.do_not_contact ? "yes" : "no",
      format: "status",
      tone: contact.do_not_contact ? "danger" : "neutral",
    },
    { label: "Campaign", value: campaign?.name ?? "—" },
    {
      label: "CRM deal",
      value: lead ? `${lead.title} (${lead.status})` : "not in the CRM",
      href: lead ? `/crm/lead/${lead.id}` : undefined,
    },
    { label: "First seen", value: fmtDateTime(contact.created_at) },
  ];

  const artifacts: Artifact[] = [
    recordArtifact({
      title: name,
      subtitle: "WhatsApp thread",
      summary:
        "Read-only. Arc cannot send a WhatsApp message — the agent owns this thread, and anything you want sent by hand goes out from the inbox.",
      href: "/whatsapp",
      area: "whatsapp",
      fields,
      actions: [{ label: "Open the inbox", href: "/whatsapp" }],
    }),
    timelineArtifact({
      title: `${name} — the conversation`,
      subtitle: `${messages.length} messages, oldest first`,
      summary:
        "The real messages, in the order they were sent, in Sri Lanka time. Read top to bottom.",
      href: "/whatsapp",
      area: "whatsapp",
      entries: messages.map((m) => ({
        when: fmtDateTime(m.created_at) ?? m.created_at,
        label: waAuthor(m, name, teamNames),
        detail:
          m.message_type !== "text" && !m.body
            ? `[${m.message_type}]`
            : clip(m.body, 900) || `[${m.message_type}]`,
        tone: (m.status === "failed"
          ? "danger"
          : m.direction === "in"
            ? "info"
            : m.sent_by === "agent"
              ? "positive"
              : "neutral") as ArtifactTone,
      })),
    }),
  ];

  if (promises.length) {
    const promiseColumns: ArtifactColumn[] = [
      { key: "what", label: "Promise" },
      { key: "due", label: "Due", format: "datetime" },
      { key: "status", label: "Status", format: "status" },
    ];
    artifacts.push(
      tableArtifact({
        title: `${name} — promised follow-ups`,
        href: "/whatsapp",
        area: "whatsapp",
        columns: promiseColumns,
        rows: rowsToTable(promises, promiseColumns, (p, i) => ({
          id: String(i),
          tone: (p.status === "pending" ? "warning" : "neutral") as ArtifactTone,
          cells: { what: p.summary, due: fmtDateTime(p.due_at), status: p.status },
        })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      channel: "whatsapp",
      contact: name,
      phone: waPhone(contact.wa_id),
      agent_enabled: contact.agent_enabled,
      needs_attention: contact.needs_attention,
      call_booked_at: fmtDateTime(contact.call_booked_at),
      campaign: campaign?.name ?? null,
      lead: lead ? { id: lead.id, title: lead.title, status: lead.status } : null,
      messages_read: messages.length,
      // The last stretch of the conversation, oldest first, so the model can
      // quote what was actually said. The rest is in the artifact.
      messages: messages.slice(-15).map((m) => ({
        when: fmtDateTime(m.created_at),
        who: waAuthor(m, name, teamNames),
        text: clip(m.body, 500) || `[${m.message_type}]`,
        failed: m.status === "failed" ? m.error : null,
      })),
      pending_promises: promises
        .filter((p) => p.status === "pending")
        .map((p) => ({ what: p.summary, due: fmtDateTime(p.due_at) })),
      note: "Read-only. To reply, open the inbox — Arc cannot send WhatsApp messages.",
    },
    event: { kind: "read", label: `WhatsApp — ${name}`, href: "/whatsapp" },
    artifacts,
  };
}

async function smsHistory(
  args: Record<string, unknown>,
  ctx: ToolContext,
  limit: number,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const asked = str(args.contact);
  const safe = safeLike(asked);
  const digits = asked.replace(/\D/g, "");

  const columns =
    "id, to_number, message, client_name, kind, status, error, segments, created_at, lead_id, project_id";

  let rows: {
    id: string;
    to_number: string;
    message: string;
    client_name: string;
    kind: string;
    status: string;
    error: string | null;
    segments: number;
    created_at: string;
    lead_id: string | null;
    project_id: string | null;
  }[] = [];

  // Numbers are stored normalized, so match on the last nine digits: that
  // finds 0771234567, +94771234567 and 94771234567 alike.
  if (digits.length >= 6) {
    const { data, error } = await supabase
      .from("sms_messages")
      .select(columns)
      .ilike("to_number", `%${digits.slice(-9)}%`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { content: { ok: false, error: error.message } };
    rows = data ?? [];
  }
  if (!rows.length && safe) {
    const { data, error } = await supabase
      .from("sms_messages")
      .select(columns)
      .ilike("client_name", `%${safe}%`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { content: { ok: false, error: error.message } };
    rows = data ?? [];
  }

  if (!rows.length) {
    return {
      content: {
        ok: false,
        reason: `No text messages found for "${asked}". Say so rather than describing one.`,
      },
    };
  }

  const ordered = [...rows].reverse();
  const who = ordered[ordered.length - 1].client_name || ordered[ordered.length - 1].to_number;
  const failed = ordered.filter((r) => r.status === "failed");

  return {
    content: {
      ok: true,
      channel: "sms",
      contact: who,
      to_number: ordered[ordered.length - 1].to_number,
      messages_read: ordered.length,
      failed: failed.length,
      segments: total(ordered, (r) => num(r.segments)),
      messages: ordered.slice(-15).map((r) => ({
        when: fmtDateTime(r.created_at),
        kind: r.kind,
        status: r.status,
        text: clip(r.message, 400),
        error: r.error,
      })),
      note: "SMS is an outbound send log — replies from the recipient are not captured anywhere. Arc cannot send a text; prepare_sms writes one for the user to approve.",
    },
    event: { kind: "read", label: `SMS — ${who}`, href: "/sms" },
    artifacts: [
      timelineArtifact({
        title: `${who} — text messages`,
        subtitle: `${ordered.length} sends, oldest first`,
        summary:
          "Only what we sent. Notify.lk reports 'sent' or 'failed' at the moment of sending — there is no delivered state and no inbound side.",
        href: "/sms",
        area: "sms",
        entries: ordered.map((r) => ({
          when: fmtDateTime(r.created_at) ?? r.created_at,
          label: `${r.kind} → ${r.to_number}`,
          detail: [clip(r.message, 600), r.error ? `failed: ${r.error}` : ""]
            .filter(Boolean)
            .join(" · "),
          tone: (r.status === "failed" ? "danger" : "positive") as ArtifactTone,
        })),
      }),
    ],
  };
}

async function conversationHistory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const channel = str(args.channel).toLowerCase();
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(150, Math.max(1, Math.round(limitRaw))) : 40;
  if (!str(args.contact)) {
    return { content: { ok: false, error: "Say who the conversation is with." } };
  }
  if (channel === "whatsapp") return whatsappHistory(args, ctx, limit);
  if (channel === "sms") return smsHistory(args, ctx, limit);
  return {
    content: { ok: false, error: `"${channel}" is not a channel — use 'whatsapp' or 'sms'.` },
  };
}

// ---- whatsapp_report -----------------------------------------------------

type Funnel = {
  contacts: number;
  replied: number;
  inCrm: number;
  agentWins: number;
  agentWinRate: number;
  quoted: number;
  quoteViewed: number;
  signed: number;
  declined: number;
  won: number;
  revenue: number;
  medianFirstReply: number | null;
  p90FirstReply: number | null;
};

/** Coerce the jsonb the 0074 funnel function returns. */
function toFunnel(raw: Record<string, unknown> | null): Funnel {
  const n = (k: string) => num(raw?.[k]);
  const maybe = (k: string) => {
    const v = raw?.[k];
    return v == null ? null : Number(v);
  };
  return {
    contacts: n("contacts"),
    replied: n("replied"),
    inCrm: n("in_crm"),
    agentWins: n("agent_wins"),
    agentWinRate: n("agent_win_rate"),
    quoted: n("quoted"),
    quoteViewed: n("quote_viewed"),
    signed: n("signed"),
    declined: n("declined"),
    won: n("won"),
    revenue: n("revenue"),
    medianFirstReply: maybe("median_first_reply"),
    p90FirstReply: maybe("p90_first_reply"),
  };
}

/** Top-10 frequency count over a pile of free-text tags. */
function tally(values: (string | null | undefined)[]): { topic: string; mentions: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, mentions]) => ({ topic, mentions }));
}

async function whatsappReport(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const days = clampDays(args.days, 30);
  const since = sinceIso(days);
  const nowIso = new Date().toISOString();

  const { data: campaignRows, error: campError } = await supabase
    .from("wa_campaigns")
    .select("id, name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (campError) return { content: { ok: false, error: campError.message } };

  const asked = str(args.campaign);
  let campaign: { id: string; name: string; status: string } | null = null;
  if (asked) {
    const match = (campaignRows ?? []).find((c) => contains(c.name, asked));
    if (!match) {
      return {
        content: {
          ok: false,
          reason: `No WhatsApp campaign matching "${asked}".`,
          campaigns: (campaignRows ?? []).map((c) => `${c.name} (${c.status})`),
        },
      };
    }
    campaign = match;
  }

  const funnelRes = campaign
    ? await supabase.rpc("wa_funnel_stats", { p_since: since, p_campaign: campaign.id })
    : await supabase.rpc("wa_funnel_stats", { p_since: since });
  if (funnelRes.error) {
    // The app's own copy for this case — a missing migration, not a real zero.
    return {
      content: {
        ok: false,
        error: `Analytics queries missing — run migration 0074_wa_analytics.sql (${funnelRes.error.message})`,
      },
    };
  }
  const funnel = toFunnel((funnelRes.data ?? null) as Record<string, unknown> | null);

  const [dailyRes, callRes, attentionRes, pausedRes, insightRes, coldRes, promiseRes] =
    await Promise.all([
      supabase.rpc("wa_daily_message_counts", { p_since: since }),
      supabase
        .from("wa_contacts")
        .select("id, wa_id, display_name, profile_name, call_booked_at, lead_id, agent_enabled")
        .gte("call_booked_at", since)
        .order("call_booked_at", { ascending: false })
        .limit(60),
      supabase
        .from("wa_contacts")
        .select("id, wa_id, display_name, profile_name, last_message_at, last_inbound_at, unread")
        .eq("needs_attention", true)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(40),
      supabase
        .from("wa_contacts")
        .select("id", { count: "exact", head: true })
        .eq("agent_enabled", false),
      supabase
        .from("wa_convo_insights")
        .select("outcome, stage_reached, objections, faq_gaps, quality_flags, summary, created_at")
        .eq("status", "scored")
        .gte("created_at", since)
        .limit(500),
      supabase
        .from("wa_cold_outreach")
        .select("id, wa_id, status, sent_at, replied_at, followup_sent_at, error, lead_id")
        .or(`sent_at.gte.${since},followup_sent_at.gte.${since}`)
        .limit(1000),
      supabase
        .from("wa_promises")
        .select("id, contact_id, summary, due_at, status")
        .eq("status", "pending")
        .order("due_at", { ascending: true })
        .limit(40),
    ]);

  const supportError =
    dailyRes.error ??
    callRes.error ??
    attentionRes.error ??
    pausedRes.error ??
    insightRes.error ??
    coldRes.error ??
    promiseRes.error;
  if (supportError) return { content: { ok: false, error: supportError.message } };

  const daily = (dailyRes.data ?? []) as { day: string; inbound: number; outbound: number }[];
  const calls = callRes.data ?? [];
  const attention = attentionRes.data ?? [];
  const insights = insightRes.data ?? [];
  const cold = coldRes.data ?? [];
  const promises = promiseRes.data ?? [];

  const sent30 = cold.filter(
    (c) => c.sent_at && ["sent", "delivered", "replied", "failed"].includes(c.status),
  ).length;
  const delivered30 = cold.filter((c) => ["delivered", "replied"].includes(c.status)).length;
  const replied30 = cold.filter((c) => c.status === "replied").length;
  const noWhatsapp = cold.filter((c) => c.status === "no_whatsapp").length;

  const outcomes = tally(insights.map((i) => i.outcome));
  const objections = tally(insights.flatMap((i) => i.objections));
  const faqGaps = tally(insights.flatMap((i) => i.faq_gaps));

  // Everyone who needs a person, whatever put them there — one list beats
  // three tables the user has to reconcile in their head.
  const promiseContactIds = [...new Set(promises.map((p) => p.contact_id))];
  const { data: promiseContacts, error: promiseNameError } = promiseContactIds.length
    ? await supabase
        .from("wa_contacts")
        .select("id, wa_id, display_name, profile_name")
        .in("id", promiseContactIds)
    : { data: [], error: null };
  if (promiseNameError) return { content: { ok: false, error: promiseNameError.message } };
  const promiseNames = new Map(
    (promiseContacts ?? []).map((c) => [c.id, { name: waName(c), phone: waPhone(c.wa_id) }]),
  );

  type NeedsRow = { id: string; name: string; phone: string; why: string; when: string | null };
  const needs: NeedsRow[] = [
    ...attention.map((c) => ({
      id: `att-${c.id}`,
      name: waName(c),
      phone: waPhone(c.wa_id),
      why: "flagged for a human",
      when: c.last_message_at,
    })),
    ...promises.map((p) => ({
      id: `pro-${p.id}`,
      name: promiseNames.get(p.contact_id)?.name ?? "Contact",
      phone: promiseNames.get(p.contact_id)?.phone ?? "—",
      why: `promised: ${clip(p.summary, 80)}`,
      when: p.due_at,
    })),
  ].sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""));

  const scope = campaign ? `${campaign.name} · last ${days} days` : `Last ${days} days`;
  const metrics: ArtifactField[] = [
    { label: "Conversations", value: funnel.contacts, format: "number" },
    { label: "Replied", value: funnel.replied, format: "number", tone: "info" },
    {
      label: "Calls booked",
      value: funnel.agentWins,
      format: "number",
      tone: funnel.agentWins > 0 ? "positive" : "warning",
    },
    {
      label: "Win rate",
      value: Math.round(funnel.agentWinRate),
      format: "percent",
      tone: funnel.agentWinRate >= 10 ? "positive" : "warning",
    },
    { label: "Median first reply (s)", value: funnel.medianFirstReply, format: "number" },
    { label: "In the CRM", value: funnel.inCrm, format: "number" },
    { label: "Quoted", value: funnel.quoted, format: "number" },
    { label: "Won", value: funnel.won, format: "number", tone: "positive" },
    { label: "Revenue", value: money(funnel.revenue), format: "money", tone: "positive" },
    {
      label: "AI paused on",
      value: pausedRes.count ?? 0,
      format: "number",
      tone: (pausedRes.count ?? 0) > 0 ? "warning" : "neutral",
    },
  ];

  const callColumns: ArtifactColumn[] = [
    { key: "who", label: "Contact" },
    { key: "phone", label: "Phone", format: "phone" },
    { key: "when", label: "Call time", format: "datetime" },
    { key: "state", label: "When", format: "status" },
    { key: "agent", label: "AI", format: "status", secondary: true },
  ];

  const artifacts: Artifact[] = [
    metricsArtifact({
      title: campaign ? `WhatsApp — ${campaign.name}` : "WhatsApp agent",
      subtitle: scope,
      summary:
        "A BOOKED CALL is the agent's win — its whole job is answer the questions, then set up the call. Quotes, signatures and revenue are the team's half of the funnel, after the call. First-reply time is in seconds.",
      href: "/whatsapp",
      area: "whatsapp",
      metrics,
      actions: [{ label: "Open WhatsApp", href: "/whatsapp" }],
    }),
  ];

  if (daily.length) {
    artifacts.push(
      chartArtifact({
        title: "Message volume",
        subtitle: `Inbound + outbound per day, last ${days} days`,
        href: "/whatsapp",
        area: "whatsapp",
        chart: "bar",
        format: "number",
        points: daily.map((d) => ({
          label: d.day.slice(5),
          value: num(d.inbound) + num(d.outbound),
          tone: (num(d.inbound) > 0 ? "info" : "neutral") as ArtifactTone,
        })),
      }),
    );
  }

  if (calls.length) {
    artifacts.push(
      tableArtifact({
        title: "Calls the agent booked",
        subtitle: `${calls.filter((c) => (c.call_booked_at ?? "") > nowIso).length} still upcoming`,
        summary: "Each of these is a prospect who agreed to a phone call — the agent's scoreboard.",
        href: "/whatsapp",
        area: "whatsapp",
        columns: callColumns,
        rows: rowsToTable(calls, callColumns, (c) => ({
          id: c.id,
          href: c.lead_id ? `/crm/lead/${c.lead_id}` : "/whatsapp",
          tone: ((c.call_booked_at ?? "") > nowIso ? "positive" : "neutral") as ArtifactTone,
          cells: {
            who: waName(c),
            phone: waPhone(c.wa_id),
            when: fmtDateTime(c.call_booked_at),
            state: (c.call_booked_at ?? "") > nowIso ? "upcoming" : "past",
            agent: c.agent_enabled ? "answering" : "paused",
          },
        })),
        total_label: "Booked in this window",
        total_value: calls.length,
        total_format: "number",
      }),
    );
  }

  if (objections.length || faqGaps.length) {
    const topicColumns: ArtifactColumn[] = [
      { key: "kind", label: "Kind", format: "status" },
      { key: "topic", label: "What came up" },
      { key: "mentions", label: "Conversations", format: "number", align: "right" },
    ];
    const topics = [
      ...objections.map((o) => ({ kind: "objection", ...o })),
      ...faqGaps.map((g) => ({ kind: "unanswered question", ...g })),
    ].sort((a, b) => b.mentions - a.mentions);
    artifacts.push(
      tableArtifact({
        title: "What prospects pushed back on",
        subtitle: `From ${insights.length} scored conversations`,
        summary:
          "Written by the nightly conversation scorer. An 'unanswered question' is a gap the agent could not answer — the cheapest thing to fix.",
        href: "/whatsapp",
        area: "whatsapp",
        columns: topicColumns,
        rows: rowsToTable(topics, topicColumns, (t, i) => ({
          id: String(i),
          tone: (t.kind === "objection" ? "warning" : "info") as ArtifactTone,
          cells: { kind: t.kind, topic: t.topic, mentions: t.mentions },
        })),
      }),
    );
  }

  if (needs.length) {
    const needsColumns: ArtifactColumn[] = [
      { key: "who", label: "Contact" },
      { key: "phone", label: "Phone", format: "phone" },
      { key: "why", label: "Why" },
      { key: "when", label: "Since / due", format: "datetime" },
    ];
    artifacts.push(
      tableArtifact({
        title: "Needs a person",
        subtitle: `${attention.length} flagged, ${promises.length} promised replies due`,
        summary:
          "Threads the agent handed over, plus follow-ups it promised on your behalf. Open the inbox to reply — Arc cannot send WhatsApp messages.",
        href: "/whatsapp",
        area: "whatsapp",
        columns: needsColumns,
        rows: rowsToTable(needs, needsColumns, (n) => ({
          id: n.id,
          href: "/whatsapp",
          tone: (n.why.startsWith("promised") ? "warning" : "danger") as ArtifactTone,
          cells: {
            who: n.name,
            phone: n.phone,
            why: n.why,
            when: fmtDateTime(n.when),
          },
        })),
      }),
    );
  }

  if (cold.length) {
    artifacts.push(
      metricsArtifact({
        title: "Cold WhatsApp outreach",
        subtitle: `Last ${days} days`,
        summary:
          "The agent's own first-contact runs, on top of the inbound conversations above. 'No WhatsApp' means the number is not on WhatsApp at all, which is a skip rather than a failure.",
        href: "/whatsapp",
        area: "whatsapp",
        metrics: [
          { label: "Sent", value: sent30, format: "number" },
          { label: "Delivered", value: delivered30, format: "number", tone: "info" },
          {
            label: "Replied",
            value: replied30,
            format: "number",
            tone: replied30 > 0 ? "positive" : "neutral",
          },
          {
            label: "Reply rate",
            value: sent30 > 0 ? Math.round((replied30 / sent30) * 100) : null,
            format: "percent",
          },
          { label: "No WhatsApp", value: noWhatsapp, format: "number", tone: "neutral" },
        ],
      }),
    );
  }

  return {
    content: {
      ok: true,
      scope: campaign ? campaign.name : "all conversations",
      window_days: days,
      currency: "LKR",
      headline: "A booked call is the agent's win; everything after it is the team's half.",
      funnel: {
        conversations: funnel.contacts,
        replied: funnel.replied,
        in_crm: funnel.inCrm,
        calls_booked: funnel.agentWins,
        win_rate_percent: Math.round(funnel.agentWinRate),
        quoted: funnel.quoted,
        quote_viewed: funnel.quoteViewed,
        signed: funnel.signed,
        declined: funnel.declined,
        won: funnel.won,
        revenue: money(funnel.revenue),
        median_first_reply_seconds: funnel.medianFirstReply,
        p90_first_reply_seconds: funnel.p90FirstReply,
      },
      needs_a_person: {
        flagged: attention.length,
        ai_paused: pausedRes.count ?? 0,
        promised_replies_due: promises.length,
      },
      upcoming_calls: calls
        .filter((c) => (c.call_booked_at ?? "") > nowIso)
        .slice(0, 15)
        .map((c) => ({ who: waName(c), phone: waPhone(c.wa_id), when: fmtDateTime(c.call_booked_at) })),
      cold_outreach: {
        sent: sent30,
        delivered: delivered30,
        replied: replied30,
        no_whatsapp: noWhatsapp,
        reply_rate_percent: sent30 > 0 ? Math.round((replied30 / sent30) * 100) : null,
      },
      conversation_outcomes: outcomes,
      top_objections: objections,
      top_unanswered_questions: faqGaps,
      campaigns: (campaignRows ?? []).map((c) => ({ name: c.name, status: c.status })),
      note: "Read-only — Arc cannot send WhatsApp messages, and the Campaign, Cold and Agent tabs of /whatsapp are admin-only in the UI.",
    },
    event: {
      kind: "read",
      label: campaign ? `WhatsApp — ${campaign.name}` : "WhatsApp agent",
      href: "/whatsapp",
    },
    artifacts,
  };
}

// ---- growth_query datasets ----------------------------------------------

function triggerLabel(t: string): string {
  return TRIGGER_META[t as AutomationTrigger]?.label ?? t;
}

function stepLabel(k: string): string {
  return STEP_META[k as AutomationStepKind]?.label ?? k;
}

async function datasetAutomations(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [autoRes, stepRes] = await Promise.all([
    supabase
      .from("automations")
      .select("id, name, description, is_active, trigger, runs_started, last_run_at, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("automation_steps").select("automation_id, kind, position").limit(1000),
  ]);
  if (autoRes.error) return autoRes.error.message;
  if (stepRes.error) return stepRes.error.message;

  const steps = new Map<string, string[]>();
  for (const s of [...(stepRes.data ?? [])].sort((a, b) => a.position - b.position)) {
    const list = steps.get(s.automation_id) ?? [];
    list.push(stepLabel(s.kind));
    steps.set(s.automation_id, list);
  }

  let rows = autoRes.data ?? [];
  if (f.query) rows = rows.filter((a) => contains(a.name, f.query) || contains(a.description, f.query));
  if (f.status === "active") rows = rows.filter((a) => a.is_active);
  else if (f.status === "inactive") rows = rows.filter((a) => !a.is_active);
  rows = [...rows].sort(
    (a, b) =>
      Number(b.is_active) - Number(a.is_active) ||
      (b.last_run_at ?? "").localeCompare(a.last_run_at ?? ""),
  );

  const columns: ArtifactColumn[] = [
    { key: "name", label: "Automation" },
    { key: "trigger", label: "Fires when", format: "status" },
    { key: "steps", label: "Then", secondary: true },
    { key: "active", label: "Active", format: "status" },
    { key: "runs", label: "Runs started", format: "number", align: "right" },
    { key: "last", label: "Last run", format: "datetime" },
  ];

  return {
    title: "Automations",
    subtitle: f.status ? `Filtered: ${f.status}` : "Active first",
    summary:
      "'Runs started' is a counter the automation keeps for itself, so it survives runs being cleaned up. An active rule with no last-run date has simply never been triggered.",
    href: "/automation",
    area: "automation",
    columns,
    rows: rowsToTable(rows, columns, (a) => ({
      id: a.id,
      href: "/automation",
      tone: (!a.is_active ? "neutral" : a.last_run_at ? "positive" : "warning") as ArtifactTone,
      cells: {
        name: a.name,
        trigger: triggerLabel(a.trigger),
        steps: (steps.get(a.id) ?? []).join(" → ") || "no steps",
        active: a.is_active ? "on" : "off",
        runs: a.runs_started,
        last: a.last_run_at ? fmtDateTime(a.last_run_at) : "never",
      },
    })),
    total_label: "Active rules",
    total_value: rows.filter((a) => a.is_active).length,
    total_format: "number",
  };
}

async function datasetAutomationRuns(supabase: DB, f: Filters): Promise<Dataset | string> {
  const since = f.since ?? sinceIso(f.days ?? 14);
  let q = supabase
    .from("automation_runs")
    .select("id, automation_id, subject_name, subject_phone, subject_email, status, step_index, error, created_at, completed_at, lead_id, project_id, client_id")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  const autoIds = [...new Set(rows.map((r) => r.automation_id))];
  const { data: autos, error: autoError } = autoIds.length
    ? await supabase.from("automations").select("id, name, trigger").in("id", autoIds)
    : { data: [], error: null };
  if (autoError) return autoError.message;
  const names = new Map((autos ?? []).map((a) => [a.id, a]));

  if (["running", "completed", "failed", "cancelled"].includes(f.status)) {
    rows = rows.filter((r) => r.status === f.status);
  }
  if (f.query) {
    rows = rows.filter(
      (r) => contains(r.subject_name, f.query) || contains(names.get(r.automation_id)?.name, f.query),
    );
  }

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "automation", label: "Automation" },
    { key: "subject", label: "About" },
    { key: "step", label: "Step", format: "number", align: "right", secondary: true },
    { key: "status", label: "Status", format: "status" },
    { key: "error", label: "Error" },
  ];

  const failed = rows.filter((r) => r.status === "failed");
  return {
    title: "Automation runs",
    subtitle: f.status === "failed" ? "Failures only" : windowLabel(f, `Last ${f.days ?? 14} days`),
    summary:
      "One row per firing. A 'running' row is mid-sequence, usually waiting on a Wait step — it is not stuck. The step number is how far through the sequence it got.",
    href: "/automation",
    area: "automation",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: r.lead_id
        ? `/crm/lead/${r.lead_id}`
        : r.project_id
          ? `/projects/${r.project_id}`
          : "/automation",
      tone: (r.status === "failed"
        ? "danger"
        : r.status === "completed"
          ? "positive"
          : r.status === "cancelled"
            ? "neutral"
            : "info") as ArtifactTone,
      cells: {
        when: fmtDateTime(r.created_at),
        automation: names.get(r.automation_id)?.name ?? "—",
        subject: r.subject_name || "—",
        step: r.step_index,
        status: r.status,
        error: clip(r.error, 140) || "—",
      },
    })),
    total_label: "Failed in this window",
    total_value: failed.length,
    total_format: "number",
    facts: {
      failed: failed.length,
      running: rows.filter((r) => r.status === "running").length,
      completed: rows.filter((r) => r.status === "completed").length,
    },
    empty_reason: "No automation ran in that window at all — not that none failed.",
  };
}

const SMS_KINDS = [
  "custom",
  "payment_reminder",
  "automation",
  "promotion",
  "todo_reminder",
  "meeting_reminder",
  "prospecting",
  "team_alert",
];

async function datasetSms(supabase: DB, f: Filters): Promise<Dataset | string> {
  const since = f.since ?? sinceIso(f.days ?? 14);
  let q = supabase
    .from("sms_messages")
    .select("id, to_number, message, client_name, kind, status, error, segments, created_at, lead_id, project_id")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.status === "sent" || f.status === "failed") rows = rows.filter((r) => r.status === f.status);
  else if (SMS_KINDS.includes(f.status)) rows = rows.filter((r) => r.kind === f.status);
  if (f.query) {
    rows = rows.filter(
      (r) =>
        contains(r.client_name, f.query) ||
        contains(r.to_number, f.query) ||
        contains(r.message, f.query),
    );
  }

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "to", label: "To", format: "phone" },
    { key: "who", label: "Client", secondary: true },
    { key: "kind", label: "Kind", format: "status" },
    { key: "status", label: "Status", format: "status" },
    { key: "segments", label: "Segments", format: "number", align: "right", secondary: true },
    { key: "message", label: "Message" },
  ];

  return {
    title: "Text messages sent",
    subtitle: windowLabel(f, `Last ${f.days ?? 14} days`),
    summary:
      "A log of send attempts, written after Notify.lk answers — there is no 'pending' or 'delivered' state. Segments are the billable unit: 160 characters each, or 70 when the text contains Sinhala, Tamil or an emoji.",
    href: "/sms",
    area: "sms",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: r.lead_id ? `/crm/lead/${r.lead_id}` : r.project_id ? `/projects/${r.project_id}` : "/sms",
      tone: (r.status === "failed" ? "danger" : "positive") as ArtifactTone,
      cells: {
        when: fmtDateTime(r.created_at),
        to: r.to_number,
        who: r.client_name || "—",
        kind: r.kind,
        status: r.status === "failed" ? `failed: ${clip(r.error, 50)}` : r.status,
        segments: r.segments,
        message: clip(r.message, 120),
      },
    })),
    total_label: "Segments (billable units)",
    total_value: total(rows, (r) => num(r.segments)),
    total_format: "number",
    facts: {
      sent: rows.filter((r) => r.status === "sent").length,
      failed: rows.filter((r) => r.status === "failed").length,
    },
    empty_reason: "No text messages were sent in that window.",
  };
}

async function datasetSmsWorkflows(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [flowRes, stepRes, runRes] = await Promise.all([
    supabase
      .from("sms_workflows")
      .select("id, name, is_active, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("sms_workflow_steps").select("workflow_id, kind, wait_minutes").limit(500),
    supabase.from("sms_workflow_runs").select("workflow_id, status, client_name, next_run_at").limit(1000),
  ]);
  if (flowRes.error) return flowRes.error.message;
  if (stepRes.error) return stepRes.error.message;
  if (runRes.error) return runRes.error.message;

  const stepCount = new Map<string, number>();
  for (const s of stepRes.data ?? []) {
    stepCount.set(s.workflow_id, (stepCount.get(s.workflow_id) ?? 0) + 1);
  }
  const runs = new Map<string, { running: number; completed: number; failed: number; cancelled: number }>();
  for (const r of runRes.data ?? []) {
    const e = runs.get(r.workflow_id) ?? { running: 0, completed: 0, failed: 0, cancelled: 0 };
    if (r.status === "running") e.running += 1;
    else if (r.status === "completed") e.completed += 1;
    else if (r.status === "failed") e.failed += 1;
    else e.cancelled += 1;
    runs.set(r.workflow_id, e);
  }

  let rows = (flowRes.data ?? []).map((w) => ({
    ...w,
    steps: stepCount.get(w.id) ?? 0,
    ...(runs.get(w.id) ?? { running: 0, completed: 0, failed: 0, cancelled: 0 }),
  }));
  if (f.query) rows = rows.filter((w) => contains(w.name, f.query));
  if (f.status === "active") rows = rows.filter((w) => w.is_active);
  else if (f.status === "inactive") rows = rows.filter((w) => !w.is_active);

  const columns: ArtifactColumn[] = [
    { key: "name", label: "Sequence" },
    { key: "steps", label: "Steps", format: "number", align: "right" },
    { key: "active", label: "Active", format: "status" },
    { key: "running", label: "In flight", format: "number", align: "right" },
    { key: "completed", label: "Finished", format: "number", align: "right", secondary: true },
    { key: "failed", label: "Failed", format: "number", align: "right", secondary: true },
  ];

  return {
    title: "SMS sequences",
    subtitle: f.status ? `Filtered: ${f.status}` : "Newest first",
    summary:
      "Multi-step text sequences. 'In flight' is someone part-way through one, waiting for the next step's timer.",
    href: "/sms",
    area: "sms",
    columns,
    rows: rowsToTable(rows, columns, (w) => ({
      id: w.id,
      href: "/sms",
      tone: (!w.is_active ? "neutral" : w.failed > 0 ? "warning" : "positive") as ArtifactTone,
      cells: {
        name: w.name,
        steps: w.steps,
        active: w.is_active ? "on" : "off",
        running: w.running,
        completed: w.completed,
        failed: w.failed,
      },
    })),
    total_label: "People mid-sequence",
    total_value: total(rows, (w) => w.running),
    total_format: "number",
  };
}

async function datasetChurnAlerts(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("churn_alerts")
    .select("id, client_id, client_name, severity, reason, draft_message, status, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (f.since) q = q.gte("created_at", f.since);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (["open", "actioned", "dismissed"].includes(f.status)) {
    rows = rows.filter((r) => r.status === f.status);
  } else {
    rows = rows.filter((r) => r.status === "open");
  }
  if (f.query) rows = rows.filter((r) => contains(r.client_name, f.query));

  const columns: ArtifactColumn[] = [
    { key: "client", label: "Client" },
    { key: "severity", label: "How cold", format: "status" },
    { key: "reason", label: "Why" },
    { key: "status", label: "Status", format: "status" },
    { key: "when", label: "Flagged", format: "datetime" },
  ];

  return {
    title: "Clients going quiet",
    subtitle: f.status ? `Filtered: ${f.status}` : "Open alerts",
    summary:
      "Raised when an active client has had no payment, no new project and no text message for 60 days. 'cold' means 120+ days or never.",
    href: "/intelligence",
    area: "intelligence",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: r.client_id ? "/clients" : "/intelligence",
      tone: (r.severity === "cold" ? "danger" : r.severity === "warm" ? "warning" : "info") as ArtifactTone,
      cells: {
        client: r.client_name,
        severity: r.severity,
        reason: r.reason,
        status: r.status,
        when: fmtDateTime(r.created_at),
      },
    })),
    total_label: "Open alerts",
    total_value: rows.filter((r) => r.status === "open").length,
    total_format: "number",
    footnote:
      "A win-back message is already drafted for each alert. Arc will not send it — ask for it with prepare_sms and press Send yourself. /intelligence is an admin-only page.",
    facts: {
      win_back_drafts: rows
        .filter((r) => r.draft_message)
        .slice(0, 5)
        .map((r) => ({ client: r.client_name, draft: clip(r.draft_message, 240) })),
    },
    empty_reason: "No clients are flagged as going quiet.",
  };
}

async function datasetContent(supabase: DB, f: Filters): Promise<Dataset | string> {
  let q = supabase
    .from("content_generations")
    .select("id, prompt, image_url, aspect_ratio, image_size, model, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (f.since) q = q.gte("created_at", f.since);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  let rows = data ?? [];
  if (f.query) rows = rows.filter((r) => contains(r.prompt, f.query));

  const columns: ArtifactColumn[] = [
    { key: "when", label: "When", format: "datetime" },
    { key: "prompt", label: "Prompt" },
    { key: "ratio", label: "Ratio", secondary: true },
    { key: "size", label: "Size", secondary: true },
    { key: "model", label: "Model", secondary: true },
  ];

  return {
    title: "Generated images",
    subtitle: windowLabel(f, "Newest first"),
    summary: "Everything made in Content Studio. The images themselves live on the /content page.",
    href: "/content",
    area: "content",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: "/content",
      cells: {
        when: fmtDateTime(r.created_at),
        prompt: clip(r.prompt, 140),
        ratio: r.aspect_ratio,
        size: r.image_size,
        model: r.model,
      },
    })),
  };
}

async function datasetCarousels(supabase: DB, f: Filters): Promise<Dataset | string> {
  const { data, error } = await supabase
    .from("carousel_posts")
    .select("id, topic, notes, scheduled_for, status, caption, hashtags, chosen_option_id, error, created_at")
    .order("scheduled_for", { ascending: true })
    .limit(300);
  if (error) return error.message;

  let rows = data ?? [];
  // Scheduled content lives in the FUTURE, so `days` reads forward here —
  // "what's going out this week" is the question people actually ask.
  if (f.on) rows = rows.filter((r) => r.scheduled_for === f.on);
  else if (f.days) {
    const until = new Date(Date.now() + f.days * DAY_MS).toISOString().slice(0, 10);
    rows = rows.filter((r) => r.scheduled_for >= f.today && r.scheduled_for <= until);
  } else {
    rows = rows.filter((r) => r.scheduled_for >= f.today);
  }
  if (f.query) rows = rows.filter((r) => contains(r.topic, f.query) || contains(r.caption, f.query));
  if (["planned", "copywriting", "rendering", "ready", "approved", "error"].includes(f.status)) {
    rows = rows.filter((r) => r.status === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "date", label: "Going out", format: "date" },
    { key: "topic", label: "Topic" },
    { key: "status", label: "Status", format: "status" },
    { key: "caption", label: "Caption" },
    { key: "tags", label: "Hashtags", secondary: true },
  ];

  return {
    title: "Scheduled carousels",
    subtitle: f.days ? `Next ${f.days} days` : f.on ? (fmtDateTime(f.on) ?? f.on) : "Upcoming",
    summary:
      "Two design options are generated per topic a few days ahead; 'approved' means one was picked. Past posts are excluded unless you ask for a specific date.",
    href: "/content",
    area: "content",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      href: "/content",
      tone: (r.status === "error"
        ? "danger"
        : r.status === "approved"
          ? "positive"
          : r.status === "ready"
            ? "info"
            : "warning") as ArtifactTone,
      cells: {
        date: r.scheduled_for,
        topic: r.topic,
        status: r.status === "error" ? `error: ${clip(r.error, 50)}` : r.status,
        caption: clip(r.caption, 120) || "not written yet",
        tags: r.hashtags.slice(0, 5).join(" ") || "—",
      },
    })),
    total_label: "Posts scheduled",
    total_value: rows.length,
    total_format: "number",
    empty_reason: "Nothing is scheduled for that window.",
  };
}

async function datasetCompetitors(supabase: DB, f: Filters): Promise<Dataset | string> {
  const [compRes, entryRes] = await Promise.all([
    supabase
      .from("competitors")
      .select("id, name, website, facebook, instagram, ai_summary, ai_summary_at, created_at")
      .order("name")
      .limit(200),
    supabase
      .from("competitor_entries")
      .select("competitor_id, kind, content, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (compRes.error) return compRes.error.message;
  if (entryRes.error) return entryRes.error.message;

  const entries = new Map<string, { count: number; latest: string; latestKind: string }>();
  for (const e of entryRes.data ?? []) {
    const cur = entries.get(e.competitor_id);
    if (cur) cur.count += 1;
    else entries.set(e.competitor_id, { count: 1, latest: e.content, latestKind: e.kind });
  }

  let rows = (compRes.data ?? []).map((c) => ({
    ...c,
    ...(entries.get(c.id) ?? { count: 0, latest: "", latestKind: "" }),
  }));
  if (f.query) rows = rows.filter((c) => contains(c.name, f.query));
  rows = rows.sort((a, b) => b.count - a.count);

  const columns: ArtifactColumn[] = [
    { key: "name", label: "Competitor" },
    { key: "website", label: "Website", format: "url", secondary: true },
    { key: "entries", label: "Notes logged", format: "number", align: "right" },
    { key: "latest", label: "Latest note" },
    { key: "summarised", label: "AI summary", format: "datetime", secondary: true },
  ];

  return {
    title: "Competitor watch",
    subtitle: f.query ? `Matching "${f.query}"` : "Most-watched first",
    summary: "Prices, posts, ads and news logged against each rival, plus the last AI summary.",
    href: "/intelligence",
    area: "intelligence",
    columns,
    rows: rowsToTable(rows, columns, (c) => ({
      id: c.id,
      href: "/intelligence",
      tone: (c.count > 0 ? "info" : "neutral") as ArtifactTone,
      cells: {
        name: c.name,
        website: c.website ?? "—",
        entries: c.count,
        latest: c.latestKind ? `${c.latestKind}: ${clip(c.latest, 100)}` : "nothing logged",
        summarised: c.ai_summary_at ? fmtDateTime(c.ai_summary_at) : "never",
      },
    })),
    footnote: "/intelligence is an admin-only page.",
  };
}

async function datasetAds(supabase: DB, f: Filters): Promise<Dataset | string> {
  const since = f.since ?? sinceIso(f.days ?? 90);
  let q = supabase
    .from("ad_entries")
    .select("id, platform, campaign, period_start, period_end, spend, currency, impressions, clicks, leads, revenue, notes")
    .gte("period_end", since.slice(0, 10))
    .order("period_start", { ascending: false })
    .limit(300);
  if (f.until) q = q.lte("period_start", f.until.slice(0, 10));
  const { data, error } = await q;
  if (error) return error.message;

  let rows = (data ?? []).map((a) => ({
    ...a,
    // ROAS is undefined, not zero, when nothing was spent — a campaign with
    // no spend and some revenue is not infinitely efficient.
    roas: num(a.spend) > 0 ? Math.round((num(a.revenue) / num(a.spend)) * 100) / 100 : null,
    cpl: num(a.leads) > 0 ? Math.round(num(a.spend) / num(a.leads)) : null,
  }));
  if (f.query) rows = rows.filter((a) => contains(a.campaign, f.query));
  if (["meta", "google", "tiktok", "other"].includes(f.status)) {
    rows = rows.filter((a) => a.platform === f.status);
  }

  const columns: ArtifactColumn[] = [
    { key: "platform", label: "Platform", format: "status" },
    { key: "campaign", label: "Campaign" },
    { key: "period", label: "Period" },
    { key: "spend", label: "Spend", format: "money", align: "right" },
    { key: "leads", label: "Leads", format: "number", align: "right" },
    { key: "cpl", label: "Cost per lead", format: "money", align: "right" },
    { key: "revenue", label: "Revenue", format: "money", align: "right" },
    { key: "roas", label: "ROAS", format: "number", align: "right" },
  ];

  return {
    title: "Ad spend",
    subtitle: windowLabel(f, "Newest period first"),
    summary:
      "ROAS is revenue ÷ spend and is left blank when nothing was spent. Both figures are typed in by hand on the Intelligence page — nothing pulls them from Meta or Google automatically.",
    href: "/intelligence",
    area: "intelligence",
    columns,
    rows: rowsToTable(rows, columns, (a) => ({
      id: a.id,
      href: "/intelligence",
      tone: (a.roas === null ? "neutral" : a.roas >= 2 ? "positive" : a.roas >= 1 ? "warning" : "danger") as ArtifactTone,
      cells: {
        platform: a.platform,
        campaign: a.campaign,
        period: `${a.period_start} → ${a.period_end}`,
        spend: money(num(a.spend)),
        leads: a.leads,
        cpl: a.cpl,
        revenue: money(num(a.revenue)),
        roas: a.roas,
      },
    })),
    total_label: "Total spend",
    total_value: money(total(rows, (a) => num(a.spend))),
    total_format: "money",
    facts: {
      currency: "LKR",
      total_revenue: money(total(rows, (a) => num(a.revenue))),
      blended_roas:
        total(rows, (a) => num(a.spend)) > 0
          ? Math.round((total(rows, (a) => num(a.revenue)) / total(rows, (a) => num(a.spend))) * 100) / 100
          : null,
    },
    footnote: "/intelligence is an admin-only page.",
  };
}

async function datasetVisitors(supabase: DB, f: Filters): Promise<Dataset | string> {
  const since = f.since ?? sinceIso(f.days ?? 30);
  let q = supabase
    .from("visitor_events")
    .select("id, site, session_id, kind, path, referrer, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (f.until) q = q.lt("created_at", f.until);
  const { data, error } = await q;
  if (error) return error.message;

  const events = (data ?? []).filter((e) => (f.query ? contains(e.path, f.query) : true));
  if (!events.length) {
    return {
      title: "Website visitors",
      subtitle: windowLabel(f, `Last ${f.days ?? 30} days`),
      summary: "Nothing has been tracked for that window.",
      href: "/intelligence",
      area: "intelligence",
      columns: [{ key: "path", label: "Page" }],
      rows: [],
      empty_reason:
        "There is no tracking data at all for that window — which usually means the tracking snippet is not installed on the site, not that nobody visited.",
    };
  }

  const byPath = new Map<
    string,
    { sessions: Set<string>; pageviews: number; starts: number; submits: number; abandons: number }
  >();
  for (const e of events) {
    const entry =
      byPath.get(e.path) ??
      { sessions: new Set<string>(), pageviews: 0, starts: 0, submits: 0, abandons: 0 };
    entry.sessions.add(e.session_id);
    if (e.kind === "pageview") entry.pageviews += 1;
    if (e.kind === "form_start") entry.starts += 1;
    if (e.kind === "form_submit") entry.submits += 1;
    if (e.kind === "form_abandon") entry.abandons += 1;
    byPath.set(e.path, entry);
  }

  const rows = [...byPath.entries()]
    .map(([path, v]) => ({
      path,
      sessions: v.sessions.size,
      pageviews: v.pageviews,
      starts: v.starts,
      submits: v.submits,
      abandons: v.abandons,
    }))
    .sort((a, b) => b.pageviews - a.pageviews || b.sessions - a.sessions);

  const columns: ArtifactColumn[] = [
    { key: "path", label: "Page" },
    { key: "sessions", label: "Sessions", format: "number", align: "right" },
    { key: "pageviews", label: "Pageviews", format: "number", align: "right" },
    { key: "starts", label: "Form starts", format: "number", align: "right", secondary: true },
    { key: "submits", label: "Form submits", format: "number", align: "right" },
    { key: "abandons", label: "Abandoned", format: "number", align: "right", secondary: true },
  ];

  const sessions = new Set(events.map((e) => e.session_id)).size;
  const submits = events.filter((e) => e.kind === "form_submit").length;
  const starts = events.filter((e) => e.kind === "form_start").length;

  return {
    title: "Website visitors",
    subtitle: windowLabel(f, `Last ${f.days ?? 30} days`),
    summary: `${sessions} sessions across ${rows.length} pages. A session is a distinct visitor session id, so one person browsing five pages counts once.`,
    href: "/intelligence",
    area: "intelligence",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.path,
      href: "/intelligence",
      tone: (r.submits > 0 ? "positive" : r.abandons > 0 ? "warning" : "neutral") as ArtifactTone,
      cells: {
        path: r.path,
        sessions: r.sessions,
        pageviews: r.pageviews,
        starts: r.starts,
        submits: r.submits,
        abandons: r.abandons,
      },
    })),
    total_label: "Sessions",
    total_value: sessions,
    total_format: "number",
    footnote:
      events.length >= 1000
        ? "The event read is capped at 1000 rows, so a busy site is under-counted here — the same cap the Intelligence page uses. /intelligence is admin-only."
        : "/intelligence is an admin-only page.",
    facts: {
      sessions,
      pageviews: events.filter((e) => e.kind === "pageview").length,
      form_starts: starts,
      form_submits: submits,
      form_completion_percent: starts > 0 ? Math.round((submits / starts) * 100) : null,
      capped: events.length >= 1000,
    },
  };
}

/**
 * The weekly digest is prose, not rows, so it gets its own answer: the latest
 * one in full as text plus the earlier weeks as a table to pick from.
 */
async function digestsResult(supabase: DB, f: Filters): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("ai_digests")
    .select("id, week_start, content, stats, created_at")
    .order("week_start", { ascending: false })
    .limit(20);
  if (error) return { content: { ok: false, error: error.message } };

  const rows = data ?? [];
  if (!rows.length) {
    return {
      content: {
        ok: false,
        reason:
          "No weekly digest has been generated yet. One can be produced from the AI & Intelligence page.",
      },
    };
  }

  // A named week wins over "the latest" — "what did last week's say" is a
  // different question from "what does the digest say".
  const wanted = f.on ?? (f.query.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
  const latest = (wanted && rows.find((r) => r.week_start === wanted)) || rows[0];
  const stats = latest.stats as Record<string, unknown>;

  const columns: ArtifactColumn[] = [
    { key: "week", label: "Week beginning", format: "date" },
    { key: "leads", label: "New leads", format: "number", align: "right" },
    { key: "cold", label: "Going cold", format: "number", align: "right" },
    { key: "open", label: "Open deals", format: "money", align: "right" },
    { key: "won", label: "Won", format: "money", align: "right" },
    { key: "revenue", label: "Revenue (month)", format: "money", align: "right" },
  ];

  return {
    content: {
      ok: true,
      dataset: "digests",
      week_start: latest.week_start,
      digest: latest.content,
      stats: {
        new_leads: num(stats.new_leads),
        going_cold: num(stats.going_cold),
        open_deal_value: money(num(stats.open_deal_value)),
        won_this_week: num(stats.won_this_week),
        won_value: money(num(stats.won_value)),
        unpaid_invoices: num(stats.unpaid_invoices),
        unpaid_value: money(num(stats.unpaid_value)),
        quotes_awaiting: num(stats.quotes_awaiting),
        revenue_month: money(num(stats.revenue_month)),
        expenses_month: money(num(stats.expenses_month)),
        overdue_tasks: num(stats.overdue_tasks),
        best_ad: stats.best_ad ?? null,
      },
      earlier_weeks: rows.slice(1, 12).map((r) => r.week_start),
      note: "The digest's 'going cold' uses a flat 7 days, unlike the CRM board, which uses each pipeline's own setting.",
    },
    event: { kind: "read", label: `Digest — week of ${latest.week_start}`, href: "/intelligence" },
    artifacts: [
      textArtifact({
        title: `Weekly digest — week of ${latest.week_start}`,
        subtitle: `Generated ${fmtDateTime(latest.created_at)}`,
        summary:
          "The AI's own written summary of the business for that week, as stored. /intelligence is an admin-only page.",
        href: "/intelligence",
        area: "intelligence",
        body: latest.content,
        actions: [{ label: "Open AI & Intelligence", href: "/intelligence" }],
      }),
      tableArtifact({
        title: "Digest weeks",
        subtitle: `${rows.length} stored`,
        href: "/intelligence",
        area: "intelligence",
        columns,
        rows: rowsToTable(rows, columns, (r) => {
          const s = r.stats as Record<string, unknown>;
          return {
            id: r.id,
            tone: (r.week_start === latest.week_start ? "info" : "neutral") as ArtifactTone,
            cells: {
              week: r.week_start,
              leads: num(s.new_leads),
              cold: num(s.going_cold),
              open: money(num(s.open_deal_value)),
              won: money(num(s.won_value)),
              revenue: money(num(s.revenue_month)),
            },
          };
        }),
      }),
    ],
  };
}

async function growthQuery(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = str(args.dataset).toLowerCase();
  const f = readFilters(args, ctx);
  const supabase = ctx.supabase;

  if (dataset === "digests") return digestsResult(supabase, f);

  let built: Dataset | string;
  switch (dataset) {
    case "automations": built = await datasetAutomations(supabase, f); break;
    case "automation_runs": built = await datasetAutomationRuns(supabase, f); break;
    case "sms": built = await datasetSms(supabase, f); break;
    case "sms_workflows": built = await datasetSmsWorkflows(supabase, f); break;
    case "churn_alerts": built = await datasetChurnAlerts(supabase, f); break;
    case "content": built = await datasetContent(supabase, f); break;
    case "carousels": built = await datasetCarousels(supabase, f); break;
    case "competitors": built = await datasetCompetitors(supabase, f); break;
    case "ads": built = await datasetAds(supabase, f); break;
    case "visitors": built = await datasetVisitors(supabase, f); break;
    default:
      return { content: { ok: false, error: `"${dataset}" is not a growth dataset.` } };
  }
  if (typeof built === "string") return { content: { ok: false, error: built } };
  return datasetResult(dataset, built, f);
}

// ---- team_report ---------------------------------------------------------

/** Friendly names for the tables the member change trail records. */
const TABLE_LABELS: Record<string, string> = {
  leads: "CRM leads",
  lead_activities: "CRM activity",
  lead_outreach: "Cold email",
  clients: "Clients",
  companies: "Companies",
  todos: "To-dos",
  todo_subtasks: "To-do subtasks",
  crm_tasks: "CRM tasks",
  projects: "Projects",
  meetings: "Meetings",
  invoices: "Invoices",
  quotes: "Quotes",
  notices: "Notices",
  proposals: "Proposals",
  payments: "Payments",
  expenses: "Expenses",
  cheques: "Cheques",
  wa_messages: "WhatsApp messages",
  wa_contacts: "WhatsApp contacts",
  sms_messages: "Text messages",
  carousel_posts: "Carousels",
  content_generations: "Content Studio",
};

function tableLabel(name: string): string {
  return TABLE_LABELS[name] ?? name.replace(/_/g, " ");
}

async function teamReport(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const supabase = ctx.supabase;
  const days = clampDays(args.days, 30, 90);
  const since = sinceIso(days);

  const { data: caller, error: callerError } = await supabase
    .from("profiles")
    .select("id, full_name, username, role")
    .eq("id", ctx.userId)
    .maybeSingle();
  if (callerError) return { content: { ok: false, error: callerError.message } };
  const isAdmin = caller?.role === "admin";

  const member = await resolveMember(supabase, ctx.userId, args.member);
  if (!member) {
    return { content: { ok: false, reason: `No team member matching "${str(args.member)}".` } };
  }
  const isSelf = member.id === ctx.userId;
  const canSeePrivate = isSelf || isAdmin;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, username, email, role, title, phone")
    .eq("id", member.id)
    .maybeSingle();
  if (profileError) return { content: { ok: false, error: profileError.message } };
  if (!profile) return { content: { ok: false, reason: `No profile for "${member.name}".` } };
  const name = profile.full_name || profile.username;

  // Workload is world-readable, so it is always safe to show.
  const nowIso = new Date().toISOString();
  const [leadRes, taskRes, todoRes] = await Promise.all([
    supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("assigned_to", member.id)
      .eq("status", "open")
      .is("deleted_at", null)
      .order("last_activity_at", { ascending: false })
      .limit(200),
    supabase
      .from("crm_tasks")
      .select("id, lead_id, title, due_at, status")
      .eq("assigned_to", member.id)
      .eq("status", "open")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(200),
    supabase
      .from("todos")
      .select("id, title, status, priority, due_date, project_id")
      .eq("assigned_to", member.id)
      .neq("status", "done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200),
  ]);
  const workError = leadRes.error ?? taskRes.error ?? todoRes.error;
  if (workError) return { content: { ok: false, error: workError.message } };

  const leads = (leadRes.data ?? []) as LeadRow[];
  const tasks = taskRes.data ?? [];
  const todos = todoRes.data ?? [];
  const overdueTasks = tasks.filter((t) => t.due_at && t.due_at < nowIso).length;
  const overdueTodos = todos.filter((t) => t.due_date && t.due_date < nowIso).length;
  const openValue = total(leads, (l) => num(l.value));

  const href = isAdmin && !isSelf ? `/team/${member.id}` : "/profile";
  const fields: ArtifactField[] = [
    { label: "Role", value: profile.role, format: "status" },
    { label: "Title", value: profile.title ?? "—" },
    { label: "Email", value: profile.email, format: "email" },
    { label: "Phone", value: profile.phone ?? "—", format: "phone" },
  ];
  const groups: { label: string; fields: ArtifactField[] }[] = [
    {
      label: "On their plate",
      fields: [
        { label: "Open deals", value: leads.length, format: "number" },
        { label: "Deal value", value: money(openValue), format: "money", tone: "info" },
        {
          label: "Hot deals",
          value: leads.filter((l) => l.score === "hot").length,
          format: "number",
          tone: "positive",
        },
        { label: "Open CRM tasks", value: tasks.length, format: "number" },
        {
          label: "Overdue CRM tasks",
          value: overdueTasks,
          format: "number",
          tone: overdueTasks ? "danger" : "positive",
        },
        { label: "Open to-dos", value: todos.length, format: "number" },
        {
          label: "Overdue to-dos",
          value: overdueTodos,
          format: "number",
          tone: overdueTodos ? "danger" : "positive",
        },
      ],
    },
  ];

  let moneySummary: Record<string, unknown> | null = null;
  let activitySummary: Record<string, unknown> | null = null;
  const artifacts: Artifact[] = [];

  if (canSeePrivate) {
    const [commissionRes, loanRes, sessionRes, changeRes] = await Promise.all([
      supabase
        .from("commissions")
        .select("id, project_id, amount, percentage, basis, status, note, created_at")
        .eq("user_id", member.id)
        .limit(500),
      supabase
        .from("member_loans")
        .select("id, user_id, amount, currency, reason, issued_on, due_on, status, note, issued_by, created_at, updated_at, approval, approved_at, approved_by, approval_notified_at")
        .eq("user_id", member.id)
        .order("issued_on", { ascending: false })
        .limit(200),
      supabase
        .from("login_sessions")
        .select("id, logged_in_at, last_active_at, device_label, city, country")
        .eq("user_id", member.id)
        .gte("logged_in_at", since)
        .order("logged_in_at", { ascending: false })
        .limit(300),
      supabase
        .from("member_changes")
        .select("id, table_name, op, label, changed_fields, created_at")
        .eq("user_id", member.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);
    const privateError =
      commissionRes.error ?? loanRes.error ?? sessionRes.error ?? changeRes.error;
    if (privateError) return { content: { ok: false, error: privateError.message } };

    const loanIds = (loanRes.data ?? []).map((l) => l.id);
    const repayRes = loanIds.length
      ? await supabase
          .from("member_loan_repayments")
          .select("id, loan_id, user_id, amount, paid_on, method, note, recorded_by, created_at")
          .in("loan_id", loanIds)
          .order("paid_on", { ascending: false })
      : { data: [], error: null };
    if (repayRes.error) return { content: { ok: false, error: repayRes.error.message } };

    const loans = attachRepayments(
      (loanRes.data ?? []) as Parameters<typeof attachRepayments>[0],
      (repayRes.data ?? []) as Parameters<typeof attachRepayments>[1],
    );
    // The one rollup every money screen uses, so this can never disagree with
    // /profile, /team/[id] or the member_money tool.
    const summary = summariseMemberMoney(commissionRes.data ?? [], loans);
    const awaitingApproval = (commissionRes.data ?? [])
      .filter((c) => c.status === "pending")
      .reduce((s, c) => s + num(c.amount), 0);

    groups.push({
      label: "Money",
      fields: [
        { label: "Commission earned", value: money(summary.commissionEarned), format: "money" },
        {
          label: "Commission owed",
          value: money(summary.commissionOwed),
          format: "money",
          tone: "info",
        },
        {
          label: "Of which not yet approved",
          value: money(awaitingApproval),
          format: "money",
          tone: awaitingApproval > 0 ? "warning" : "neutral",
        },
        {
          label: "Loan outstanding",
          value: money(summary.loansOutstanding),
          format: "money",
          tone: summary.loansOutstanding > 0 ? "warning" : "neutral",
        },
        {
          label: "Net payable now",
          value: money(summary.netPayable),
          format: "money",
          tone: summary.netPayable >= 0 ? "positive" : "danger",
        },
      ],
    });

    const sessions = sessionRes.data ?? [];
    // The app's own definition of time worked: a session is at least a
    // minute, rounded from login to last heartbeat.
    const minutes = total(sessions, (s) =>
      Math.max(1, Math.round((new Date(s.last_active_at).getTime() - new Date(s.logged_in_at).getTime()) / 60000)),
    );
    const activeDays = new Set(sessions.map((s) => s.logged_in_at.slice(0, 10))).size;
    const onlineNow = sessions.some(
      (s) => Date.now() - new Date(s.last_active_at).getTime() <= ONLINE_WINDOW_MS,
    );
    // Screenshot rows are policy alerts, not work — the Activity modal
    // excludes them from the change count for exactly this reason.
    const changes = (changeRes.data ?? []).filter((c) => c.table_name !== "screenshots");
    const areaCounts = tally(changes.map((c) => tableLabel(c.table_name)));

    groups.push({
      label: `Activity — last ${days} days`,
      fields: [
        {
          label: "Online now",
          value: onlineNow ? "yes" : "no",
          format: "status",
          tone: onlineNow ? "positive" : "neutral",
        },
        { label: "Sessions", value: sessions.length, format: "number" },
        { label: "Hours logged in", value: Math.round((minutes / 60) * 10) / 10, format: "number" },
        { label: "Days active", value: activeDays, format: "number" },
        { label: "Records changed", value: changes.length, format: "number" },
        { label: "Busiest area", value: areaCounts[0]?.topic ?? "—" },
      ],
    });

    moneySummary = {
      currency: "LKR",
      commission_earned: money(summary.commissionEarned),
      commission_paid_out: money(summary.commissionPaidOut),
      commission_owed: money(summary.commissionOwed),
      commission_awaiting_approval: money(awaitingApproval),
      loans_outstanding: money(summary.loansOutstanding),
      loans_awaiting_approval: money(summary.loansPending),
      net_payable: money(summary.netPayable),
      note: "'Commission owed' is everything earned less what has been paid out; the not-yet-approved slice is part of it. Loans awaiting approval sit in no total. Use member_money for the loan-by-loan ledger.",
    };
    activitySummary = {
      window_days: days,
      online_now: onlineNow,
      sessions: sessions.length,
      hours_logged_in: Math.round((minutes / 60) * 10) / 10,
      active_days: activeDays,
      records_changed: changes.length,
      by_area: areaCounts,
      caveat:
        "The activity heartbeat only runs for members, so an admin's sessions look about a minute long however long they were really working. Automations and the WhatsApp agent have no signed-in user and are never recorded here.",
    };

    if (loans.length) {
      const loanColumns: ArtifactColumn[] = [
        { key: "issued", label: "Issued", format: "date" },
        { key: "amount", label: "Amount", format: "money", align: "right" },
        { key: "repaid", label: "Repaid", format: "money", align: "right" },
        { key: "balance", label: "Balance", format: "money", align: "right" },
        { key: "approval", label: "Approval", format: "status" },
      ];
      artifacts.push(
        tableArtifact({
          title: `${name} — advances`,
          href,
          area: "team",
          columns: loanColumns,
          rows: rowsToTable(loans, loanColumns, (l) => ({
            id: l.id,
            tone: (l.approval !== "approved"
              ? "info"
              : loanBalance(l) > 0
                ? "warning"
                : "positive") as ArtifactTone,
            cells: {
              issued: l.issued_on,
              amount: money(num(l.amount)),
              repaid: money(loanRepaid(l)),
              balance: money(loanBalance(l)),
              approval: l.approval,
            },
          })),
          total_label: "Still owed",
          total_value: money(summary.loansOutstanding),
          total_format: "money",
        }),
      );
    }

    if (changes.length) {
      artifacts.push(
        timelineArtifact({
          title: `${name} — recent changes`,
          subtitle: `${changes.length} in ${days} days`,
          summary:
            "Recorded by the database itself when a signed-in person edits something. Opening a chat or a page is not a change.",
          href,
          area: "team",
          entries: changes.slice(0, 40).map((c) => ({
            when: fmtDateTime(c.created_at) ?? c.created_at,
            label: `${c.op} ${tableLabel(c.table_name)}`,
            detail: [c.label, (c.changed_fields ?? []).join(", ")].filter(Boolean).join(" — "),
            tone: (c.op === "deleted" ? "danger" : c.op === "created" ? "positive" : "neutral") as ArtifactTone,
          })),
        }),
      );
    }
  }

  const record = recordArtifact({
    title: name,
    subtitle: profile.title ?? profile.role,
    summary: canSeePrivate
      ? "Workload is visible to everyone; money and activity are private to this member and admins."
      : `Workload only — commission, loans and activity are private to ${name} and admins, so they are not shown here.`,
    href,
    area: "team",
    fields,
    groups,
    actions: [{ label: isSelf ? "Open my profile" : "Open the team page", href }],
  });
  artifacts.unshift(record);

  if (leads.length) {
    const base: CrmBase = {
      leads,
      stages: new Map(),
      pipelines: new Map(),
      owners: new Map([[member.id, name]]),
      capped: false,
    };
    const stageIds = [...new Set(leads.map((l) => l.stage_id).filter((id): id is string => Boolean(id)))];
    if (stageIds.length) {
      const { data: stageRows, error: stageError } = await supabase
        .from("pipeline_stages")
        .select("id, name, pipeline_id")
        .in("id", stageIds);
      if (stageError) return { content: { ok: false, error: stageError.message } };
      base.stages = new Map(
        (stageRows ?? []).map((s) => [s.id, { name: s.name, pipeline_id: s.pipeline_id }]),
      );
    }
    artifacts.push(
      tableArtifact({
        title: `${name} — open deals`,
        subtitle: `${leads.length} deals worth ${formatCurrency(openValue, "LKR")}`,
        href: "/crm",
        area: "crm",
        columns: LEAD_TABLE_COLUMNS,
        rows: leadRows(
          [...leads].sort((a, b) => num(b.value) - num(a.value)),
          base,
        ),
        total_label: "Open value",
        total_value: money(openValue),
        total_format: "money",
      }),
    );
  }

  if (tasks.length || todos.length) {
    const workColumns: ArtifactColumn[] = [
      { key: "kind", label: "Kind", format: "status" },
      { key: "title", label: "Task" },
      { key: "due", label: "Due", format: "datetime" },
      { key: "extra", label: "Priority", format: "status", secondary: true },
    ];
    type WorkRow = { id: string; kind: string; title: string; due: string | null; extra: string; href: string };
    const work: WorkRow[] = [
      ...tasks.map((t) => ({
        id: `crm-${t.id}`,
        kind: "CRM task",
        title: t.title,
        due: t.due_at,
        extra: "—",
        href: t.lead_id ? `/crm/lead/${t.lead_id}` : "/crm",
      })),
      ...todos.map((t) => ({
        id: `todo-${t.id}`,
        kind: "To-do",
        title: t.title,
        due: t.due_date,
        extra: t.priority,
        href: t.project_id ? `/projects/${t.project_id}` : "/todos",
      })),
    ].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));

    artifacts.push(
      tableArtifact({
        title: `${name} — open work`,
        subtitle: `${overdueTasks + overdueTodos} overdue`,
        href: "/todos",
        area: "todos",
        columns: workColumns,
        rows: rowsToTable(work, workColumns, (w) => ({
          id: w.id,
          href: w.href,
          tone: (w.due && w.due < nowIso ? "danger" : "info") as ArtifactTone,
          cells: {
            kind: w.kind,
            title: w.title,
            due: w.due ? fmtDateTime(w.due) : "no date",
            extra: w.extra,
          },
        })),
      }),
    );
  }

  return {
    content: {
      ok: true,
      member: name,
      is_self: isSelf,
      role: profile.role,
      workload: {
        open_deals: leads.length,
        open_deal_value: money(openValue),
        currency: "LKR",
        hot_deals: leads.filter((l) => l.score === "hot").length,
        open_crm_tasks: tasks.length,
        overdue_crm_tasks: overdueTasks,
        open_todos: todos.length,
        overdue_todos: overdueTodos,
        top_deals: [...leads]
          .sort((a, b) => num(b.value) - num(a.value))
          .slice(0, 10)
          .map((l) => ({
            deal: l.title,
            company: l.company,
            value: money(num(l.value)),
            score: l.score,
            days_idle: Math.min(9999, daysSince(l.last_activity_at)),
          })),
      },
      money: moneySummary,
      activity: activitySummary,
      restricted: canSeePrivate
        ? null
        : `Commission, loans and login activity are visible only to ${name} or an admin. Tell the user that plainly instead of reporting a figure.`,
    },
    event: { kind: "read", label: `${name} — team report`, href },
    artifacts,
  };
}

// ---- Executor ------------------------------------------------------------

/**
 * Run one of this module's tools. Returns null when `name` belongs to a
 * different module, so the registry can try the next one.
 */
export async function executeGrowthTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "pipeline_report":
      return pipelineReport(args, ctx);
    case "crm_query":
      return crmQuery(args, ctx);
    case "conversation_history":
      return conversationHistory(args, ctx);
    case "whatsapp_report":
      return whatsappReport(args, ctx);
    case "growth_query":
      return growthQuery(args, ctx);
    case "team_report":
      return teamReport(args, ctx);
    default:
      return null;
  }
}
