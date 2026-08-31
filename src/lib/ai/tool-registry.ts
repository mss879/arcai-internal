import "server-only";

/**
 * One list, one executor, one label for every tool the assistant has.
 *
 * The assistant's tools grew into several modules — the original workspace
 * set, finance, delivery, growth, web analytics, and navigation — and the
 * chat route should not
 * have to know that. Worse, it should not have to know the order they must be
 * tried in: every module's executor returns `null` for a name it does not own
 * so the next one gets a turn, except `executeTool` in `@/lib/ai/tools`, which
 * answers an unknown name with `Unknown tool`. That makes it the only legal
 * last stop, and a subtle bug if it is anywhere else — put it first and every
 * finance, delivery, growth and nav tool would come back as "unknown".
 *
 * The duplicate-name check exists for the same reason. Two modules that
 * happen to export a tool called `list_projects` do not fail; the first
 * executor in the chain silently answers for both, and the second tool is
 * dead code that the model still pays schema tokens to carry. That is the
 * kind of bug you find months later from a wrong answer, so this throws at
 * import instead — loudly, at boot, with both module names in the message.
 */

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import { ASSISTANT_TOOLS, executeTool } from "@/lib/ai/tools";
import { DELIVERY_TOOLS, executeDeliveryTool } from "@/lib/ai/tools-delivery";
import { FINANCE_TOOLS, executeFinanceTool } from "@/lib/ai/tools-finance";
import { GROWTH_TOOLS, executeGrowthTool } from "@/lib/ai/tools-growth";
import { MEMORY_TOOLS, executeMemoryTool } from "@/lib/ai/tools-memory";
import { MISSION_TOOLS, executeMissionTool } from "@/lib/ai/tools-missions";
import { CAREERS_TOOLS, executeCareersTool } from "@/lib/ai/tools-careers";
import { NAV_TOOLS, executeNavTool } from "@/lib/ai/tools-nav";
import {
  WEB_ANALYTICS_TOOLS,
  executeWebAnalyticsTool,
} from "@/lib/ai/tools-web-analytics";
import { defaultToolLabel } from "@/lib/assistant-stream";

/** A module's schemas, named so a clash can say where both sides came from. */
type ToolModule = { module: string; tools: ToolSchema[] };

/**
 * Every module, in the order the model sees them. Navigation comes first
 * because "show me X" is the most common thing asked of an assistant that
 * lives inside an app, and a tool list is read top-down.
 */
const TOOL_MODULES: ToolModule[] = [
  { module: "nav", tools: NAV_TOOLS },
  { module: "memory", tools: MEMORY_TOOLS },
  { module: "missions", tools: MISSION_TOOLS },
  { module: "finance", tools: FINANCE_TOOLS },
  { module: "delivery", tools: DELIVERY_TOOLS },
  { module: "growth", tools: GROWTH_TOOLS },
  { module: "web-analytics", tools: WEB_ANALYTICS_TOOLS },
  { module: "careers", tools: CAREERS_TOOLS },
  { module: "core", tools: ASSISTANT_TOOLS },
];

/** Concatenate the modules, refusing to boot on a duplicate tool name. */
function assembleTools(modules: ToolModule[]): ToolSchema[] {
  const owner = new Map<string, string>();
  const all: ToolSchema[] = [];
  for (const { module, tools } of modules) {
    for (const tool of tools) {
      const name = tool.function.name;
      const first = owner.get(name);
      if (first) {
        throw new Error(
          `Duplicate assistant tool "${name}": declared in both ${first} and ${module}. ` +
            "A duplicate name silently shadows one of the two — rename one of them.",
        );
      }
      owner.set(name, module);
      all.push(tool);
    }
  }
  return all;
}

/** Every tool schema advertised to the model, across every module. */
export const ALL_ASSISTANT_TOOLS: ToolSchema[] = assembleTools(TOOL_MODULES);

/**
 * The module executors that may decline a name by returning `null`.
 * `executeTool` is deliberately absent — it is the fallthrough, below.
 */
const MODULE_EXECUTORS: ((
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult | null>)[] = [
  executeNavTool,
  executeMemoryTool,
  executeMissionTool,
  executeFinanceTool,
  executeDeliveryTool,
  executeGrowthTool,
  executeWebAnalyticsTool,
  executeCareersTool,
];

/**
 * Run whichever module owns `name`.
 *
 * Each module executor is offered the call and returns `null` if the tool is
 * not its own; the original workspace executor answers last because it is the
 * only one that reports an unknown tool rather than passing.
 */
export async function executeAssistantTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  for (const execute of MODULE_EXECUTORS) {
    const result = await execute(name, args, ctx);
    if (result) return result;
  }
  return executeTool(name, args, ctx);
}

