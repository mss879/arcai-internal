import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ClientStatus,
  Database,
  ProjectStatus,
  TodoPriority,
  TodoStatus,
} from "@/lib/database.types";
import type { ToolSchema } from "@/lib/ai/openai";

/**
 * The assistant's "hands and eyes" on the workspace.
 *
 * Every tool runs through the caller's own Supabase client, so Row-Level
 * Security applies exactly as it would in the UI — the assistant can only see
 * and change what the signed-in member is allowed to. We never use the
 * service-role key here.
 */

type DB = SupabaseClient<Database>;

export type ToolContext = {
  supabase: DB;
  userId: string;
  /** ISO date (YYYY-MM-DD) for "today", used to resolve relative dates. */
  today: string;
};

/** Surfaced to the UI so the user can see what the assistant actually did. */
export type ToolEvent = {
  kind: "read" | "created" | "updated";
  label: string;
  href?: string;
};

export type ToolResult = {
  /** JSON-serialisable payload handed back to the model. */
  content: unknown;
  /** Optional UI event (writes, mainly). */
  event?: ToolEvent;
};

// ---- Tool schemas advertised to the model --------------------------------

export const ASSISTANT_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_workspace_overview",
      description:
        "Get a high-level snapshot of the whole workspace: open/overdue to-dos, the signed-in user's tasks, project counts, CRM pipeline value, client count, upcoming meetings and outstanding payments. Call this for questions like 'what's on my plate' or 'how are things looking'.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_workspace",
      description:
        "Free-text search across clients, to-dos, projects, CRM leads, meetings and resources. Use when the user mentions a name or keyword and you need to find the matching records.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "List to-dos, optionally filtered by status, owner or due window.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["todo", "in_progress", "done"] },
          scope: {
            type: "string",
            enum: ["mine", "all"],
            description: "'mine' = assigned to the signed-in user. Defaults to all.",
          },
          due: {
            type: "string",
            enum: ["overdue", "today", "week"],
            description: "Filter by due date window.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_todo",
      description:
        "Create a new to-do / task. Use for requests like 'add a task to…' or 'remind the team to…'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title." },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          due_date: {
            type: "string",
            description: "Due date as ISO YYYY-MM-DD. Resolve relative dates against today.",
          },
          assignee_name: {
            type: "string",
            description:
              "Name or username of the team member to assign. Use 'me' for the current user. Omit to leave unassigned.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Create a personal reminder for the signed-in user at a given time. Creates a dated task and an in-app notification.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to be reminded about." },
          remind_at: {
            type: "string",
            description: "When, as ISO YYYY-MM-DD (or full ISO datetime). Resolve relative dates against today.",
          },
        },
        required: ["text", "remind_at"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_status",
      description:
        "Change the status of an existing to-do, found by part of its title. Use to mark things done or in progress.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Part of the task title to find it by." },
          status: { type: "string", enum: ["todo", "in_progress", "done"] },
        },
        required: ["title", "status"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_clients",
      description: "List clients, optionally filtered by a name/company search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List projects, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["planning", "active", "on_hold", "completed", "cancelled"],
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_leads",
      description: "List CRM pipeline leads, optionally filtered by stage name.",
      parameters: {
        type: "object",
        properties: { stage: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_meetings",
      description: "List meeting bookings. Defaults to upcoming meetings only.",
      parameters: {
        type: "object",
        properties: {
          include_past: { type: "boolean", description: "Set true to include past meetings." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_team_members",
      description: "List the workspace team members (to resolve who to assign work to).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_client",
      description: "Add a new client to the directory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          company: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          city: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_lead",
      description: "Add a new lead to the CRM pipeline.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Lead title / deal name." },
          company: { type: "string" },
          contact_name: { type: "string" },
          value: { type: "number", description: "Estimated deal value." },
          stage: { type: "string", description: "Stage name; defaults to the first stage." },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_client",
      description:
        "Edit an existing client's details. Find them by name, company or email via 'query', then pass only the fields to change.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Name, company or email used to find the client to edit.",
          },
          name: { type: "string", description: "New client name." },
          company: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          city: { type: "string" },
          notes: { type: "string" },
          status: { type: "string", enum: ["active", "lead", "inactive"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_lead",
      description:
        "Edit a CRM lead or move it between pipeline stages. Find it by title, company or contact via 'query', then pass the fields to change (e.g. stage to move it, or value to update the deal size).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Title, company or contact name used to find the lead.",
          },
          title: { type: "string", description: "New lead title / deal name." },
          stage: {
            type: "string",
            description: "Name of the pipeline stage to move the lead to.",
          },
          value: { type: "number", description: "New estimated deal value." },
          company: { type: "string" },
          contact_name: { type: "string" },
          contact_email: { type: "string" },
          contact_phone: { type: "string" },
          notes: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_meeting",
      description:
        "Reschedule or cancel an upcoming meeting booking. Find it by the client's name via 'query', then pass a new date/time, or set cancel to true.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Client name used to find the upcoming meeting.",
          },
          date: {
            type: "string",
            description: "New booking date as ISO YYYY-MM-DD. Resolve relative dates against today.",
          },
          start_time: {
            type: "string",
            description: "New start time as 24-hour HH:MM (e.g. 14:30).",
          },
          end_time: {
            type: "string",
            description: "New end time as 24-hour HH:MM.",
          },
          cancel: {
            type: "boolean",
            description: "Set true to cancel the meeting instead of moving it.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

// ---- Helpers -------------------------------------------------------------

const SELF_WORDS = new Set(["me", "myself", "i", "my", "mine"]);

async function resolveMemberId(
  ctx: ToolContext,
  name?: string | null,
): Promise<string | null> {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (SELF_WORDS.has(n)) return ctx.userId;

  const { data } = await ctx.supabase
    .from("profiles")
    .select("id, full_name, username")
    .or(`full_name.ilike.%${name}%,username.ilike.%${name}%`)
    .limit(1);
  return data?.[0]?.id ?? null;
}

async function nameMap(
  ctx: ToolContext,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map();
  const { data } = await ctx.supabase
    .from("profiles")
    .select("id, full_name, username")
    .in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.full_name || p.username]));
}

function endOfWeek(today: string): string {
  const d = new Date(today + "T00:00:00");
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

// ---- Executor ------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { supabase, today } = ctx;

  switch (name) {
    case "get_workspace_overview": {
      const [
        openTodos,
        overdueTodos,
        myOpenTodos,
        activeProjects,
        totalProjects,
        leads,
        clients,
        upcomingMeetings,
        outstandingPayments,
      ] = await Promise.all([
        supabase.from("todos").select("*", { count: "exact", head: true }).neq("status", "done"),
        supabase
          .from("todos")
          .select("*", { count: "exact", head: true })
          .neq("status", "done")
          .lt("due_date", today),
        supabase
          .from("todos")
          .select("*", { count: "exact", head: true })
          .neq("status", "done")
          .eq("assigned_to", ctx.userId),
        supabase.from("projects").select("*", { count: "exact", head: true }).eq("status", "active"),
        supabase.from("projects").select("*", { count: "exact", head: true }),
        supabase.from("leads").select("value"),
        supabase.from("clients").select("*", { count: "exact", head: true }),
        supabase
          .from("meeting_bookings")
          .select("*", { count: "exact", head: true })
          .eq("status", "confirmed")
          .gte("booking_date", today),
        supabase.from("payments").select("amount, currency").neq("status", "paid"),
      ]);

      const pipelineValue = (leads.data ?? []).reduce(
        (sum, l) => sum + (l.value ?? 0),
        0,
      );
      const outstanding = (outstandingPayments.data ?? []).reduce(
        (sum, p) => sum + (p.amount ?? 0),
        0,
      );

      return {
        content: {
          open_todos: openTodos.count ?? 0,
          overdue_todos: overdueTodos.count ?? 0,
          my_open_todos: myOpenTodos.count ?? 0,
          active_projects: activeProjects.count ?? 0,
          total_projects: totalProjects.count ?? 0,
          pipeline_leads: (leads.data ?? []).length,
          pipeline_value: pipelineValue,
          clients: clients.count ?? 0,
          upcoming_meetings: upcomingMeetings.count ?? 0,
          outstanding_payments_amount: outstanding,
          currency: "LKR",
        },
      };
    }

    case "search_workspace": {
      const q = String(args.query ?? "").trim();
      if (!q) return { content: { results: [] } };
      const term = `%${q}%`;
      const [clients, todos, projects, leads, meetings, resources] =
        await Promise.all([
          supabase
            .from("clients")
            .select("id, name, company, email, status")
            .or(`name.ilike.${term},company.ilike.${term},email.ilike.${term}`)
            .limit(5),
          supabase
            .from("todos")
            .select("id, title, status, priority, due_date")
            .or(`title.ilike.${term},description.ilike.${term}`)
            .limit(5),
          supabase
            .from("projects")
            .select("id, name, status")
            .or(`name.ilike.${term},description.ilike.${term}`)
            .limit(5),
          supabase
            .from("leads")
            .select("id, title, company, contact_name, value")
            .or(`title.ilike.${term},company.ilike.${term},contact_name.ilike.${term}`)
            .limit(5),
          supabase
            .from("meeting_bookings")
            .select("id, client_name, booking_date, start_time")
            .or(`client_name.ilike.${term},notes.ilike.${term}`)
            .limit(5),
          supabase
            .from("resources")
            .select("id, name, kind")
            .or(`name.ilike.${term},description.ilike.${term}`)
            .limit(5),
        ]);
      return {
        content: {
          clients: clients.data ?? [],
          todos: todos.data ?? [],
          projects: projects.data ?? [],
          leads: leads.data ?? [],
          meetings: meetings.data ?? [],
          resources: resources.data ?? [],
        },
      };
    }

    case "list_todos": {
      let q = supabase
        .from("todos")
        .select("id, title, status, priority, due_date, assigned_to")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(25);

      if (args.status) q = q.eq("status", args.status as TodoStatus);
      if (args.scope === "mine") q = q.eq("assigned_to", ctx.userId);
      if (args.due === "overdue") q = q.lt("due_date", today).neq("status", "done");
      if (args.due === "today") q = q.eq("due_date", today);
      if (args.due === "week") q = q.gte("due_date", today).lte("due_date", endOfWeek(today));

      const { data } = await q;
      const names = await nameMap(ctx, (data ?? []).map((t) => t.assigned_to));
      return {
        content: {
          todos: (data ?? []).map((t) => ({
            title: t.title,
            status: t.status,
            priority: t.priority,
            due_date: t.due_date,
            assignee: t.assigned_to ? names.get(t.assigned_to) ?? null : null,
          })),
        },
        event: { kind: "read", label: "Looked up to-dos", href: "/todos" },
      };
    }

    case "create_todo": {
      const title = String(args.title ?? "").trim();
      if (!title) return { content: { ok: false, error: "Title is required." } };
      const assignee = await resolveMemberId(ctx, args.assignee_name as string);
      const { error } = await supabase.from("todos").insert({
        title,
        description: (args.description as string)?.trim() || null,
        priority: (args.priority as TodoPriority) ?? "medium",
        status: "todo",
        due_date: (args.due_date as string) || null,
        assigned_to: assignee,
      });
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, title, due_date: args.due_date ?? null },
        event: { kind: "created", label: `To-do: ${title}`, href: "/todos" },
      };
    }

    case "create_reminder": {
      const text = String(args.text ?? "").trim();
      const remindAt = String(args.remind_at ?? "").trim();
      if (!text || !remindAt)
        return { content: { ok: false, error: "Reminder text and time are required." } };

      const { error } = await supabase.from("todos").insert({
        title: text,
        priority: "high",
        status: "todo",
        due_date: remindAt,
        assigned_to: ctx.userId,
      });
      if (error) return { content: { ok: false, error: error.message } };

      await supabase.from("notifications").insert({
        user_id: ctx.userId,
        actor_id: ctx.userId,
        type: "system",
        title: `Reminder: ${text}`,
        body: `Due ${remindAt}`,
        link: "/todos",
      });

      return {
        content: { ok: true, text, remind_at: remindAt },
        event: { kind: "created", label: `Reminder: ${text}`, href: "/todos" },
      };
    }

    case "update_todo_status": {
      const title = String(args.title ?? "").trim();
      const status = args.status as TodoStatus;
      if (!title) return { content: { ok: false, error: "Need a task title to find it." } };

      const { data: match } = await supabase
        .from("todos")
        .select("id, title")
        .ilike("title", `%${title}%`)
        .limit(1);
      const found = match?.[0];
      if (!found) return { content: { ok: false, error: `No to-do matching "${title}".` } };

      const { error } = await supabase
        .from("todos")
        .update({
          status,
          completed_at: status === "done" ? new Date().toISOString() : null,
        })
        .eq("id", found.id);
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, title: found.title, status },
        event: { kind: "updated", label: `${found.title} → ${status}`, href: "/todos" },
      };
    }

    case "list_clients": {
      let q = supabase
        .from("clients")
        .select("id, name, company, email, phone, status")
        .order("name")
        .limit(25);
      if (args.query) {
        const term = `%${String(args.query)}%`;
        q = q.or(`name.ilike.${term},company.ilike.${term}`);
      }
      const { data } = await q;
      return {
        content: { clients: data ?? [] },
        event: { kind: "read", label: "Looked up clients", href: "/clients" },
      };
    }

    case "list_projects": {
      let q = supabase
        .from("projects")
        .select("id, name, status, budget, currency, due_date")
        .order("created_at", { ascending: false })
        .limit(25);
      if (args.status) q = q.eq("status", args.status as ProjectStatus);
      const { data } = await q;
      return {
        content: { projects: data ?? [] },
        event: { kind: "read", label: "Looked up projects", href: "/projects" },
      };
    }

    case "list_leads": {
      const { data: stages } = await supabase
        .from("pipeline_stages")
        .select("id, name");
      const stageNames = new Map((stages ?? []).map((s) => [s.id, s.name]));

      let q = supabase
        .from("leads")
        .select("id, title, company, contact_name, value, currency, stage_id")
        .order("updated_at", { ascending: false })
        .limit(25);

      if (args.stage) {
        const match = (stages ?? []).find(
          (s) => s.name.toLowerCase() === String(args.stage).toLowerCase(),
        );
        if (match) q = q.eq("stage_id", match.id);
      }
      const { data } = await q;
      return {
        content: {
          leads: (data ?? []).map((l) => ({
            title: l.title,
            company: l.company,
            contact_name: l.contact_name,
            value: l.value,
            currency: l.currency,
            stage: l.stage_id ? stageNames.get(l.stage_id) ?? null : null,
          })),
        },
        event: { kind: "read", label: "Looked up CRM leads", href: "/crm" },
      };
    }

    case "list_meetings": {
      let q = supabase
        .from("meeting_bookings")
        .select("id, client_name, booking_date, start_time, end_time, status")
        .order("booking_date", { ascending: true })
        .limit(25);
      if (!args.include_past) q = q.gte("booking_date", today);
      const { data } = await q;
      return {
        content: { meetings: data ?? [] },
        event: { kind: "read", label: "Looked up meetings", href: "/meetings" },
      };
    }

    case "list_team_members": {
      const { data } = await supabase
        .from("profiles")
        .select("full_name, username, role, title")
        .order("full_name");
      return { content: { members: data ?? [] } };
    }

    case "create_client": {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: { ok: false, error: "Client name is required." } };
      const { error } = await supabase.from("clients").insert({
        name,
        company: (args.company as string)?.trim() || null,
        email: (args.email as string)?.trim() || null,
        phone: (args.phone as string)?.trim() || null,
        city: (args.city as string)?.trim() || null,
        status: "active",
      });
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, name },
        event: { kind: "created", label: `Client: ${name}`, href: "/clients" },
      };
    }

    case "create_lead": {
      const title = String(args.title ?? "").trim();
      if (!title) return { content: { ok: false, error: "Lead title is required." } };

      const { data: pipeline } = await supabase
        .from("pipelines")
        .select("id")
        .order("position")
        .limit(1)
        .maybeSingle();
      if (!pipeline)
        return {
          content: {
            ok: false,
            error: "No CRM pipeline exists yet. Create one on the CRM page first.",
          },
        };

      const { data: stages } = await supabase
        .from("pipeline_stages")
        .select("id, name, position")
        .eq("pipeline_id", pipeline.id)
        .order("position");
      const stage =
        (args.stage
          ? stages?.find(
              (s) => s.name.toLowerCase() === String(args.stage).toLowerCase(),
            )
          : null) ?? stages?.[0];

      const { count } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("stage_id", stage?.id ?? "");

      const { error } = await supabase.from("leads").insert({
        pipeline_id: pipeline.id,
        stage_id: stage?.id ?? null,
        title,
        company: (args.company as string)?.trim() || null,
        contact_name: (args.contact_name as string)?.trim() || null,
        value: typeof args.value === "number" ? args.value : null,
        position: count ?? 0,
      });
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, title, stage: stage?.name ?? null },
        event: { kind: "created", label: `Lead: ${title}`, href: "/crm" },
      };
    }

    case "update_client": {
      const query = String(args.query ?? "").trim();
      if (!query)
        return { content: { ok: false, error: "Need a name or company to find the client." } };

      const term = `%${query}%`;
      const { data: matches } = await supabase
        .from("clients")
        .select("id, name")
        .or(`name.ilike.${term},company.ilike.${term},email.ilike.${term}`)
        .limit(2);
      if (!matches?.length)
        return { content: { ok: false, error: `No client matching "${query}".` } };
      if (matches.length > 1)
        return {
          content: {
            ok: false,
            error: `More than one client matches "${query}". Be more specific.`,
            candidates: matches.map((m) => m.name),
          },
        };
      const target = matches[0];

      const patch: Database["public"]["Tables"]["clients"]["Update"] = {};
      if (typeof args.name === "string" && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.company === "string") patch.company = args.company.trim() || null;
      if (typeof args.email === "string") patch.email = args.email.trim() || null;
      if (typeof args.phone === "string") patch.phone = args.phone.trim() || null;
      if (typeof args.city === "string") patch.city = args.city.trim() || null;
      if (typeof args.notes === "string") patch.notes = args.notes.trim() || null;
      if (args.status) patch.status = args.status as ClientStatus;

      if (Object.keys(patch).length === 0)
        return { content: { ok: false, error: "Nothing to update — say what to change." } };

      const { error } = await supabase.from("clients").update(patch).eq("id", target.id);
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, name: target.name, changed: Object.keys(patch) },
        event: { kind: "updated", label: `Updated client: ${target.name}`, href: "/clients" },
      };
    }

    case "update_lead": {
      const query = String(args.query ?? "").trim();
      if (!query)
        return { content: { ok: false, error: "Need a lead title or company to find it." } };

      const term = `%${query}%`;
      const { data: matches } = await supabase
        .from("leads")
        .select("id, title, pipeline_id")
        .or(`title.ilike.${term},company.ilike.${term},contact_name.ilike.${term}`)
        .limit(2);
      if (!matches?.length)
        return { content: { ok: false, error: `No lead matching "${query}".` } };
      if (matches.length > 1)
        return {
          content: {
            ok: false,
            error: `More than one lead matches "${query}". Be more specific.`,
            candidates: matches.map((m) => m.title),
          },
        };
      const target = matches[0];

      const patch: Database["public"]["Tables"]["leads"]["Update"] = {};
      if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args.company === "string") patch.company = args.company.trim() || null;
      if (typeof args.contact_name === "string")
        patch.contact_name = args.contact_name.trim() || null;
      if (typeof args.contact_email === "string")
        patch.contact_email = args.contact_email.trim() || null;
      if (typeof args.contact_phone === "string")
        patch.contact_phone = args.contact_phone.trim() || null;
      if (typeof args.value === "number") patch.value = args.value;
      if (typeof args.notes === "string") patch.notes = args.notes.trim() || null;

      let movedTo: string | null = null;
      if (typeof args.stage === "string" && args.stage.trim()) {
        const { data: stages } = await supabase
          .from("pipeline_stages")
          .select("id, name")
          .eq("pipeline_id", target.pipeline_id);
        const match = (stages ?? []).find(
          (s) => s.name.toLowerCase() === String(args.stage).toLowerCase(),
        );
        if (!match)
          return {
            content: {
              ok: false,
              error: `No pipeline stage called "${args.stage}".`,
              stages: (stages ?? []).map((s) => s.name),
            },
          };
        patch.stage_id = match.id;
        movedTo = match.name;
      }

      if (Object.keys(patch).length === 0)
        return { content: { ok: false, error: "Nothing to update — say what to change." } };

      patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("leads").update(patch).eq("id", target.id);
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: { ok: true, title: target.title, stage: movedTo, changed: Object.keys(patch) },
        event: {
          kind: "updated",
          label: movedTo
            ? `${target.title} → ${movedTo}`
            : `Updated lead: ${target.title}`,
          href: "/crm",
        },
      };
    }

    case "reschedule_meeting": {
      const query = String(args.query ?? "").trim();
      if (!query)
        return { content: { ok: false, error: "Need a client name to find the meeting." } };

      const term = `%${query}%`;
      const { data: matches } = await supabase
        .from("meeting_bookings")
        .select("id, client_name, booking_date, start_time")
        .or(`client_name.ilike.${term},notes.ilike.${term}`)
        .gte("booking_date", today)
        .order("booking_date", { ascending: true })
        .limit(2);
      if (!matches?.length)
        return { content: { ok: false, error: `No upcoming meeting matching "${query}".` } };
      if (matches.length > 1)
        return {
          content: {
            ok: false,
            error: `More than one upcoming meeting matches "${query}". Be more specific.`,
            candidates: matches.map((m) => `${m.client_name} on ${m.booking_date}`),
          },
        };
      const target = matches[0];

      const patch: Database["public"]["Tables"]["meeting_bookings"]["Update"] = {};
      if (typeof args.date === "string" && args.date.trim()) patch.booking_date = args.date.trim();
      if (typeof args.start_time === "string" && args.start_time.trim())
        patch.start_time = args.start_time.trim();
      if (typeof args.end_time === "string" && args.end_time.trim())
        patch.end_time = args.end_time.trim();
      if (args.cancel === true) patch.status = "cancelled";

      if (Object.keys(patch).length === 0)
        return {
          content: { ok: false, error: "Say a new date/time, or that it should be cancelled." },
        };

      const { error } = await supabase
        .from("meeting_bookings")
        .update(patch)
        .eq("id", target.id);
      if (error) return { content: { ok: false, error: error.message } };
      return {
        content: {
          ok: true,
          client: target.client_name,
          cancelled: args.cancel === true,
          changed: Object.keys(patch),
        },
        event: {
          kind: "updated",
          label:
            args.cancel === true
              ? `Cancelled: ${target.client_name}`
              : `Rescheduled: ${target.client_name}`,
          href: "/meetings",
        },
      };
    }

    default:
      return { content: { ok: false, error: `Unknown tool: ${name}` } };
  }
}
