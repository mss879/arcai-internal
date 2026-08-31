import "server-only";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import { syncCareers } from "@/lib/careers/sync";

/**
 * Careers, as tools Arcus can call.
 *
 * Read and draft only. There is deliberately no publish tool: putting a role
 * on the public careers page is an outward-facing change to a live website,
 * and the difference between "draft this role" and "post this role" is not
 * one to leave to a model's reading of an ambiguous sentence. Drafting is
 * free and reversible, so the assistant can do the writing; a person clicks
 * Publish.
 *
 * Nothing here can edit an application either. What a candidate submitted is
 * a record of what they said, not a field to be tidied.
 */

const STAGES = [
  "new",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
] as const;

export const CAREERS_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "careers_overview",
      description:
        "Hiring at a glance: every role (live on the website or drafted), how " +
        "many people have applied to each, and the pipeline broken down by " +
        "stage. Use for 'how's hiring going', 'what roles are we advertising', " +
        "'how many applicants for X'.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_job_applications",
      description:
        "Job applications submitted on the website, newest first, with the " +
        "candidate's details, what they wrote, their CV link and where they " +
        "are in the pipeline. Use to answer who has applied, who is waiting " +
        "for a reply, or to summarise a candidate.",
      parameters: {
        type: "object",
        properties: {
          stage: {
            type: "string",
            enum: [...STAGES],
            description: "Only applications at this stage.",
          },
          role: {
            type: "string",
            description: "Only applications for roles whose title contains this.",
          },
          query: {
            type: "string",
            description: "Match a candidate's name or email.",
          },
          limit: { type: "number", description: "How many. Default 20, max 60." },
          include_statement: {
            type: "boolean",
            description:
              "Include each candidate's full personal statement. Off by default — " +
              "it is long, so ask for it when actually reading applications.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_job_vacancy",
      description:
        "Write a new role and save it as a DRAFT in Careers. It is not " +
        "published and does not appear on the website — a person publishes it " +
        "from the Careers page. Use when asked to write up or draft a job ad.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The job title." },
          department: { type: "string" },
          location: { type: "string" },
          employment_type: {
            type: "string",
            description: "Full-time, Part-time, Contract, Internship, Freelance or Remote.",
          },
          description: {
            type: "string",
            description: "The role, written for the careers page.",
          },
          requirements: { type: "string", description: "What the candidate needs, one per line." },
          salary_range: { type: "string", description: "Internal only — never published." },
          headcount: { type: "number", description: "How many people. Default 1." },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "careers_sync_now",
      description:
        "Pull the latest job applications from the website immediately instead " +
        "of waiting for the 15-minute schedule.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

async function overview(ctx: ToolContext): Promise<ToolResult> {
  const [vacRes, appRes] = await Promise.all([
    ctx.supabase
      .from("careers_vacancies")
      .select("id, title, department, location, employment_type, status, headcount, closes_on")
      .order("created_at", { ascending: false }),
    ctx.supabase.from("careers_applications").select("vacancy_id, stage, applied_at"),
  ]);

  const applications = appRes.data ?? [];
  const byStage: Record<string, number> = {};
  for (const a of applications) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;

  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();

  return {
    content: {
      roles: (vacRes.data ?? []).map((v) => ({
        title: v.title,
        department: v.department,
        location: v.location,
        type: v.employment_type,
        // "published" is the internal word; on the website it just means live.
        live_on_website: v.status === "published",
        status: v.status,
        openings: v.headcount,
        closes_on: v.closes_on,
        applicants: applications.filter((a) => a.vacancy_id === v.id).length,
      })),
      total_applications: applications.length,
      applications_this_week: applications.filter((a) => a.applied_at >= week).length,
      by_stage: byStage,
      awaiting_review: byStage.new ?? 0,
      href: "/careers",
    },
    event: { kind: "read", label: "Careers", href: "/careers" },
  };
}

async function listApplications(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = clamp(args.limit, 20, 1, 60);
  // Narrowed against the real union rather than cast: the model can send any
  // string here, and an unrecognised one should mean "no stage filter", not
  // a query for a stage that does not exist.
  const stage = STAGES.find((s) => s === args.stage) ?? null;
  const role = typeof args.role === "string" ? args.role.toLowerCase() : null;
  const query = typeof args.query === "string" ? args.query.toLowerCase() : null;

  let q = ctx.supabase
    .from("careers_applications")
    .select("*")
    .order("applied_at", { ascending: false })
    .limit(200);
  if (stage) q = q.eq("stage", stage);

  const { data, error } = await q;
  if (error) return { content: { error: error.message } };

  const rows = (data ?? [])
    .filter((a) => (role ? a.vacancy_title.toLowerCase().includes(role) : true))
    .filter((a) =>
      query
        ? a.name.toLowerCase().includes(query) || a.email.toLowerCase().includes(query)
        : true,
    )
    .slice(0, limit);

  if (!rows.length) {
    return {
      content: {
        applications: [],
        summary: "No applications match that.",
        empty_reason:
          "Applications are pulled from the website every 15 minutes. If this " +
          "seems wrong, the careers sync may not have run — check the Careers page.",
        href: "/careers",
      },
    };
  }

  return {
    content: {
      count: rows.length,
      applications: rows.map((a) => ({
        name: a.name,
        email: a.email,
        phone: a.phone,
        role: a.vacancy_title,
        stage: a.stage,
        rating: a.rating,
        applied_at: a.applied_at,
        can_start: a.earliest_start_date,
        currently_employed: a.currently_employed,
        cv: a.cv_url || null,
        notes: a.notes,
        ...(args.include_statement === true
          ? { personal_statement: a.personal_statement }
          : {}),
      })),
      href: "/careers",
    },
    event: { kind: "read", label: "Job applications", href: "/careers" },
  };
}

async function draftVacancy(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const title = str(args.title, 300);
  if (!title) return { content: { error: "A role needs a title." } };

  const { data, error } = await ctx.supabase
    .from("careers_vacancies")
    .insert({
      title,
      department: str(args.department, 200),
      location: str(args.location, 200),
      employment_type: str(args.employment_type, 80) || "Full-time",
      description: str(args.description, 20_000),
      requirements: str(args.requirements, 20_000),
      salary_range: str(args.salary_range, 200) || null,
      headcount: clamp(args.headcount, 1, 1, 99),
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error) return { content: { error: error.message } };

  return {
    content: {
      ok: true,
      id: data.id,
      title,
      status: "draft",
      note:
        "Saved as a draft. It is NOT on the website — open Careers and click " +
        "Publish when the wording is right.",
      href: "/careers",
    },
    event: { kind: "created", label: "Drafted a role", href: "/careers" },
  };
}

async function syncNowTool(ctx: ToolContext): Promise<ToolResult> {
  const result = await syncCareers(ctx.supabase);
  if (result.skipped) return { content: { error: result.skipped } };
  return {
    content: {
      ok: result.ok,
      applications_pulled: result.applicationsPulled,
      roles_adopted: result.vacanciesPulled,
      warnings: result.errors,
      href: "/careers",
    },
    event: { kind: "updated", label: "Careers sync", href: "/careers" },
  };
}

export async function executeCareersTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "careers_overview":
      return overview(ctx);
    case "list_job_applications":
      return listApplications(args, ctx);
    case "draft_job_vacancy":
      return draftVacancy(args, ctx);
    case "careers_sync_now":
      return syncNowTool(ctx);
    default:
      return null;
  }
}