/**
 * What the activity trail says while a tool runs.
 *
 * These are read by a person watching Arc work, so they are written as the
 * thing being done ("Writing the invoice"), not as the function being called
 * ("create_invoice"). `defaultToolLabel` covers anything added to a module
 * without being named here — a plain, correct fallback rather than a blank.
 */
const TOOL_LABELS: Record<string, string> = {
  // Navigation — @/lib/ai/tools-nav
  open_app_page: "Opening the page",
  app_capabilities: "Checking what I can do",
  open_record: "Finding the record",

  // Memory — @/lib/ai/tools-memory
  remember: "Remembering that",
  forget: "Forgetting that",
  list_memories: "Reading what I remember",

  // Missions — @/lib/ai/tools-missions
  propose_mission: "Working out a plan",
  mission_status: "Checking the missions",
  control_mission: "Changing the mission",
  mission_step: "Working through the plan",

  // Workspace — @/lib/ai/tools
  get_workspace_overview: "Reading the workspace",
  search_workspace: "Searching the workspace",
  list_todos: "Reading to-dos",
  create_todo: "Adding the task",
  create_reminder: "Setting the reminder",
  update_todo_status: "Updating the task",
  list_clients: "Reading clients",
  list_projects: "Reading projects",
  list_leads: "Reading the pipeline",
  list_meetings: "Reading the calendar",
  list_team_members: "Reading the team",
  create_client: "Adding the client",
  create_lead: "Adding the lead",
  sales_assist: "Thinking about this lead",
  score_leads: "Scoring the leads",
  update_client: "Updating the client",
  update_lead: "Updating the lead",
  reschedule_meeting: "Rescheduling the meeting",
  create_meeting: "Scheduling the meeting",
  cancel_meeting: "Cancelling the meeting",
  list_payments: "Reading payments",
  create_invoice: "Writing the invoice",
  prepare_invoice_email: "Preparing the email",
  prepare_sms: "Writing the text message",
  create_project: "Creating the project",
  record_project_payment: "Recording the payment",
  log_project_expense: "Logging the cost",
  move_project_stage: "Moving the project along",
  add_project_task: "Adding the project task",
  projects_at_risk: "Checking what's at risk",
  ask_projects: "Digging through the projects",
  get_pricing: "Reading the price list",
  list_proposals: "Reading the proposals",
  get_proposal: "Opening the proposal",
  delete_proposal: "Deleting the proposal",
  create_proposal: "Writing the proposal",
  update_proposal: "Revising the proposal",

  // Finance — @/lib/ai/tools-finance
  finance_overview: "Reading the month's money",
  finance_query: "Reading the books",
  get_finance_document: "Pulling up the document",
  member_money: "Reading commission and loans",
  record_expense: "Logging the expense",
  mark_money_received: "Marking the money received",
  create_notice: "Writing the notice",
  create_quote: "Writing the quote",

  // Delivery — @/lib/ai/tools-delivery
  project_dossier: "Reading the whole project",
  delivery_query: "Reading delivery",
  delivery_board: "Checking the delivery board",
  meetings_agenda: "Reading the diary",
  delivery_reports: "Working out the numbers",
  log_project_time: "Logging the hours",
  set_project_blocked: "Marking what it is waiting on",
  complete_milestone: "Ticking the milestone off",

  // Growth — @/lib/ai/tools-growth
  pipeline_report: "Reading the pipeline",
  crm_query: "Reading the CRM",
  conversation_history: "Reading the conversation",
  whatsapp_report: "Checking the WhatsApp agent",
  growth_query: "Reading automations and intelligence",
  team_report: "Reading the team's week",
  create_crm_task: "Adding the CRM task",
  log_lead_activity: "Writing it on the lead's timeline",
  pause_automation: "Pausing the automation",
  resume_automation: "Resuming the automation",
  find_leads_nearby: "Sweeping the area for leads",
  preview_campaign: "Previewing the campaign",
  run_weekly_digest: "Writing the weekly digest",
  run_churn_scan: "Scanning for churn risk",
  save_website_project: "Updating Website Progress",
  apply_project_template: "Seeding from the template",

  // Web Analytics — @/lib/ai/tools-web-analytics
  website_traffic_report: "Reading the website's traffic",
  website_page_performance: "Checking how the pages perform",
  website_journeys: "Following the visitor journeys",
  website_chat_review: "Reading the website chats",
  website_generate_report: "Writing the website report",
  website_sync_now: "Pulling the latest website data",

  // Careers — @/lib/ai/tools-careers
  careers_overview: "Checking how hiring is going",
  list_job_applications: "Reading the applications",
  draft_job_vacancy: "Drafting the job ad",
  careers_sync_now: "Pulling the latest applications",
};

/** The human label the streaming UI shows while `name` is running. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? defaultToolLabel(name);
}
