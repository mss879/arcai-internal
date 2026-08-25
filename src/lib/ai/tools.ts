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
import type {
  AssistantCard,
  InvoiceCardData,
  ProposalCardData,
  SmsCardData,
} from "@/lib/assistant-cards";
import type {
  Artifact,
  ArtifactColumn,
  ArtifactTone,
} from "@/lib/assistant-artifacts";
import { rowsToTable, tableArtifact } from "@/lib/assistant-artifacts";
import { DELIVERY_STAGES } from "@/lib/constants";
import { topLeadPosition } from "@/lib/crm";
import { nextInvoiceNumber } from "@/lib/invoice";
import { formatPriceField, type PricingGroup } from "@/lib/pricing-catalog";
import {
  PROJECT_MONEY_SELECT,
  balanceDue,
  paidPercent,
  settledAmount,
} from "@/lib/projects";
import {
  AGENT_TIMELINE,
  buildPricing,
  catalogBasePrice,
  defaultContent,
  defaultSelection,
  findCatalogPrice,
  hasItems,
  includedFeatures,
  lineItemFromCatalog,
  lineItemId,
  money,
  proposalPackages,
  recurrenceForField,
  selectionSummary,
  suggestedProjectName,
  type LineRecurrence,
  type ProposalContent,
  type ProposalLineItem,
  type ProposalSelection,
} from "@/lib/proposal";
import {
  flattenPricing,
  pricingSnapshot,
  resolveSelectionPrices,
  selectionPrices,
} from "@/lib/proposal-pricing";
import { generateProposalContent } from "@/lib/ai/proposal";
import { isSmsConfigured } from "@/lib/sms";
import {
  SMS_MAX_LENGTH,
  formatPhone,
  normalizePhone,
  personalizeMessage,
} from "@/lib/sms-utils";

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
  /** Optional rich card rendered in the assistant transcript (e.g. an invoice). */
  card?: AssistantCard;
  /**
   * Optional documents for the assistant's preview canvas — tables, records,
   * charts, PDFs or an embedded page. Cards live inline in the transcript;
   * artifacts open in the pane beside it. See `@/lib/assistant-artifacts`.
   */
  artifacts?: Artifact[];
};

// ---- Tool schemas advertised to the model --------------------------------

/**
 * One priced line on a proposal — shared by create_proposal and
 * update_proposal so the two can never drift.
 *
 * A proposal is a LIST of these, not a single package: a client buying the
 * website AND the premium social package gets both lines on one document.
 * Naming `catalog_key` is what makes a line trustworthy — the package's
 * feature bullets and its list price are then read from the Pricing page
 * server-side, so they land on the document without being retyped and cannot
 * be invented.
 */
const PROPOSAL_LINE_ITEM = {
  type: "object",
  properties: {
    catalog_key: {
      type: "string",
      description:
        "The price_key of a package from get_pricing, e.g. 'web.smart_business.onetime' or 'smm.intermediate.monthly'. Pass it whenever the line is something on the price list: the package's full feature list and its normal price are then taken from the Pricing page automatically and printed on the proposal. Never guess a key — call get_pricing and copy it. Omit only for something bespoke the user described that is not on the list.",
    },
    name: {
      type: "string",
      description:
        "For a bespoke line, what it should print as, e.g. 'Custom booking system'. With catalog_key it is optional and only overrides the package's printed name.",
    },
    price: {
      type: "number",
      description:
        "What the client PAYS for this line, in LKR, exactly as the user said it — never rounded, never checked against the price list. With catalog_key, omit it to charge the current Pricing page amount; pass it whenever the user names a different figure. For a monthly package this is the monthly amount.",
    },
    list_price: {
      type: "number",
      description:
        "What this line NORMALLY costs, when the client is being given it for less. With catalog_key you rarely need it — the Pricing page figure is used automatically, so 'normally 250 but give it at 200' is just price 200. Pass it only when the user states an original that is not the Pricing page figure. Whenever it is higher than price, the proposal prints it struck through next to what they pay.",
    },
    quantity: {
      type: "number",
      description: "How many of this line, when more than one. Defaults to 1.",
    },
    recurrence: {
      type: "string",
      enum: ["one_time", "monthly", "yearly", "at_cost"],
      description:
        "How this line is charged. For a bespoke line you must say: one_time for something built and handed over, monthly / yearly for an ongoing fee, at_cost for something passed through with no agency margin (leave its price out — it prints as 'At cost' and is never added to a total). With catalog_key this is taken from the price list and cannot be overridden, except that you may set at_cost.",
    },
    note: {
      type: "string",
      description:
        "Short qualifier printed in brackets after the line, e.g. 'agreed rate', '12 months'. Only when the user asks for one.",
    },
    features: {
      type: "array",
      items: { type: "string" },
      description:
        "Bullets printed under a BESPOKE line to say what it includes. Ignored when catalog_key is set — that package's real feature list is used instead, so it can never drift from the Pricing page.",
    },
  },
  additionalProperties: false,
} as const;

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
      description:
        "List projects WITH their money: contract value, how much has been received, the balance still owed, how far through payment they are, the client and the due date — exactly the figures the Projects board shows. Optionally filtered by status or a name search. Use it for 'what are we working on', 'which projects still owe us' or 'how much has that job been paid'. The balance here is authoritative: never subtract a deposit from a total yourself.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["planning", "active", "on_hold", "completed", "cancelled"],
          },
          query: {
            type: "string",
            description: "Filter by project name or client name (contains match).",
          },
          limit: {
            type: "integer",
            description: "How many projects to return. Default 25, max 100.",
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
      description:
        "Add a new lead to the CRM pipeline. Include the phone number whenever the user gives one — active 'lead created' automations (e.g. the welcome / keep-warm SMS flow) fire for the new lead automatically.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Lead title / deal name." },
          company: { type: "string" },
          contact_name: { type: "string" },
          contact_phone: { type: "string", description: "Phone, e.g. 0712345678." },
          contact_email: { type: "string" },
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
      name: "sales_assist",
      description:
        "AI sales help on one CRM lead: 'summary' condenses its full history, 'next_action' suggests the best next move (both are saved onto the lead), 'draft_reply' writes a short reply message to send the lead. Find the lead by title, company or contact name via 'query'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Lead title / company / contact name." },
          mode: { type: "string", enum: ["summary", "next_action", "draft_reply"] },
        },
        required: ["query", "mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "score_leads",
      description:
        "Score open CRM leads hot/warm/cold so reps call the right people first. By default only unscored leads are scored; set rescore_all to redo everyone.",
      parameters: {
        type: "object",
        properties: {
          rescore_all: { type: "boolean" },
        },
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
  {
    type: "function",
    function: {
      name: "list_payments",
      description:
        "What clients still owe us, from BOTH ledgers that hold it: every live project's own balance as the Projects board computes it (total value minus everything received), plus Payments-board rows that belong to no project. Defaults to money still outstanding. Every row is labelled with which ledger it came from, and board rows say whether the money is due now or only expected later. Call this before any payment reminder, invoice or SMS about an amount owed — `owed_by_name` gives a per-client total so you never have to add figures up yourself. Bill from `owed_now`; `not_due_yet` beside it is money only expected later and must never go on an invoice or a reminder. Cancelled and archived projects are excluded, and a board row already linked to a project is not listed twice.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Filter by client / company / project name.",
          },
          include_paid: {
            type: "boolean",
            description:
              "Set true to also include fully settled projects and paid board rows.",
          },
          source: {
            type: "string",
            enum: ["all", "projects", "payments_board"],
            description:
              "Which ledger to read. Default 'all'. 'projects' = project balances only; 'payments_board' = only the hand-kept rows with no project.",
          },
          limit: {
            type: "integer",
            description: "How many rows to return. Default 50, max 200. Totals always cover every match, not just the rows returned.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_invoice",
      description:
        "Create and save a new invoice from details the user dictates, then show it to them for review. Use for requests like 'create an invoice for…'. Each line item has a service description and a unit price; quantity defaults to 1. The saved invoice is shown to the user automatically. This does NOT email anything — emailing is a separate, user-confirmed step (prepare_invoice_email).",
      parameters: {
        type: "object",
        properties: {
          company_name: {
            type: "string",
            description: "Who the invoice is billed to — the client or company name.",
          },
          invoice_number: {
            type: "string",
            description:
              "The invoice number if the user gives one (e.g. '205' or '#00205'). Omit to auto-generate the next number.",
          },
          invoice_date: {
            type: "string",
            description: "Invoice date as ISO YYYY-MM-DD. Defaults to today if omitted.",
          },
          bill_to_details: {
            type: "string",
            description: "Optional recipient address / contact lines, one per line.",
          },
          items: {
            type: "array",
            description: "The line items being billed. At least one is required.",
            items: {
              type: "object",
              properties: {
                item: {
                  type: "string",
                  description:
                    "The service or product NAME — shown in the ITEM / SERVICE column. Always fill this when the user names a service or product. Example: the user says 'the service is Smart website' → item is 'Smart website'.",
                },
                description: {
                  type: "string",
                  description:
                    "Extra detail about the line — shown in the DESCRIPTION column. Example: the user says 'description is upgrade from Wordpress' → description is 'upgrade from Wordpress'. If the user gives only one phrase for the line and no separate name, put that phrase here.",
                },
                unit_price: {
                  type: "number",
                  description: "Price per unit in LKR.",
                },
                quantity: {
                  type: "number",
                  description: "Quantity. Defaults to 1 if omitted.",
                },
              },
              required: ["unit_price"],
              additionalProperties: false,
            },
          },
          due_today: {
            type: "number",
            description:
              "Amount due now in LKR. Omit to charge the full total (a deposit would be a smaller number).",
          },
        },
        required: ["company_name", "items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_invoice_email",
      description:
        "Prepare to email a saved invoice to one or more recipients, and show the user a confirmation containing the invoice, the recipient addresses AND any custom message. Use this for 'email this invoice' and 'send a payment reminder'. IMPORTANT: this does NOT send the email. It only asks the user to confirm — the user must tap the Send button to actually send. Never tell the user the invoice has been sent or emailed; instead tell them to review it and tap Send. Convert spoken email addresses to standard form (e.g. 'john at acme dot com' becomes 'john@acme.com').",
      parameters: {
        type: "object",
        properties: {
          recipient_emails: {
            type: "array",
            items: { type: "string" },
            description:
              "One or more email addresses to send the invoice to. Include every address the user lists.",
          },
          message: {
            type: "string",
            description:
              "Optional custom note to include in the email body, e.g. a payment-reminder warning. Reproduce the user's wording as closely as possible.",
          },
          invoice_number: {
            type: "string",
            description:
              "Which saved invoice to send (e.g. '#00205'). Omit to use the most recently created invoice.",
          },
        },
        required: ["recipient_emails"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_sms",
      description:
        "Prepare a text message (SMS) to a client's phone and show the user a confirmation with the recipient and the exact message. Use for 'text …', 'send an SMS', 'message their phone', including SMS payment reminders. IMPORTANT: this does NOT send the SMS. The user must tap the Send button on the confirmation card — never say the text has been sent. Find the recipient by name via client_query — saved clients are checked first, then CRM pipeline leads — and their saved phone number is used automatically. Or pass an explicit phone number the user dictates.",
      parameters: {
        type: "object",
        properties: {
          client_query: {
            type: "string",
            description:
              "Client, CRM lead or company name used to find their saved phone number. Omit if the user dictated a raw number instead.",
          },
          phone: {
            type: "string",
            description:
              "Explicit Sri Lankan phone number (e.g. 0712345678 or 94712345678). Overrides the client's saved number.",
          },
          message: {
            type: "string",
            description:
              "The SMS text to send, as close to the user's wording as possible. Keep it short — it's a text message.",
          },
          kind: {
            type: "string",
            enum: ["custom", "payment_reminder"],
            description:
              "'payment_reminder' when the text is a payment reminder; otherwise 'custom'. Defaults to custom.",
          },
          invoice_number: {
            type: "string",
            description:
              "Optional saved invoice number (e.g. '#00206') to link a payment reminder to.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },

  // ---- Delivery (AI-7, 0098) ---------------------------------------------
  // The assistant could already LIST projects. Everything that actually
  // happens to a project during a day — starting one, recording money, moving
  // it on, logging a cost, adding work — had to be typed into a form. On a
  // phone, speaking is faster than the form.
  {
    type: "function",
    function: {
      name: "create_project",
      description:
        "Create a new project. Use for 'start a project for X', 'set up the website build for Y'. Attach it to a client by name when one is mentioned.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The project's name." },
          client: {
            type: "string",
            description: "Client name to attach it to. Matched loosely.",
          },
          total_value: {
            type: "number",
            description: "What the client is being charged, in LKR.",
          },
          service_type: {
            type: "string",
            description:
              "The kind of work, e.g. business_website, ecommerce, social_media.",
          },
          due_date: { type: "string", description: "YYYY-MM-DD." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_project_payment",
      description:
        "Record money received against a project. Use for 'X paid 50,000', 'log the deposit for Y'.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name. Matched loosely." },
          amount: { type: "number", description: "Amount received." },
          method: {
            type: "string",
            description: "How it was paid, e.g. bank transfer, cash.",
          },
        },
        required: ["project", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_project_expense",
      description:
        "Record a cost against a project. Use for 'add 4,000 hosting to the Cafe project'.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name. Matched loosely." },
          description: { type: "string", description: "What the cost was for." },
          amount: { type: "number", description: "How much it cost." },
          billable: {
            type: "boolean",
            description:
              "True (default) if the client should be charged for it; false if we absorb it.",
          },
        },
        required: ["project", "description", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_project_stage",
      description:
        "Move a project to a delivery stage. Fires the client milestone message and the automations, exactly like the board does. Respects the deposit gate and the launch checklist — say so if it refuses.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name. Matched loosely." },
          stage: {
            type: "string",
            enum: ["onboarding", "assets", "build", "review", "delivered", "aftercare"],
          },
        },
        required: ["project", "stage"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_project_task",
      description: "Add a to-do to a project.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name. Matched loosely." },
          title: { type: "string", description: "What needs doing." },
          due_date: { type: "string", description: "YYYY-MM-DD." },
          assignee: { type: "string", description: "Teammate name, matched loosely." },
        },
        required: ["project", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "projects_at_risk",
      description:
        "What needs attention on delivery right now — the nightly risk ranking, with the reason for each. Use for 'what's at risk this week', 'what should I worry about', 'how is delivery looking'.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many to return. Default 5." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_projects",
      description:
        "Answer a question about the projects using their real data — money owed, spend by category, what was delivered when. Use for anything analytical the other tools don't answer directly, e.g. 'which clients still owe money on delivered work', 'what did we spend on hosting last quarter'.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The user's question, in their own words.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pricing",
      description:
        "Read the agency's live price list from the Pricing page — every package, what each one includes, and its current price with the team's own edits applied. Call this BEFORE quoting, comparing or explaining any package, and whenever the user asks what something costs or what a package includes. Never state a price that did not come from this tool.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional filter on the package or group name, e.g. 'smart business', 'e-commerce', 'whatsapp'. Omit to get the whole price list.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_proposal",
      description:
        "Write and save a full client proposal — the narrative is written by AI around what the client actually asked for, and the pricing is built from the lines you pass. A proposal can carry AS MANY PACKAGES as the client is buying: pass `items` with one entry per thing (the website AND the social retainer AND anything bespoke), each naming a catalog_key from get_pricing so its real features and price come across. The saved proposal appears under Proposals and is shown to the user as a card with a PDF download. IMPORTANT: never guess your way into this tool. If you do not know the client's name, what they are buying, or enough about their business to describe it in two sentences, ASK the user first — a proposal built on assumptions is worse than no proposal. The tool will tell you what is missing if you call it early.",
      parameters: {
        type: "object",
        properties: {
          client_name: {
            type: "string",
            description: "The client or company the proposal is for.",
          },
          items: {
            type: "array",
            items: PROPOSAL_LINE_ITEM,
            description:
              "EVERYTHING the client is buying, one entry per package or bespoke line — this is how a proposal quotes a website and a social media retainer together. Call get_pricing first and pass each package's price_key as catalog_key; its feature list and normal price are then carried onto the document for you. One-time lines are totalled separately from monthly ones, so a retainer is never folded into the build cost. Use this instead of project_type/tier/platform whenever more than one thing is being sold, or whenever the thing being sold is not a website, a store or a standalone agent.",
          },
          notes: {
            type: "array",
            items: { type: "string" },
            description:
              "Short sentences printed under the totals — the caveats that are not a priced line, e.g. 'No monthly fee to ARC — the client pays only their own AI usage, at cost.' Only used with `items`.",
          },
          free_form: {
            type: "boolean",
            description:
              "Whether the writer designs the proposal's own sections instead of the fixed Overview / Objectives / Key Features / SEO layout. Leave it out to decide automatically — a proposal with `items` composes its own sections by default, which is what lets it describe a build and an ongoing service properly. Set false only if the user asks for the classic layout.",
          },
          project_name: {
            type: "string",
            description:
              "Short project name for the cover, e.g. 'Website + AI Agent'. Omit for a sensible default from the package.",
          },
          proposal_date: {
            type: "string",
            description: "Proposal date as ISO YYYY-MM-DD. Defaults to today.",
          },
          project_type: {
            type: "string",
            enum: ["business", "ecommerce", "agent"],
            description:
              "The SINGLE-PACKAGE shortcut, for when the client is buying exactly one of these and nothing else: a business website, an e-commerce store, or a standalone AI agent + CRM with no website build. Required only when you are not passing `items`. Never pass both — put every line in `items` instead.",
          },
          tier: {
            type: "string",
            enum: ["smart_site", "smart_business", "smart_system"],
            description:
              "Website package (only when project_type=business; default smart_business). smart_site = 15 pages + CRM + an agent that answers questions; smart_business = 25 pages + advanced CRM (lead scoring, user roles) + an agent that TAKES ACTION (invoices, proposals, customer emails); smart_system = up to 50 pages + very advanced SEO + WhatsApp AND Instagram agents + automatic lead follow-up + 3 custom automations.",
          },
          platform: {
            type: "string",
            enum: ["store", "smart"],
            description:
              "E-commerce package (only when project_type=ecommerce; default store). store = the online store alone; smart = store + automatic customer profiles + order/delivery updates + abandoned-cart recovery + campaigns.",
          },
          agent_platform: {
            type: "string",
            enum: ["whatsapp", "instagram", "smart_system_budget"],
            description:
              "Which no-website package (only when project_type=agent; default whatsapp). whatsapp / instagram = the full standalone agent + CRM on that channel. smart_system_budget = the budget Smart System: streamlined WhatsApp agent + smart CRM + ONE workflow automation, no website.",
          },
          business_description: {
            type: "string",
            description:
              "Two to four sentences about the client's business and what they need, in the user's own words. This is what the whole proposal narrative is written from — if the user has only given you a name and a package, ask them about the business before calling this.",
          },
          requirements: {
            type: "array",
            items: { type: "string" },
            description:
              "Every concrete thing the client asked for, wants, or complained about, as short near-verbatim lines (e.g. 'customers keep asking where their order is', 'wants to stop answering the same WhatsApp questions'). The proposal is written around these — a thin list produces a generic proposal, so capture everything the user told you.",
          },
          instructions: {
            type: "string",
            description:
              "Free-form direction from the user about HOW to write it — tone, what to emphasise, what to leave out, anything they dictated that is not a hard requirement. Pass their wording through as closely as you can.",
          },
          package_price: {
            type: "number",
            description:
              "SINGLE-PACKAGE FORM ONLY — never with `items`, where the price goes on the line itself. What the client is actually being charged for the package, in LKR, for THIS proposal only. Use it whenever the user names a figure ('the package is 175,000 but I gave them 140,000' means package_price is 140000). Pass exactly what they said — never round it, never check it against the price list. Omit to charge the current Pricing page amount.",
          },
          list_price: {
            type: "number",
            description:
              "SINGLE-PACKAGE FORM ONLY — with `items` use items[].list_price. The package's NORMAL price, when it differs from what's being charged. You rarely need this: the list price is taken from the Pricing page automatically, and whenever package_price is lower the proposal prints the normal price struck through next to the offer price, so the client sees exactly what they were given off. Only pass it when the user states an original that is NOT the Pricing page figure.",
          },
          hide_original: {
            type: "boolean",
            description:
              "SINGLE-PACKAGE FORM ONLY. Set true if the user explicitly wants just the one price shown, with no struck-through original.",
          },
          price_note: {
            type: "string",
            description:
              "SINGLE-PACKAGE FORM ONLY — with `items` use items[].note. Short note printed next to the package line when the price was negotiated, e.g. 'agreed rate' or 'launch offer'. Only when the user asks for one.",
          },
          custom_items: {
            type: "array",
            description:
              "One-time extras printed after the packages — a small add-on the client wants, or a DISCOUNT as a negative amount (e.g. name 'Introductory discount', price -25000). For anything that is a package in its own right, or anything charged monthly, use `items` instead.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Line label as it should print." },
                price: {
                  type: "number",
                  description: "Amount in LKR. Negative for a discount or credit.",
                },
              },
              required: ["name", "price"],
              additionalProperties: false,
            },
          },
          maintenance: {
            type: "string",
            enum: ["none", "m3", "m6", "m12"],
            description:
              "Website Protection plan to include: none, or 3 / 6 / 12 months. Defaults to none.",
          },
          maintenance_price: {
            type: "number",
            description:
              "Overrides the Website Protection price for this proposal, in LKR. Only when the user names a figure.",
          },
          monthly_seo: {
            type: "boolean",
            description:
              "Add the monthly SEO retainer as a recurring note under the total.",
          },
          monthly_seo_price: {
            type: "number",
            description:
              "Overrides the monthly SEO amount for this proposal, in LKR. Only when the user names a figure.",
          },
        },
        // `project_type` is no longer structurally required: a proposal that
        // passes `items` is describing several packages at once, which no
        // single type can name. The tool enforces "items OR a type" itself.
        required: ["client_name", "business_description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_proposal",
      description:
        "Change a proposal that already exists — what is on it, what each line costs, the order the lines print in, the client details, or the written narrative. Use this for EVERY follow-up change ('add the social media package too', 'make the website two hundred thousand', 'drop the maintenance', 'put the website first', 'rewrite it warmer'). Never create a second proposal for the same client when they are asking you to change the first one — that leaves them with two documents and one real deal. The updated proposal is shown to the user again as a card.",
      parameters: {
        type: "object",
        properties: {
          proposal_id: {
            type: "string",
            description: "The proposal's id when you already have it from a previous tool result.",
          },
          client_query: {
            type: "string",
            description:
              "Client or company name to find the proposal by, when you don't have an id. Omit both to change the most recently created proposal.",
          },
          client_name: { type: "string", description: "Corrected client / company name." },
          project_name: { type: "string", description: "Corrected project name." },
          proposal_date: { type: "string", description: "Corrected date as ISO YYYY-MM-DD." },
          add_line_items: {
            type: "array",
            items: PROPOSAL_LINE_ITEM,
            description:
              "Packages or bespoke lines to ADD to what the client is buying — this is how 'they want the social media package as well' gets onto an existing proposal. Call get_pricing first and pass each package's price_key as catalog_key. Anything already on the proposal stays exactly as it prints today.",
          },
          remove_line_items: {
            type: "array",
            items: { type: "string" },
            description:
              "Lines to take off the proposal, named by their printed label or id — a close match is enough, e.g. 'social media'. Never leave the proposal with nothing on it.",
          },
          reprice_line_items: {
            type: "array",
            description:
              "Change what an existing line costs, without touching anything else on the proposal.",
            items: {
              type: "object",
              properties: {
                match: {
                  type: "string",
                  description:
                    "Which line — its printed label or its id; a close match is enough, e.g. 'website'.",
                },
                price: {
                  type: "number",
                  description:
                    "The new price the client pays for that line, in LKR, exactly as the user said it. If it comes in under what the line was listed at, the original is printed struck through beside it automatically.",
                },
                list_price: {
                  type: "number",
                  description:
                    "What that line normally costs, when the user states an original that isn't already on the proposal.",
                },
                quantity: { type: "number", description: "How many of that line." },
                note: {
                  type: "string",
                  description: "Short bracketed qualifier, e.g. 'agreed rate'.",
                },
                hide_original: {
                  type: "boolean",
                  description:
                    "Set true to show one price on that line with nothing struck through.",
                },
              },
              required: ["match"],
              additionalProperties: false,
            },
          },
          reorder_line_items: {
            type: "array",
            items: { type: "string" },
            description:
              "The lines you want first, in the order they should print, named by label or id. Anything you don't name keeps its place behind them.",
          },
          items: {
            type: "array",
            items: PROPOSAL_LINE_ITEM,
            description:
              "REPLACES every line on the proposal with this list. Use it only when the deal has been reshaped from scratch — for an ordinary change use add_line_items / remove_line_items / reprice_line_items, which leave the rest of the document alone.",
          },
          notes: {
            type: "array",
            items: { type: "string" },
            description:
              "Replaces the short sentences printed under the totals, e.g. 'No monthly fee to ARC — the client pays only their own AI usage, at cost.'",
          },
          remove_sections: {
            type: "array",
            items: { type: "string" },
            description:
              "Written sections to drop from the proposal, named by their heading — e.g. 'Where You Are Today'. Only for a proposal whose writer composed its own sections.",
          },
          free_form: {
            type: "boolean",
            description:
              "Only used when the narrative is being rewritten. Leave it out to decide automatically. Set false to force the classic fixed layout.",
          },
          project_type: {
            type: "string",
            enum: ["business", "ecommerce", "agent"],
            description:
              "Switch what they're buying, on a proposal written as a SINGLE package. Only pass it if the package itself is changing. On a proposal with separate lines, change the lines instead.",
          },
          tier: {
            type: "string",
            enum: ["smart_site", "smart_business", "smart_system"],
            description: "Switch the website package tier.",
          },
          platform: {
            type: "string",
            enum: ["store", "smart"],
            description: "Switch the e-commerce package.",
          },
          agent_platform: {
            type: "string",
            enum: ["whatsapp", "instagram", "smart_system_budget"],
            description: "Switch the no-website package.",
          },
          package_price: {
            type: "number",
            description:
              "SINGLE-PACKAGE PROPOSALS ONLY — on one with separate lines, use reprice_line_items. New price for the package line, in LKR, exactly as the user said it. If it comes in under the normal price, the proposal automatically prints the original struck through next to it. Pass 0 or less only if they genuinely want the package free.",
          },
          list_price: {
            type: "number",
            description:
              "SINGLE-PACKAGE PROPOSALS ONLY. The package's normal price, when the user states an original that isn't the Pricing page figure. Usually unnecessary.",
          },
          hide_original: {
            type: "boolean",
            description:
              "SINGLE-PACKAGE PROPOSALS ONLY. Set true if the user explicitly wants the struck-through original removed, leaving one price.",
          },
          price_note: {
            type: "string",
            description:
              "SINGLE-PACKAGE PROPOSALS ONLY — otherwise use reprice_line_items' note. Short note next to the package line, e.g. 'agreed rate'.",
          },
          add_items: {
            type: "array",
            description:
              "One-time EXTRAS to add after the packages — a small add-on, or a discount as a negative amount (e.g. name 'Loyalty discount', price -30000). For a package in its own right, or anything monthly, use add_line_items.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number", description: "Amount in LKR. Negative for a discount." },
              },
              required: ["name", "price"],
              additionalProperties: false,
            },
          },
          remove_items: {
            type: "array",
            items: { type: "string" },
            description:
              "Labels of existing one-time EXTRAS to remove — a close match is enough, e.g. 'live chat'. To take a package off, use remove_line_items.",
          },
          maintenance: {
            type: "string",
            enum: ["none", "m3", "m6", "m12"],
            description: "Change the Website Protection plan.",
          },
          maintenance_price: { type: "number", description: "New Website Protection price in LKR." },
          monthly_seo: { type: "boolean", description: "Turn the monthly SEO note on or off." },
          monthly_seo_price: { type: "number", description: "New monthly SEO amount in LKR." },
          rewrite: {
            type: "boolean",
            description:
              "Set true to regenerate the written narrative — use it when the user wants different wording or a different emphasis. You don't need it when you're switching the package: that rewrites the copy on its own, because the old wording would describe the wrong product.",
          },
          instructions: {
            type: "string",
            description:
              "How to rewrite it, in the user's words (tone, what to emphasise, what to drop). Only used when rewrite is true.",
          },
          requirements: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional things the client asked for, to weave into the rewritten narrative. Only used when rewrite is true.",
          },
        },
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

const WORKSPACE_TZ = "Asia/Colombo";

/**
 * Format a stored date/time into a clear, workspace-local (Sri Lanka) string
 * for the model. To-do due dates are stored as UTC timestamps, so without this
 * the model would read e.g. 2pm Colombo as the underlying "08:30" and report
 * the wrong time. Date-only values (all-day) are shown without a time.
 */
function fmtDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: WORKSPACE_TZ,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00+05:30`));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: WORKSPACE_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/** "14:00" -> "2:00 PM" (booking times are already workspace-local wall clock). */
function fmtTime(hhmm: string | null | undefined): string | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${period}`;
}

/** UTC range covering a single Colombo calendar day (for due-date filtering). */
function colomboDayRange(dateStr: string): { start: string; end: string } {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Find a project by a spoken name (AI-7).
 *
 * A contains match, so "the cafe one" finds "Cafe Aroma - Business website".
 * Archived projects are never matched: acting on one by voice is how a
 * mistake gets made silently.
 */
async function findProject(
  supabase: DB,
  name: unknown,
): Promise<{ id: string; name: string; currency: string } | null> {
  const q = String(name ?? "").trim();
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

/** Same idea for a client name. */
async function findClient(
  supabase: DB,
  name: unknown,
): Promise<{ id: string; name: string } | null> {
  const q = String(name ?? "").trim();
  if (!q) return null;
  const { data } = await supabase
    .from("clients")
    .select("id, name")
    .ilike("name", `%${q}%`)
    .limit(1);
  return data?.[0] ?? null;
}

// ---- Project money helpers -----------------------------------------------

/**
 * The one projects read that can answer a money question.
 *
 * `PROJECT_MONEY_SELECT` names the two relations `settledAmount()` needs — the
 * project's own itemised ledger (`payments`, 0006) and the Payments-board rows
 * linked to it (`company_payments`, 0083). Leaving either out doesn't fail, it
 * silently under-counts, which is exactly how the Payments page came to quote a
 * different balance from the Projects board for the same job.
 *
 * The arithmetic itself is never repeated here. `@/lib/projects` owns it, and
 * everything below only calls it, so the assistant can never disagree with the
 * board the user is looking at.
 */
const PROJECT_MONEY_QUERY =
  "id, name, status, currency, total_value, deposit_paid, due_date, " +
  "client:clients(id, name, company), " +
  PROJECT_MONEY_SELECT;

/** The row shape `PROJECT_MONEY_QUERY` returns, with its two relations. */
type ProjectMoneyQueryRow = {
  id: string;
  name: string;
  status: ProjectStatus;
  currency: string | null;
  total_value: number | null;
  deposit_paid: number | null;
  due_date: string | null;
  client: { id: string; name: string; company: string | null } | null;
  payments:
    | {
        id: string;
        amount: number;
        status: string | null;
        paid_at: string | null;
        method: string | null;
        notes: string | null;
      }[]
    | null;
  company_payments:
    | {
        id: string;
        price_lkr: number;
        is_paid: boolean;
        created_at: string;
        company_name: string;
      }[]
    | null;
};

/** One project with its money already resolved by `@/lib/projects`. */
type ProjectMoneyRow = {
  id: string;
  name: string;
  status: ProjectStatus;
  currency: string;
  clientName: string | null;
  totalValue: number;
  received: number;
  balance: number;
  percent: number;
  due: string | null;
};

/** Money to two decimals — float noise never reaches the model or a client. */
function round2(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function argText(value: unknown): string {
  return String(value ?? "").trim();
}

/** Case-insensitive contains, for the free-text filters the model supplies. */
function hits(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

function clampRows(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/** A name from an embedded `clients` row — PostgREST may hand back either shape. */
function clientLabel(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const r = row as { name?: unknown; company?: unknown };
  const name = String(r.name ?? "").trim();
  const company = String(r.company ?? "").trim();
  return name || company || null;
}

/**
 * Live projects with value, received, balance and paid percent.
 *
 * Archived projects (0090) are excluded: acting on one by voice is how a
 * mistake gets made silently, and an archived job is nobody's balance.
 */
async function loadProjectMoney(
  supabase: DB,
  opts: { status?: ProjectStatus | null; limit: number },
): Promise<{ rows: ProjectMoneyRow[]; error: string | null }> {
  let q = supabase
    .from("projects")
    .select(PROJECT_MONEY_QUERY)
    .is("deleted_at", null);
  if (opts.status) q = q.eq("status", opts.status);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit);
  if (error) return { rows: [], error: error.message };

  // The embedded relations are past what the hand-written Database types
  // describe, so the shape is asserted once here instead of `any` at each use.
  const rows = (data ?? []) as unknown as ProjectMoneyQueryRow[];
  return {
    error: null,
    rows: rows.map((p) => {
      const money = {
        total_value: p.total_value,
        deposit_paid: p.deposit_paid,
        payments: p.payments ?? [],
        company_payments: p.company_payments ?? [],
      };
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        currency: p.currency ?? "LKR",
        clientName: clientLabel(p.client),
        totalValue: round2(p.total_value),
        received: round2(settledAmount(money)),
        balance: round2(balanceDue(money)),
        percent: paidPercent(money),
        due: fmtDateTime(p.due_date),
      };
    }),
  };
}

/** A Payments-board row that has no project behind it. */
type BoardRow = {
  id: string;
  company: string;
  amount: number;
  /** `status` says WHEN the money is expected, not whether it arrived. */
  expected: "due now" | "due later";
  paid: boolean;
};

/**
 * Payments-board rows with no project.
 *
 * Rows that ARE linked to a project are left out on purpose: `settledAmount()`
 * already folds the paid ones into that project's received figure, and an
 * unpaid one is part of the same balance — listing it again would bill a
 * client twice for one debt.
 */
async function loadStandaloneBoard(
  supabase: DB,
): Promise<{ rows: BoardRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("company_payments")
    .select("id, company_name, price_lkr, status, is_paid")
    .is("project_id", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { rows: [], error: error.message };
  return {
    error: null,
    rows: (data ?? []).map((p) => ({
      id: p.id,
      company: p.company_name,
      amount: round2(p.price_lkr),
      expected: p.status === "upcoming" ? ("due later" as const) : ("due now" as const),
      paid: p.is_paid === true,
    })),
  };
}

/** Where a figure came from — printed on every row so the model can say so. */
type MoneySource = "Projects board" | "Payments board";
const PROJECT_SOURCE: MoneySource = "Projects board";
const BOARD_SOURCE: MoneySource = "Payments board";

/** One line of "who still owes us what", from either ledger, labelled. */
type OwedRow = {
  id: string;
  who: string;
  what: string;
  source: MoneySource;
  href: string;
  value: number;
  received: number;
  owed: number;
  when: string;
  paid: boolean;
};

/** How each figure in a money answer is arrived at, in the model's own words. */
const MONEY_BASIS = {
  projects:
    "Project balance = total value − received, where received reconciles the deposit with the project's own paid payment rows (whichever is larger, never their sum) and adds paid Payments-board rows linked to that project. This is the same figure the Projects board and the client portal show.",
  payments_board:
    "Payments-board rows with no project are a separate hand-kept ledger. `due now` (pending) is payable; `due later` (upcoming) is expected money that is NOT yet due — never bill it.",
} as const;

// ---- Proposal helpers ----------------------------------------------------

/** Trimmed, non-empty strings out of whatever the model sent. */
function strings(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
}

/**
 * Extra priced lines. Negative amounts are deliberately allowed — that is how
 * a discount is expressed, and the caller checks the resulting total instead.
 */
function customItems(raw: unknown): { name: string; price: number }[] {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const price = Number(o.price);
      return {
        name: String(o.name ?? "").trim(),
        price: Number.isFinite(price) ? Math.round(price) : 0,
      };
    })
    .filter((i) => i.name);
}

/** A number the model actually sent, as opposed to null/undefined/garbage. */
function dictated(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** Apply the structural bits of a proposal request onto a selection, in place. */
function applyPackage(sel: ProposalSelection, args: Record<string, unknown>): boolean {
  let changed = false;
  const type = String(args.project_type ?? "");
  if (["business", "ecommerce", "agent"].includes(type) && type !== sel.type) {
    sel.type = type as ProposalSelection["type"];
    changed = true;
  }
  const tier = String(args.tier ?? "");
  if (["smart_site", "smart_business", "smart_system"].includes(tier) && tier !== sel.tier) {
    sel.tier = tier as ProposalSelection["tier"];
    changed = true;
  }
  const platform = String(args.platform ?? "");
  if (["store", "smart"].includes(platform) && platform !== sel.platform) {
    sel.platform = platform as ProposalSelection["platform"];
    changed = true;
  }
  const agentPlatform = String(args.agent_platform ?? "");
  if (
    ["whatsapp", "instagram", "smart_system_budget"].includes(agentPlatform) &&
    agentPlatform !== sel.agentPlatform
  ) {
    sel.agentPlatform = agentPlatform as ProposalSelection["agentPlatform"];
    changed = true;
  }
  return changed;
}

// ---- Multi-package proposals ---------------------------------------------
//
// A proposal used to be able to carry exactly ONE package, because the whole
// selection was a `type` plus a `tier`. That made "the website AND the premium
// social package" impossible to quote, and it put two thirds of the price list
// — every retainer, every add-on — out of reach. The helpers below turn the
// model's `items` argument into real `ProposalLineItem`s so a proposal can
// carry as many packages as the client is actually buying.
//
// The division of labour is deliberate: anything the model names by CATALOG
// KEY has its feature list and its list price resolved server-side from the
// live /pricing catalog, so a package's contents can never drift or be
// invented. Anything bespoke comes from the user's own words, and the price is
// whatever they said it is.

/** One line as the model asked for it, before it is resolved. */
type LineItemRequest = {
  catalog_key?: unknown;
  name?: unknown;
  price?: unknown;
  list_price?: unknown;
  quantity?: unknown;
  recurrence?: unknown;
  note?: unknown;
  features?: unknown;
};

const RECURRENCES = ["one_time", "monthly", "yearly", "at_cost"] as const;

/** A recurrence the model actually sent, or null. */
function recurrenceArg(v: unknown): LineRecurrence | null {
  const r = String(v ?? "").trim();
  return (RECURRENCES as readonly string[]).includes(r) ? (r as LineRecurrence) : null;
}

/** Bespoke feature bullets are capped: the Investment table prints them under
 * the line, and an unbounded list turns one row into a page. */
const MAX_ITEM_FEATURES = 8;

/**
 * Turn the model's `items` argument into priced proposal lines.
 *
 * Errors are COLLECTED rather than thrown. A proposal built on a price key the
 * model half-remembered is worse than no proposal, so every problem comes back
 * at once and the model fixes them all in a single turn.
 *
 * @param groups The live /pricing catalog, team overrides already applied.
 * @param raw Whatever arrived in the tool argument.
 * @param taken Ids already in use on this proposal, so a second copy of a
 *   package gets its own id and stays separately addressable.
 */
function parseLineItems(
  groups: PricingGroup[],
  raw: unknown,
  taken: Set<string> = new Set(),
): { items: ProposalLineItem[]; errors: string[] } {
  const items: ProposalLineItem[] = [];
  const errors: string[] = [];

  for (const entry of Array.isArray(raw) ? raw : []) {
    const o = (entry ?? {}) as LineItemRequest;
    const key = String(o.catalog_key ?? "").trim();
    const label = String(o.name ?? "").trim();
    const price = dictated(o.price);
    const list = dictated(o.list_price);
    const quantity = dictated(o.quantity);
    const note = String(o.note ?? "").trim();
    const asked = recurrenceArg(o.recurrence);

    let item: ProposalLineItem | null;

    if (key) {
      const found = findCatalogPrice(groups, key);
      if (!found) {
        errors.push(
          `"${key}" is not a price key on the Pricing page — call get_pricing and use a key exactly as it is returned.`,
        );
        continue;
      }
      if ((found.field.currency ?? "LKR") !== "LKR") {
        errors.push(
          `"${key}" is priced in ${found.field.currency}. A proposal totals in LKR only, so quote it as a line of its own with the LKR figure the user names.`,
        );
        continue;
      }
      item = lineItemFromCatalog(groups, key, {
        label: label || undefined,
        amount: price ?? undefined,
        listAmount: list ?? undefined,
        quantity: quantity ?? undefined,
        note: note || undefined,
        // A catalog line's recurrence is a FACT of its price field ("/month"),
        // not something to restate: letting the model call a retainer one-time
        // would fold it into the one-time total and overstate the proposal by
        // a year of fees. "at_cost" is the one exception — that is a
        // commercial decision, and an at-cost line can never move a total.
        recurrence: asked === "at_cost" ? "at_cost" : undefined,
      });
      if (!item) {
        errors.push(`"${key}" could not be turned into a proposal line.`);
        continue;
      }
      // Feature bullets are the catalog's to give, never the model's: this is
      // what makes "grab the pricing, then put those features on the document"
      // structural instead of something the prompt has to beg for.
    } else {
      if (!label) {
        errors.push(
          "A line with no catalog_key needs a name — say what the client is paying for.",
        );
        continue;
      }
      const recurrence = asked ?? "one_time";
      if (price === null && recurrence !== "at_cost") {
        errors.push(
          `"${label}" has no price. Every line the user described needs the figure they gave for it.`,
        );
        continue;
      }
      item = {
        id: lineItemId(label),
        catalogKey: null,
        label,
        features: strings(o.features).slice(0, MAX_ITEM_FEATURES),
        amount: price ?? 0,
        recurrence,
      };
      if (list !== null && list > (price ?? 0)) item.listAmount = list;
      if (quantity !== null && quantity > 0) item.quantity = quantity;
      if (note) item.note = note;
    }

    // An id addresses a line for a later edit, so two of the same package on
    // one proposal must not both answer to the same name.
    let id = item.id;
    for (let n = 2; taken.has(id); n += 1) id = `${item.id}-${n}`;
    taken.add(id);
    item.id = id;
    items.push(item);
  }

  return { items, errors };
}

/** Does one of the user's words point at this line? Matched loosely against
 * the id, the catalog key and the printed label, because the model quotes
 * whichever of the three it happens to have in front of it. */
function matchesLine(item: ProposalLineItem, needles: string[]): boolean {
  const hay = [item.id, item.catalogKey ?? "", item.label]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  return needles.some((n) => Boolean(n) && hay.some((h) => h.includes(n) || n.includes(h)));
}

/**
 * The priced lines as the MODEL should read them back — each one carrying how
 * it is charged. The card shows the same figures, but the model is the one
 * that speaks them aloud, and a monthly retainer read out as part of the
 * one-time total is exactly the error this is here to prevent.
 */
function spokenLines(pricing: ReturnType<typeof buildPricing>) {
  return pricing.lineItems.map((l) => ({
    label: l.label,
    amount: l.amount,
    ...(typeof l.original === "number" ? { normally: l.original } : {}),
    recurrence: l.recurrence ?? "one_time",
  }));
}

/**
 * Drop the frozen single-package block. Once a proposal prices each thing on
 * its own line there is no "base" package left for `prices.base`, `baseList`
 * or `baseNote` to describe — and leaving them behind would invite a later
 * `package_price` edit that reports success while changing nothing.
 */
function clearLegacyPackage(sel: ProposalSelection): void {
  if (sel.prices) {
    delete sel.prices.base;
    delete sel.prices.baseList;
  }
  delete sel.baseNote;
}

/**
 * Convert a single-package proposal into an item-driven one WITHOUT changing
 * what it prints.
 *
 * The package line is lifted out of `buildPricing()`'s own output, so the
 * label, the amount and the struck-through original are exactly the ones
 * already on the document; the package's feature bullets are the only
 * addition, and they are what the user asked for in the first place. The
 * package's monthly note moves across too, or it would be silently lost.
 *
 * Called ONLY when the user is genuinely changing what is being sold — adding
 * a second package to a proposal that has one. Never on a price edit, a date
 * edit or a rewrite, and never on read: a proposal nobody is restructuring
 * keeps its legacy shape forever.
 */
function materializeLegacyPackage(sel: ProposalSelection): void {
  if (hasItems(sel)) return;
  const legacy = buildPricing(sel);
  // The legacy package block emits the package plus, on the old "custom"
  // e-commerce plan only, its two add-ons. Everything after that is
  // maintenance and custom features, which the item path re-emits unchanged.
  const packageLines =
    1 +
    (sel.type === "ecommerce" && sel.platform === "custom"
      ? (sel.paymentGateway ? 1 : 0) + (sel.delivery ? 1 : 0)
      : 0);
  const lines = legacy.lineItems.slice(0, packageLines);
  if (!lines.length) return;

  const features = includedFeatures(sel).slice(0, MAX_ITEM_FEATURES);
  sel.items = lines.map((l, i) => {
    const item: ProposalLineItem = {
      id: lineItemId(l.label),
      catalogKey: null,
      label: l.label,
      // Only the package itself carries the feature list; its add-ons are one
      // line each and describe themselves.
      features: i === 0 ? features : [],
      amount: l.amount,
      recurrence: "one_time",
    };
    if (typeof l.original === "number") item.listAmount = l.original;
    return item;
  });

  // buildPricing pushes the package's own monthly note first and the
  // monthly-SEO note after it. The SEO note is re-emitted by the item path;
  // the package's is not, so it moves onto the proposal as a free-text note.
  const packageNotes = sel.monthlySeo
    ? legacy.recurringNotes.slice(0, -1)
    : legacy.recurringNotes;
  if (packageNotes.length) sel.notes = [...(sel.notes ?? []), ...packageNotes];

  // The add-ons are lines of their own now; re-reading these flags would
  // print them twice if this proposal ever went back through the legacy path.
  sel.paymentGateway = false;
  sel.delivery = false;
  clearLegacyPackage(sel);
}

/**
 * Which narrative rules and which stock timeline this proposal gets. "agent"
 * means NOTHING is being built — no pages, no SEO — so the writer must not
 * invent any. An item-driven proposal decides from what is actually on the
 * document rather than from the legacy `type`, which no longer describes it.
 */
function proposalProjectKind(sel: ProposalSelection): "website" | "agent" {
  if (!hasItems(sel)) return sel.type === "agent" ? "agent" : "website";
  const keys = sel.items
    .map((i) => (typeof i.catalogKey === "string" ? i.catalogKey : ""))
    .filter(Boolean);
  // All-bespoke: nothing to judge from, so keep the permissive default rather
  // than forbidding the writer from mentioning a build it may well be for.
  if (!keys.length) return "website";
  return keys.some((k) => /^(web|ecom|system)\./.test(k)) ? "website" : "agent";
}

/**
 * The narrative inputs a selection implies — the grouped package/feature
 * ground truth, and whether the writer composes its own sections.
 *
 * A legacy single-package selection yields `undefined` for both, which is what
 * keeps its prompt byte-identical to the one it has always sent. An
 * item-driven one is free-form by default: the fixed Overview/Objectives/Key
 * Features/SEO skeleton structurally cannot describe a build and a retainer in
 * the same document, and printing an SEO heading over a social package is the
 * exact complaint this exists to fix.
 */
function narrativeShape(
  sel: ProposalSelection,
  freeForm: unknown,
): {
  packages: ReturnType<typeof proposalPackages> | undefined;
  allowFreeSections: boolean | undefined;
  projectKind: "website" | "agent";
} {
  const packages = proposalPackages(sel);
  return {
    packages: packages.length ? packages : undefined,
    allowFreeSections:
      typeof freeForm === "boolean" ? freeForm : packages.length ? true : undefined,
    projectKind: proposalProjectKind(sel),
  };
}

/** Everything the proposal card needs, priced from the stored selection. */
function proposalCard(row: {
  id: string;
  client_name: string;
  project_name: string;
  proposal_date: string;
  selection: ProposalSelection;
  content: ProposalContent;
}): ProposalCardData {
  const pricing = buildPricing(row.selection);
  return {
    id: row.id,
    client_name: row.client_name,
    project_name: row.project_name,
    proposal_date: row.proposal_date,
    package_summary: selectionSummary(row.selection),
    line_items: pricing.lineItems.map((l) => ({
      label: l.label,
      amount: l.amount,
      ...(typeof l.original === "number" ? { original: l.original } : {}),
    })),
    grand_total: pricing.oneTimeTotal,
    recurring_notes: pricing.recurringNotes,
    selection: row.selection,
    content: row.content,
  };
}

/** Basic email shape check — the human still verifies it on the confirm card. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Use the number the user gave, or generate the next one — the highest number
 * across every saved invoice plus one, in the same "#00200" style (the exact
 * rule the Invoice Generator's auto-numbering follows).
 */
async function resolveInvoiceNumber(
  supabase: DB,
  provided?: string | null,
): Promise<string> {
  const p = (provided ?? "").trim();
  if (p) return p.startsWith("#") ? p : `#${p}`;
  const { data } = await supabase.from("invoices").select("invoice_number");
  return nextInvoiceNumber((data ?? []).map((row) => row.invoice_number));
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
        // 0090 — archived projects are out of every count.
        supabase
          .from("projects")
          .select("*", { count: "exact", head: true })
          .eq("status", "active")
          .is("deleted_at", null),
        supabase
          .from("projects")
          .select("*", { count: "exact", head: true })
          .is("deleted_at", null),
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
            .is("deleted_at", null)
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
          todos: (todos.data ?? []).map((t) => ({
            title: t.title,
            status: t.status,
            priority: t.priority,
            due: fmtDateTime(t.due_date),
          })),
          projects: projects.data ?? [],
          leads: leads.data ?? [],
          meetings: (meetings.data ?? []).map((m) => ({
            client_name: m.client_name,
            date: fmtDateTime(m.booking_date),
            start_time: fmtTime(m.start_time),
          })),
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
      if (args.due === "today") {
        // due_date may be a UTC timestamp, so match the whole Colombo day.
        const { start, end } = colomboDayRange(today);
        q = q.gte("due_date", start).lt("due_date", end);
      }
      if (args.due === "week") q = q.gte("due_date", today).lte("due_date", endOfWeek(today));

      const { data } = await q;
      const names = await nameMap(ctx, (data ?? []).map((t) => t.assigned_to));
      return {
        content: {
          todos: (data ?? []).map((t) => ({
            title: t.title,
            status: t.status,
            priority: t.priority,
            due: fmtDateTime(t.due_date),
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
        content: { ok: true, title, due: fmtDateTime((args.due_date as string) || null) },
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
        content: { ok: true, text, remind_at: fmtDateTime(remindAt) },
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
      const term = argText(args.query);
      const limit = clampRows(args.limit, 25, 100);
      // A name search has to see the client column too, which lives in an
      // embedded relation — so it scans a wider slice and filters here. The
      // plain list stays one small read.
      const { rows, error } = await loadProjectMoney(supabase, {
        status: (args.status as ProjectStatus | undefined) ?? null,
        limit: term ? 200 : limit,
      });
      if (error) return { content: { ok: false, error } };

      const matched = term
        ? rows.filter((p) => hits(p.name, term) || hits(p.clientName, term))
        : rows;
      const shown = matched.slice(0, limit);

      const columns: ArtifactColumn[] = [
        { key: "project", label: "Project" },
        { key: "client", label: "Client", secondary: true },
        { key: "status", label: "Status", format: "status" },
        { key: "value", label: "Value", format: "money", align: "right" },
        { key: "received", label: "Received", format: "money", align: "right", secondary: true },
        { key: "balance", label: "Balance", format: "money", align: "right" },
        { key: "percent", label: "Paid", format: "percent", align: "right", secondary: true },
        { key: "due", label: "Due", secondary: true },
      ];

      return {
        content: {
          ok: true,
          currency: "LKR",
          basis: MONEY_BASIS.projects,
          matched: matched.length,
          shown: shown.length,
          // Totals cover every match, not just the rows returned, so a capped
          // list can still be totalled without silently dropping projects.
          totals: {
            total_value: round2(matched.reduce((t, p) => t + p.totalValue, 0)),
            received: round2(matched.reduce((t, p) => t + p.received, 0)),
            balance: round2(matched.reduce((t, p) => t + p.balance, 0)),
          },
          projects: shown.map((p) => ({
            name: p.name,
            client: p.clientName,
            status: p.status,
            currency: p.currency,
            total_value: p.totalValue,
            received: p.received,
            balance: p.balance,
            paid_percent: p.percent,
            due: p.due,
            source: PROJECT_SOURCE,
          })),
          note:
            matched.length === 0
              ? "No project matches that. Say so plainly rather than estimating."
              : null,
        },
        event: { kind: "read", label: "Looked up projects", href: "/projects" },
        artifacts: [
          tableArtifact({
            title: "Projects",
            subtitle: term
              ? `Matching "${term}"`
              : args.status
                ? `Status: ${String(args.status)}`
                : "Newest first",
            summary:
              "Balance is total value minus everything received — the Projects board figure, not a re-derived one.",
            href: "/projects",
            area: "projects",
            columns,
            rows: rowsToTable(shown, columns, (p) => ({
              id: p.id,
              href: `/projects/${p.id}`,
              tone: (p.totalValue > 0 && p.balance <= 0
                ? "positive"
                : p.balance > 0
                  ? "warning"
                  : "neutral") as ArtifactTone,
              cells: {
                project: p.name,
                client: p.clientName,
                status: p.status,
                value: p.totalValue,
                received: p.received,
                balance: p.balance,
                percent: p.percent,
                due: p.due,
              },
            })),
            ...(matched.length > shown.length
              ? { truncated: matched.length - shown.length }
              : {}),
            total_label: "Still owed, all matches",
            total_value: round2(matched.reduce((t, p) => t + p.balance, 0)),
            total_format: "money",
            footnote:
              "Archived projects are excluded. A project's internal budget is a cost cap, not money owed, so it is not shown here and must never be quoted to a client.",
          }),
        ],
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
        content: {
          meetings: (data ?? []).map((m) => ({
            client_name: m.client_name,
            date: fmtDateTime(m.booking_date),
            start_time: fmtTime(m.start_time),
            end_time: fmtTime(m.end_time),
            status: m.status,
          })),
        },
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

      // New leads land at the top of their stage column, not the bottom.
      const position = await topLeadPosition(supabase, stage?.id ?? null);

      const { data: created, error } = await supabase
        .from("leads")
        .insert({
          pipeline_id: pipeline.id,
          stage_id: stage?.id ?? null,
          title,
          company: (args.company as string)?.trim() || null,
          contact_name: (args.contact_name as string)?.trim() || null,
          contact_phone: (args.contact_phone as string)?.trim() || null,
          contact_email: (args.contact_email as string)?.trim() || null,
          value: typeof args.value === "number" ? args.value : null,
          source: "manual",
          position,
        })
        .select("*")
        .single();
      if (error) return { content: { ok: false, error: error.message } };

      // Kick off keep-warm / welcome automations for the new lead.
      if (created) {
        const { fireAutomationTrigger } = await import("@/lib/automation");
        await fireAutomationTrigger(supabase, {
          trigger: "lead_created",
          lead: created,
          triggerKey: `${created.id}:created`,
        });
      }

      return {
        content: { ok: true, title, stage: stage?.name ?? null },
        event: { kind: "created", label: `Lead: ${title}`, href: "/crm" },
      };
    }

    case "sales_assist": {
      const query = String(args.query ?? "").trim();
      const mode = String(args.mode ?? "summary") as
        | "summary"
        | "next_action"
        | "draft_reply";
      if (!query)
        return { content: { ok: false, error: "Need a lead name to look up." } };

      const term = `%${query}%`;
      const { data: matches } = await supabase
        .from("leads")
        .select("id, title")
        .or(`title.ilike.${term},company.ilike.${term},contact_name.ilike.${term}`)
        .is("deleted_at", null)
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

      const { aiLeadAssist } = await import("@/app/(app)/crm/actions");
      const res = await aiLeadAssist(matches[0].id, mode);
      if (!res.ok) return { content: { ok: false, error: res.error } };
      return {
        content: { ok: true, lead: matches[0].title, mode, result: res.text },
        event: {
          kind: "updated",
          label: `AI ${mode.replace("_", " ")}: ${matches[0].title}`,
          href: `/crm/lead/${matches[0].id}`,
        },
      };
    }

    case "score_leads": {
      const { scoreLeads } = await import("@/lib/intelligence");
      try {
        const scored = await scoreLeads(supabase, {
          rescoreAll: Boolean(args.rescore_all),
        });
        return {
          content: { ok: true, scored },
          event: { kind: "updated", label: `Scored ${scored} leads`, href: "/crm" },
        };
      } catch (e) {
        return {
          content: {
            ok: false,
            error: e instanceof Error ? e.message : "Scoring failed.",
          },
        };
      }
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

    case "list_payments": {
      const includePaid = args.include_paid === true;
      const term = argText(args.query);
      const limit = clampRows(args.limit, 50, 200);
      const source = argText(args.source).toLowerCase();
      const wantProjects = source !== "payments_board";
      const wantBoard = source !== "projects";

      const [projects, board] = await Promise.all([
        wantProjects
          ? loadProjectMoney(supabase, { limit: 500 })
          : Promise.resolve({ rows: [] as ProjectMoneyRow[], error: null }),
        wantBoard
          ? loadStandaloneBoard(supabase)
          : Promise.resolve({ rows: [] as BoardRow[], error: null }),
      ]);
      const failed = projects.error ?? board.error;
      if (failed) return { content: { ok: false, error: failed } };

      const rows: OwedRow[] = [
        ...projects.rows
          // A cancelled job is not a debt to chase, and a project with neither
          // a contract value nor money in has no balance worth reporting.
          .filter(
            (p) =>
              p.status !== "cancelled" && (p.totalValue > 0 || p.received > 0),
          )
          .filter((p) => includePaid || p.balance > 0)
          .map((p) => ({
            id: p.id,
            who: p.clientName ?? p.name,
            what: p.name,
            source: PROJECT_SOURCE,
            href: `/projects/${p.id}`,
            value: p.totalValue,
            received: p.received,
            owed: p.balance,
            when: p.balance > 0 ? "balance on the project" : "settled",
            paid: p.balance <= 0,
          })),
        ...board.rows
          .filter((b) => includePaid || !b.paid)
          .map((b) => ({
            id: b.id,
            who: b.company,
            what: "Payments board entry (no project)",
            source: BOARD_SOURCE,
            href: "/payments",
            value: b.amount,
            received: b.paid ? b.amount : 0,
            owed: b.paid ? 0 : b.amount,
            when: b.paid ? "settled" : b.expected,
            paid: b.paid,
          })),
      ];

      const matched = (
        term ? rows.filter((r) => hits(r.who, term) || hits(r.what, term)) : rows
      ).sort((a, b) => b.owed - a.owed || b.value - a.value);
      const shown = matched.slice(0, limit);

      // Totals cover every match, not just the rows returned — the old tool
      // capped the list at 25 while the prompt told the model to total it, so
      // rows fell off the end of an invoice.
      const owedIn = (list: OwedRow[]) =>
        round2(list.reduce((t, r) => t + r.owed, 0));
      const fromProjects = matched.filter((r) => r.source === PROJECT_SOURCE);
      const fromBoard = matched.filter((r) => r.source === BOARD_SOURCE);

      // Per-name rollup so a reminder for a client with three projects is one
      // exact figure the model reads off, never a sum it does in its head.
      //
      // `owed_now` deliberately leaves out board rows marked 'upcoming'. Their
      // money is expected, not payable — and this is the one figure the system
      // prompt sends the model to for a payment reminder, so folding not-yet-due
      // money into it would bill a client early for the tool's own arithmetic.
      // It is reported beside the total instead, never inside it.
      const isNotDueYet = (r: OwedRow) => r.when === "due later";
      const byName = new Map<
        string,
        {
          name: string;
          from_projects: number;
          from_payments_board: number;
          owed_now: number;
          not_due_yet: number;
          entries: number;
        }
      >();
      for (const r of matched) {
        if (r.owed <= 0) continue;
        const key = r.who.toLowerCase();
        const entry = byName.get(key) ?? {
          name: r.who,
          from_projects: 0,
          from_payments_board: 0,
          owed_now: 0,
          not_due_yet: 0,
          entries: 0,
        };
        if (isNotDueYet(r)) {
          entry.not_due_yet += r.owed;
        } else {
          if (r.source === PROJECT_SOURCE) entry.from_projects += r.owed;
          else entry.from_payments_board += r.owed;
          entry.owed_now += r.owed;
        }
        entry.entries += 1;
        byName.set(key, entry);
      }
      const owedByName = [...byName.values()]
        .map((e) => ({
          name: e.name,
          from_projects: round2(e.from_projects),
          from_payments_board: round2(e.from_payments_board),
          owed_now: round2(e.owed_now),
          not_due_yet: round2(e.not_due_yet),
          entries: e.entries,
        }))
        .sort((a, b) => b.owed_now - a.owed_now || b.not_due_yet - a.not_due_yet)
        .slice(0, 25);

      const columns: ArtifactColumn[] = [
        { key: "who", label: "Client / company" },
        { key: "what", label: "What", secondary: true },
        { key: "source", label: "Source", format: "status" },
        { key: "value", label: "Value", format: "money", align: "right", secondary: true },
        { key: "received", label: "Received", format: "money", align: "right", secondary: true },
        { key: "owed", label: "Still owed", format: "money", align: "right" },
        { key: "when", label: "When", format: "status" },
      ];

      const artifact = tableArtifact({
        title: "What clients still owe",
        subtitle: term
          ? `Matching "${term}"`
          : includePaid
            ? "Outstanding and settled"
            : "Outstanding only",
        summary:
          "Project balances come from the Projects board and are the authority on what a client owes. Board rows with no project are separate money the team tracks by hand.",
        href: "/payments",
        area: "payments",
        columns,
        rows: rowsToTable(shown, columns, (r) => ({
          id: r.id,
          href: r.href,
          tone: (r.paid
            ? "positive"
            : r.when === "due later"
              ? "neutral"
              : "warning") as ArtifactTone,
          cells: {
            who: r.who,
            what: r.what,
            source: r.source,
            value: r.value,
            received: r.received,
            owed: r.owed,
            when: r.when,
          },
        })),
        ...(matched.length > shown.length
          ? { truncated: matched.length - shown.length }
          : {}),
        // Payable today only. The rows below can include 'due later' money, so
        // the footer says which figure it is rather than letting the reader
        // assume the column adds up to it.
        total_label: "Owed now, all matches",
        total_value: owedIn(matched.filter((r) => !isNotDueYet(r))),
        total_format: "money",
        footnote:
          "Board rows already linked to a project are folded into that project's balance rather than listed twice. 'Due later' is money expected in future — it is not payable yet. Cancelled and archived projects are excluded.",
      });

      return {
        content: {
          ok: true,
          currency: "LKR",
          basis: MONEY_BASIS,
          matched: matched.length,
          shown: shown.length,
          totals: {
            owed_on_projects: owedIn(fromProjects),
            owed_on_board_due_now: owedIn(
              fromBoard.filter((r) => !isNotDueYet(r)),
            ),
            owed_on_board_due_later: owedIn(fromBoard.filter(isNotDueYet)),
            // The billable figure: everything payable today. Quote this one.
            owed_now_total: owedIn(matched.filter((r) => !isNotDueYet(r))),
            // Payable today PLUS money only expected later — a forecast, never
            // an invoice. Split out so the two can never be confused.
            owed_including_not_due_yet: owedIn(matched),
          },
          owed_by_name: owedByName,
          rows: shown.map((r) => ({
            who: r.who,
            what: r.what,
            source: r.source,
            total_value: r.value,
            received: r.received,
            still_owed: r.owed,
            when: r.when,
            paid: r.paid,
          })),
          note:
            matched.length === 0
              ? "Nothing outstanding matches that. Say so plainly — do not estimate a figure."
              : "Bill only what is owed now. Never invoice a 'due later' board row.",
        },
        event: {
          kind: "read",
          label: "Looked up what clients owe",
          href: "/payments",
        },
        artifacts: [artifact],
      };
    }

    case "create_invoice": {
      const company = String(args.company_name ?? "").trim();
      if (!company)
        return {
          content: { ok: false, error: "Need the company or client name for the invoice." },
        };

      const rawItems = Array.isArray(args.items) ? args.items : [];
      const items = rawItems
        .map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          const description = String(o.description ?? "").trim();
          const label = String(o.item ?? o.name ?? "").trim();
          const unit =
            typeof o.unit_price === "number"
              ? o.unit_price
              : Number(o.unit_price) || 0;
          const qtyNum =
            typeof o.quantity === "number" && o.quantity > 0 ? o.quantity : 1;
          // `item` = the ITEM/SERVICE name, `description` = the DESCRIPTION
          // detail — kept separate so each lands in its own column exactly as
          // the user dictated them.
          return {
            item: label,
            description,
            qty: String(qtyNum),
            rate: String(unit),
            total: unit * qtyNum,
          };
        })
        .filter((it) => it.description || it.item || it.total > 0);

      if (!items.length)
        return {
          content: {
            ok: false,
            error: "Need at least one line item — a service and its price.",
          },
        };

      const grand = items.reduce((sum, it) => sum + it.total, 0);
      const due =
        typeof args.due_today === "number" && args.due_today >= 0
          ? args.due_today
          : grand;
      const invoiceDate =
        typeof args.invoice_date === "string" && args.invoice_date.trim()
          ? args.invoice_date.trim()
          : today;
      const number = await resolveInvoiceNumber(
        supabase,
        args.invoice_number as string,
      );
      const billToDetails = String(args.bill_to_details ?? "").trim();

      const { data, error } = await supabase
        .from("invoices")
        .insert({
          invoice_number: number,
          invoice_date: invoiceDate,
          bill_to_name: company,
          bill_to_details: billToDetails,
          items,
          grand_total: grand,
          due_today: due,
        })
        .select("id")
        .single();
      if (error || !data)
        return {
          content: {
            ok: false,
            error: error?.message ?? "Could not save the invoice.",
          },
        };

      const invoice: InvoiceCardData = {
        id: data.id,
        invoice_number: number,
        invoice_date: invoiceDate,
        bill_to_name: company,
        bill_to_details: billToDetails,
        items,
        grand_total: grand,
        due_today: due,
      };

      return {
        content: {
          ok: true,
          invoice_number: number,
          company,
          grand_total: grand,
          due_today: due,
          currency: "LKR",
          note: "Invoice saved and shown to the user for review.",
        },
        event: { kind: "created", label: `Invoice ${number}`, href: "/invoices" },
        card: { type: "invoice", invoice },
      };
    }

    case "prepare_invoice_email": {
      // Accept an array, a comma/space separated string, or the old singular
      // field — then keep only the well-formed addresses.
      const rawEmails = args.recipient_emails ?? args.recipient_email ?? "";
      const candidates = (
        Array.isArray(rawEmails) ? rawEmails : String(rawEmails).split(/[,\s]+/)
      )
        .map((e) => String(e).trim())
        .filter(Boolean);
      const emails = candidates.filter(isEmail);
      const invalid = candidates.filter((e) => !isEmail(e));
      if (!emails.length)
        return {
          content: {
            ok: false,
            error: `No valid email address given${invalid.length ? ` ("${invalid.join('", "')}" looks wrong)` : ""}. Ask the user to repeat it.`,
          },
        };

      const message = String(args.message ?? "").trim() || undefined;
      const number = String(args.invoice_number ?? "").trim();
      // Compare invoice numbers by digits only, ignoring '#' and leading zeros,
      // so a match is exact ("206" === "#00206") and a stray value can't
      // silently grab a different invoice.
      const normalizeNo = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
      let row: Database["public"]["Tables"]["invoices"]["Row"] | undefined;
      if (number) {
        const want = normalizeNo(number);
        const { data } = await supabase
          .from("invoices")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);
        row = (data ?? []).find((r) => normalizeNo(r.invoice_number) === want);
      } else {
        // No number given — use the most recent invoice this user created
        // (i.e. the one they just made).
        const { data } = await supabase
          .from("invoices")
          .select("*")
          .eq("created_by", ctx.userId)
          .order("created_at", { ascending: false })
          .limit(1);
        row = data?.[0];
      }
      if (!row)
        return {
          content: {
            ok: false,
            error: number
              ? `No saved invoice matching "${number}".`
              : "There's no invoice to send yet — create one first.",
          },
        };

      const invoice: InvoiceCardData = {
        id: row.id,
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        bill_to_name: row.bill_to_name,
        bill_to_details: row.bill_to_details,
        items: (row.items ?? []) as InvoiceCardData["items"],
        grand_total: Number(row.grand_total),
        due_today: Number(row.due_today),
      };

      return {
        content: {
          ok: true,
          awaiting_user_confirmation: true,
          invoice_number: row.invoice_number,
          company: row.bill_to_name,
          total: invoice.grand_total,
          recipient_emails: emails,
          message: message ?? null,
          note: "Shown to the user for confirmation. The invoice is NOT sent until the user taps Send. Do not say it has been sent.",
        },
        card: { type: "confirm_send", invoice, emails, message },
      };
    }

    case "prepare_sms": {
      if (!isSmsConfigured())
        return {
          content: {
            ok: false,
            error:
              "SMS isn't configured — Notify.lk keys (NOTIFYLK_USER_ID / NOTIFYLK_API_KEY) are missing from the environment.",
          },
        };

      const rawMessage = String(args.message ?? "").trim();
      if (!rawMessage)
        return { content: { ok: false, error: "Need the message text to send." } };

      // Resolve the recipient: a named client (their saved phone), falling
      // back to the CRM pipeline (a lead's contact_phone) when no client
      // matches, and/or an explicitly dictated number. The number the user
      // dictates wins.
      const clientQuery = String(args.client_query ?? "").trim();
      const dictatedPhone = String(args.phone ?? "").trim();
      let client: { id: string; name: string; phone: string | null } | null = null;
      let lead: {
        id: string;
        title: string;
        contact_name: string | null;
        contact_phone: string | null;
        client_id: string | null;
      } | null = null;
      if (clientQuery) {
        const term = `%${clientQuery}%`;
        const { data: matches } = await supabase
          .from("clients")
          .select("id, name, phone")
          .or(`name.ilike.${term},company.ilike.${term}`)
          .limit(2);
        if ((matches?.length ?? 0) > 1)
          return {
            content: {
              ok: false,
              error: `More than one client matches "${clientQuery}". Be more specific.`,
              candidates: matches!.map((m) => m.name),
            },
          };
        client = matches?.[0] ?? null;

        // Not a saved client (or one without a phone): try the CRM pipeline.
        if (!client || (!client.phone && !dictatedPhone)) {
          const { data: leads } = await supabase
            .from("leads")
            .select("id, title, contact_name, contact_phone, client_id")
            .or(
              `title.ilike.${term},company.ilike.${term},contact_name.ilike.${term}`,
            )
            .is("deleted_at", null)
            .limit(2);
          if ((leads?.length ?? 0) > 1)
            return {
              content: {
                ok: false,
                error: `More than one CRM lead matches "${clientQuery}". Be more specific.`,
                candidates: leads!.map((l) => l.contact_name || l.title),
              },
            };
          lead = leads?.[0] ?? null;
        }
        if (!client && !lead)
          return {
            content: {
              ok: false,
              error: `No client or CRM lead matching "${clientQuery}".`,
            },
          };
      }

      const recipientName = client?.name || lead?.contact_name || lead?.title || "";
      const rawPhone = dictatedPhone || client?.phone || lead?.contact_phone || "";
      if (!rawPhone)
        return {
          content: {
            ok: false,
            error: recipientName
              ? `${recipientName} has no phone number saved in Contacts or the CRM. Ask the user for the number.`
              : "Need a client name or a phone number to text.",
          },
        };
      const phone = normalizePhone(rawPhone);
      if (!phone.ok) return { content: { ok: false, error: phone.error } };

      const message = personalizeMessage(rawMessage, recipientName).trim();
      if (message.length > SMS_MAX_LENGTH)
        return {
          content: {
            ok: false,
            error: `The message is too long (${message.length}/${SMS_MAX_LENGTH} characters). Shorten it.`,
          },
        };

      // Optionally link a payment reminder to a saved invoice by its number.
      const invoiceNo = String(args.invoice_number ?? "").trim();
      let invoiceId: string | null = null;
      let invoiceLabel: string | null = null;
      if (invoiceNo) {
        const normalizeNo = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
        const want = normalizeNo(invoiceNo);
        const { data } = await supabase
          .from("invoices")
          .select("id, invoice_number")
          .order("created_at", { ascending: false })
          .limit(50);
        const row = (data ?? []).find(
          (r) => normalizeNo(r.invoice_number) === want,
        );
        if (row) {
          invoiceId = row.id;
          invoiceLabel = row.invoice_number;
        }
      }

      const sms: SmsCardData = {
        to_number: phone.value,
        to_display: formatPhone(phone.value),
        client_id: client?.id ?? lead?.client_id ?? null,
        lead_id: lead?.id ?? null,
        client_name: recipientName,
        message,
        kind: args.kind === "payment_reminder" ? "payment_reminder" : "custom",
        invoice_id: invoiceId,
        invoice_number: invoiceLabel,
      };

      return {
        content: {
          ok: true,
          awaiting_user_confirmation: true,
          to: sms.to_display,
          client: sms.client_name || null,
          message,
          kind: sms.kind,
          linked_invoice: invoiceLabel,
          note: "Shown to the user for confirmation. The SMS is NOT sent until the user taps Send. Do not say it has been sent.",
        },
        card: { type: "confirm_send_sms", sms },
      };
    }

    // ---- Delivery (AI-7, 0098) -------------------------------------------

    case "create_project": {
      const projectName = String(args.name ?? "").trim();
      if (!projectName)
        return { content: { ok: false, error: "The project needs a name." } };

      const client = await findClient(supabase, args.client);
      const { data: created, error } = await supabase
        .from("projects")
        .insert({
          name: projectName,
          client_id: client?.id ?? null,
          status: "planning",
          currency: "LKR",
          total_value:
            typeof args.total_value === "number" ? args.total_value : null,
          service_type: (args.service_type as string)?.trim() || null,
          start_date: today,
          due_date: (args.due_date as string)?.trim() || null,
          created_by: ctx.userId,
        })
        .select("id, name")
        .single();
      if (error || !created)
        return { content: { ok: false, error: error?.message ?? "Insert failed." } };

      // Same trigger the form fires (0096) — a project created by voice must
      // start the same kickoff flow as one created by hand.
      const { fireProjectCreated } = await import("@/lib/project-events");
      await fireProjectCreated(supabase, created.id, "assistant");

      return {
        content: { ok: true, project: created.name, client: client?.name ?? null },
        event: {
          kind: "created",
          label: `Project: ${created.name}`,
          href: `/projects/${created.id}`,
        },
      };
    }

    case "record_project_payment": {
      const project = await findProject(supabase, args.project);
      if (!project)
        return { content: { ok: false, error: `No project matching "${args.project}".` } };
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0)
        return { content: { ok: false, error: "Enter a valid amount." } };

      const { data: payment, error } = await supabase
        .from("payments")
        .insert({
          project_id: project.id,
          amount,
          currency: project.currency || "LKR",
          status: "paid",
          paid_at: today,
          method: (args.method as string)?.trim() || null,
        })
        .select("id")
        .single();
      if (error || !payment)
        return { content: { ok: false, error: error?.message ?? "Insert failed." } };

      // The same payment_received event the board fires, so a deposit logged
      // by voice still kicks off onboarding.
      const { buildPaymentEvent } = await import("@/lib/delivery");
      const { fireAutomationTrigger } = await import("@/lib/automation");
      const event = await buildPaymentEvent(supabase, {
        projectId: project.id,
        amountText: `${project.currency || "LKR"} ${amount.toLocaleString()}`,
        source: "project_detail",
        triggerKey: `project_payment:${payment.id}:paid`,
      });
      if (event) await fireAutomationTrigger(supabase, event);

      return {
        content: { ok: true, project: project.name, amount },
        event: {
          kind: "created",
          label: `Payment on ${project.name}`,
          href: `/projects/${project.id}`,
        },
      };
    }

    case "log_project_expense": {
      const project = await findProject(supabase, args.project);
      if (!project)
        return { content: { ok: false, error: `No project matching "${args.project}".` } };
      const amount = Number(args.amount);
      const description = String(args.description ?? "").trim();
      if (!description)
        return { content: { ok: false, error: "Say what the cost was for." } };
      if (!Number.isFinite(amount) || amount <= 0)
        return { content: { ok: false, error: "Enter a valid amount." } };

      const { data: expense, error } = await supabase
        .from("project_expenses")
        .insert({
          project_id: project.id,
          description,
          qty: 1,
          unit_amount: amount,
          currency: project.currency || "LKR",
          billable: args.billable !== false,
          incurred_on: today,
          created_by: ctx.userId,
        })
        .select("id")
        .single();
      if (error || !expense)
        return { content: { ok: false, error: error?.message ?? "Insert failed." } };

      const { fireExpenseAdded } = await import("@/lib/project-events");
      await fireExpenseAdded(supabase, project.id, {
        id: expense.id,
        description,
        amount,
        billable: args.billable !== false,
      });

      return {
        content: {
          ok: true,
          project: project.name,
          description,
          amount,
          billable: args.billable !== false,
        },
        event: {
          kind: "created",
          label: `Expense on ${project.name}`,
          href: `/projects/${project.id}`,
        },
      };
    }

    case "move_project_stage": {
      const project = await findProject(supabase, args.project);
      if (!project)
        return { content: { ok: false, error: `No project matching "${args.project}".` } };
      const stage = String(args.stage ?? "");
      if (!(DELIVERY_STAGES as readonly string[]).includes(stage))
        return { content: { ok: false, error: `"${stage}" is not a delivery stage.` } };

      // Through the server action, NOT setProjectDeliveryStage directly: the
      // deposit gate and launch checklist live there, and a stage moved by
      // voice must not bypass a rule a click obeys.
      const { setProjectStage } = await import("@/app/(app)/projects/actions");
      const res = await setProjectStage(
        project.id,
        stage as (typeof DELIVERY_STAGES)[number],
      );
      if (!res.ok)
        return {
          content: {
            ok: false,
            error: res.error,
            blocked_by: res.gate?.kind ?? null,
          },
        };

      return {
        content: { ok: true, project: project.name, stage },
        event: {
          kind: "updated",
          label: `${project.name} -> ${stage}`,
          href: `/projects/${project.id}`,
        },
      };
    }

    case "add_project_task": {
      const project = await findProject(supabase, args.project);
      if (!project)
        return { content: { ok: false, error: `No project matching "${args.project}".` } };
      const title = String(args.title ?? "").trim();
      if (!title) return { content: { ok: false, error: "Say what needs doing." } };

      let assignedTo: string | null = null;
      if (args.assignee) {
        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name")
          .ilike("full_name", `%${String(args.assignee)}%`)
          .limit(1);
        assignedTo = people?.[0]?.id ?? null;
      }

      const { error } = await supabase.from("todos").insert({
        title,
        project_id: project.id,
        assigned_to: assignedTo,
        due_date: (args.due_date as string)?.trim()
          ? `${String(args.due_date).trim()}T17:00:00`
          : null,
        created_by: ctx.userId,
      });
      if (error) return { content: { ok: false, error: error.message } };

      return {
        content: { ok: true, project: project.name, task: title },
        event: {
          kind: "created",
          label: `Task on ${project.name}`,
          href: `/projects/${project.id}`,
        },
      };
    }

    case "projects_at_risk": {
      const limit = Math.min(10, Math.max(1, Number(args.limit ?? 5)));
      const { data } = await supabase
        .from("projects")
        .select("id, name, risk_rank, risk_note, risk_checked_at, due_date")
        .is("deleted_at", null)
        .not("risk_rank", "is", null)
        .order("risk_rank", { ascending: true })
        .limit(limit);

      if (!data?.length)
        return {
          content: {
            ok: true,
            projects: [],
            note: "Nothing is flagged. The risk radar runs once a night — if projects were only just added, it may not have looked yet.",
          },
          event: { kind: "read", label: "Checked delivery risk", href: "/projects" },
        };

      return {
        content: {
          ok: true,
          checked: data[0].risk_checked_at,
          projects: data.map((p) => ({
            rank: p.risk_rank,
            name: p.name,
            why: p.risk_note,
            due: p.due_date,
          })),
        },
        event: {
          kind: "read",
          label: "Checked delivery risk",
          href: "/projects?sort=health",
        },
      };
    }

    case "ask_projects": {
      const { askProjects } = await import("@/lib/ai/project-query");
      const res = await askProjects(supabase, String(args.question ?? ""));
      if (!res.ok) return { content: { ok: false, error: res.error } };
      return {
        content: {
          ok: true,
          answer: res.result.answer,
          projects: res.result.rows,
        },
        event: { kind: "read", label: "Asked the projects", href: "/projects" },
      };
    }

    case "get_pricing": {
      const groups = await pricingSnapshot(supabase);
      // Every package carries its KEY and its real feature list, because this
      // is the tool a proposal is built from: `price_key` goes straight into
      // create_proposal's `items[].catalog_key`, and the features on that
      // package are then copied onto the document server-side. Without the
      // keys the model could only describe a package it had no way to quote.
      const shaped = groups.map((g) => ({
        group: g.title,
        group_key: g.key,
        about: g.subtitle ?? "",
        packages: g.packages.map((p) => ({
          package_key: p.key,
          name: p.name,
          tagline: p.tagline ?? "",
          badge: p.badge ?? "",
          includes: p.features ?? [],
          prices: p.prices.map((f) => ({
            price_key: f.key,
            label: f.label,
            amount: f.amount,
            currency: f.currency ?? "LKR",
            // "from" means the amount is a floor, not a fixed figure.
            starts_at: f.prefix === "from",
            unit: f.suffix ?? "",
            // How it is charged, in the exact words create_proposal expects.
            // Derived from the catalog, never guessed: this is what keeps a
            // monthly retainer out of the one-time total.
            recurrence: recurrenceForField(f),
            display: formatPriceField(f),
          })),
          note: p.note ?? "",
        })),
      }));

      // A filter that matches nothing is far more likely to be a clumsy search
      // term than a real absence, so fall back to the whole list rather than
      // letting the model conclude a package doesn't exist.
      const q = String(args.query ?? "").trim().toLowerCase();
      const narrowed = q
        ? shaped
            .map((g) => ({
              ...g,
              packages: g.packages.filter((p) =>
                `${g.group} ${p.name} ${p.tagline}`.toLowerCase().includes(q),
              ),
            }))
            .filter((g) => g.packages.length)
        : shaped;

      return {
        content: {
          ok: true,
          currency: "LKR",
          pricing: narrowed.length ? narrowed : shaped,
          note: "These are the agency's live prices, including any edits made on the Pricing page. Quote them exactly. The user can still set a different price for one client on a specific proposal.",
          how_to_quote:
            "To put any of these on a proposal, pass its price_key as items[].catalog_key in create_proposal or update_proposal. The package's feature list and its list price are then taken from here automatically, so you never retype them and they cannot drift. A proposal may combine as many of these as the client is buying. Anything with recurrence 'monthly' or 'yearly' is an ongoing fee and is totalled separately from the one-time build — never add the two together.",
        },
        event: { kind: "read", label: "Checked pricing", href: "/pricing" },
      };
    }

    case "create_proposal": {
      const clientName = String(args.client_name ?? "").trim();
      const type = String(args.project_type ?? "").trim();
      const description = String(args.business_description ?? "").trim();
      // `items` is the multi-package form: any number of priced lines, drawn
      // from the price list or described by the user. `project_type` is the
      // older single-package form and stays required only for it — "a website
      // AND the social package" is not one of the three types, which is
      // exactly why one type could never express it.
      const itemsRaw = Array.isArray(args.items) ? args.items : [];
      const wantsItems = itemsRaw.length > 0;

      // Rather than inventing the gaps, hand them back so the model asks.
      const missing: string[] = [];
      if (!clientName) missing.push("who the proposal is for — the client or company name");
      if (!wantsItems && !["business", "ecommerce", "agent"].includes(type))
        missing.push(
          "what they're buying — either an `items` list of the packages they want, or a business website / e-commerce store / standalone AI agent with CRM",
        );
      if (description.length < 40)
        missing.push(
          "what their business actually does and what they need fixed — two or three sentences, in the user's own words",
        );
      if (missing.length)
        return {
          content: {
            ok: false,
            error: "There isn't enough here to write a real proposal yet.",
            missing,
            ask: "Ask the user for each missing detail, one short question at a time, and wait for their answer. Do not fill any of it in yourself.",
          },
        };

      const selection: ProposalSelection = { ...defaultSelection() };
      applyPackage(selection, { ...args, project_type: type });
      const maintenance = String(args.maintenance ?? "");
      if (["none", "m3", "m6", "m12"].includes(maintenance))
        selection.maintenance = maintenance as ProposalSelection["maintenance"];
      selection.monthlySeo = args.monthly_seo === true;
      selection.customFeatures = customItems(args.custom_items);

      // One read of the live Pricing page, used both to resolve the catalog
      // lines and to freeze today's maintenance / SEO amounts onto the
      // proposal so it never re-prices when /pricing is edited later.
      const catalog = await pricingSnapshot(supabase);

      if (wantsItems) {
        const parsed = parseLineItems(catalog, itemsRaw);
        if (parsed.errors.length)
          return {
            content: {
              ok: false,
              error: "Some of those lines couldn't be priced, so nothing was saved.",
              problems: parsed.errors,
              ask: "Call get_pricing and use the price_key exactly as it comes back, or give the line a name and the price the user stated. Do not guess a key.",
            },
          };
        if (!parsed.items.length)
          return {
            content: {
              ok: false,
              error: "None of those lines had anything on them.",
              ask: "Each item needs either a catalog_key from get_pricing, or a name and a price.",
            },
          };
        selection.items = parsed.items;
        selection.notes = strings(args.notes).slice(0, 6);
        if (!selection.notes.length) delete selection.notes;
      }

      // The single-package price arguments describe a base package line that
      // an item-driven proposal does not have. Silently dropping them would
      // lose a figure the user actually stated — the one thing this must
      // never do — so say so and let the model put it on the right line.
      const priceNote = String(args.price_note ?? "").trim();
      if (
        hasItems(selection) &&
        (dictated(args.package_price) !== null ||
          dictated(args.list_price) !== null ||
          args.hide_original === true ||
          priceNote)
      )
        return {
          content: {
            ok: false,
            error:
              "This proposal prices each thing on its own line, so there is no single package price to set.",
            ask: "Put the figure on the line it belongs to: items[].price is what the client pays for that line, items[].list_price is what it normally goes for, and items[].note is the short label like 'agreed rate'.",
          },
        };

      // Start from what the team charges today, then let anything the user
      // dictated override it — and freeze the result onto this proposal so it
      // never re-prices when the Pricing page is edited later.
      selection.prices = selectionPrices(flattenPricing(catalog), selection);
      if (hasItems(selection)) {
        // Each line carries its own price and its own list price, so the
        // frozen base block would describe a line that never prints.
        clearLegacyPackage(selection);
      } else {
        // Remember what the package normally goes for BEFORE any offer price
        // is applied, so a reduction prints as the list price struck through
        // next to what the client is actually paying.
        selection.prices.baseList =
          dictated(args.list_price) ??
          selection.prices.base ??
          catalogBasePrice(selection);
        const base = dictated(args.package_price);
        if (base !== null) selection.prices.base = base;
        if (args.hide_original === true) delete selection.prices.baseList;
        if (priceNote) selection.baseNote = priceNote;
      }
      const maint = dictated(args.maintenance_price);
      if (maint !== null) selection.prices.maintenance = maint;
      const seo = dictated(args.monthly_seo_price);
      if (seo !== null) selection.prices.monthlySeo = seo;

      const pricing = buildPricing(selection);
      const negative =
        pricing.oneTimeTotal < 0
          ? { what: "one-time total", amount: pricing.oneTimeTotal }
          : (pricing.monthlyTotal ?? 0) < 0
            ? { what: "monthly total", amount: pricing.monthlyTotal ?? 0 }
            : (pricing.yearlyTotal ?? 0) < 0
              ? { what: "yearly total", amount: pricing.yearlyTotal ?? 0 }
              : null;
      if (negative)
        return {
          content: {
            ok: false,
            error: `That works out to a ${negative.what} of ${money(negative.amount)} — the discount is larger than everything it's being taken off. Check the figures with the user before saving.`,
          },
        };

      const projectName =
        String(args.project_name ?? "").trim() || suggestedProjectName(selection);
      const instructions = String(args.instructions ?? "").trim();

      const shape = narrativeShape(selection, args.free_form);
      const narrative = await generateProposalContent({
        businessDescription: description,
        clientName,
        projectName,
        selectionSummary: selectionSummary(selection),
        includedFeatures: includedFeatures(selection),
        customFeatures: selection.customFeatures,
        requirements: strings(args.requirements).slice(0, 25),
        teamInstructions: instructions || undefined,
        projectKind: shape.projectKind,
        packages: shape.packages,
        allowFreeSections: shape.allowFreeSections,
      });

      const proposalDate =
        typeof args.proposal_date === "string" && args.proposal_date.trim()
          ? args.proposal_date.trim()
          : today;

      const content: ProposalContent = {
        ...defaultContent(),
        // The stock timeline talks pages and design — wrong for a deployment
        // that builds nothing of the sort.
        ...(shape.projectKind === "agent" ? { timeline: AGENT_TIMELINE } : {}),
        ...narrative,
      };

      const { data, error } = await supabase
        .from("proposals")
        .insert({
          client_name: clientName,
          project_name: projectName,
          proposal_date: proposalDate,
          selection: selection as unknown as Record<string, unknown>,
          content: content as unknown as Record<string, unknown>,
          grand_total: pricing.oneTimeTotal,
        })
        .select("id")
        .single();
      if (error || !data)
        return {
          content: {
            ok: false,
            error: error?.message ?? "Could not save the proposal.",
          },
        };

      const card = proposalCard({
        id: data.id,
        client_name: clientName,
        project_name: projectName,
        proposal_date: proposalDate,
        selection,
        content,
      });

      return {
        content: {
          ok: true,
          proposal_id: data.id,
          client: clientName,
          project: projectName,
          package: card.package_summary,
          line_items: spokenLines(pricing),
          grand_total: card.grand_total,
          one_time_total: pricing.oneTimeTotal,
          monthly_total: pricing.monthlyTotal ?? 0,
          yearly_total: pricing.yearlyTotal ?? 0,
          recurring_notes: card.recurring_notes,
          currency: "LKR",
          note: "Saved under Proposals and shown to the user for review. Read back the client, what's on it, and the one-time total — and, when monthly_total is above zero, the monthly figure SEPARATELY. The two are never added together. To change anything, call update_proposal — never create a second proposal for the same client.",
        },
        event: {
          kind: "created",
          label: `Proposal — ${clientName}`,
          href: "/proposals",
        },
        card: { type: "proposal", proposal: card },
      };
    }

    case "update_proposal": {
      const id = String(args.proposal_id ?? "").trim();
      const query = String(args.client_query ?? "").trim();

      const rows = supabase
        .from("proposals")
        .select("id, client_name, project_name, proposal_date, selection, content");
      const filtered = id
        ? rows.eq("id", id)
        : query
          ? rows.ilike("client_name", `%${query}%`)
          : rows;
      const { data: found } = await filtered
        .order("created_at", { ascending: false })
        .limit(1);
      const row = found?.[0];
      if (!row)
        return {
          content: {
            ok: false,
            error: query
              ? `No saved proposal found for "${query}".`
              : "There are no saved proposals to change yet — create one first.",
          },
        };

      const selection: ProposalSelection = {
        ...defaultSelection(),
        ...(row.selection as unknown as ProposalSelection),
      };
      const content: ProposalContent = {
        ...defaultContent(),
        ...(row.content as unknown as ProposalContent),
      };

      // ---- What is being sold: the line items -----------------------------
      const replaceItems = Array.isArray(args.items) ? args.items : null;
      const addLines = Array.isArray(args.add_line_items) ? args.add_line_items : null;
      const dropLines = strings(args.remove_line_items).map((s) => s.toLowerCase());
      const repriceLines = Array.isArray(args.reprice_line_items)
        ? args.reprice_line_items
        : null;
      const orderLines = strings(args.reorder_line_items).map((s) => s.toLowerCase());
      // Adding or removing a package changes the SCOPE, which makes the
      // existing copy describe the wrong deal — repricing and reordering do
      // not, and must not throw away wording the team may have edited.
      const scopeChanged = Boolean(
        replaceItems?.length || addLines?.length || dropLines.length,
      );
      const wantsItemOps = Boolean(
        scopeChanged || repriceLines?.length || orderLines.length,
      );

      if (wantsItemOps) {
        const catalog = await pricingSnapshot(supabase);

        if (replaceItems?.length) {
          const parsed = parseLineItems(catalog, replaceItems);
          if (parsed.errors.length)
            return {
              content: {
                ok: false,
                error: "Some of those lines couldn't be priced, so nothing was changed.",
                problems: parsed.errors,
                ask: "Call get_pricing and use the price_key exactly as it comes back, or give the line a name and the price the user stated.",
              },
            };
          selection.items = parsed.items;
          clearLegacyPackage(selection);
        } else if (addLines?.length) {
          // Adding a second package to a proposal written as one package: the
          // existing package becomes a line of its own first, printing exactly
          // what it prints today, so nothing on the document moves.
          materializeLegacyPackage(selection);
        }

        if (!hasItems(selection))
          return {
            content: {
              ok: false,
              error:
                "This proposal is written as a single package, so it has no separate lines to remove, reprice or reorder.",
              ask: "Change the package itself with tier / platform / agent_platform and its price with package_price — or pass a full `items` list to rebuild the proposal line by line.",
            },
          };

        if (addLines?.length) {
          const parsed = parseLineItems(
            catalog,
            addLines,
            new Set((selection.items ?? []).map((i) => i.id)),
          );
          if (parsed.errors.length)
            return {
              content: {
                ok: false,
                error: "Some of those lines couldn't be priced, so nothing was changed.",
                problems: parsed.errors,
                ask: "Call get_pricing and use the price_key exactly as it comes back, or give the line a name and the price the user stated.",
              },
            };
          selection.items = [...(selection.items ?? []), ...parsed.items];
        }

        if (dropLines.length) {
          const before = (selection.items ?? []).length;
          selection.items = (selection.items ?? []).filter(
            (i) => !matchesLine(i, dropLines),
          );
          // Reporting "removed" for a name that matched nothing would leave
          // the user believing a package is off the proposal when it is still
          // on it — and still in the total.
          if (selection.items.length === before)
            return {
              content: {
                ok: false,
                error: "Nothing on this proposal matches what you asked to remove, so nothing was changed.",
                lines: selection.items.map((i) => ({ id: i.id, label: i.label })),
                ask: "Name the line by its printed label or its id, exactly as listed here.",
              },
            };
        }

        const repriceProblems: string[] = [];
        for (const raw of repriceLines ?? []) {
          const o = (raw ?? {}) as Record<string, unknown>;
          const needle = String(o.match ?? "").trim().toLowerCase();
          if (!needle) {
            repriceProblems.push("A reprice entry had no `match` naming which line it means.");
            continue;
          }
          const target = (selection.items ?? []).find((i) => matchesLine(i, [needle]));
          if (!target) {
            repriceProblems.push(`No line on this proposal matches "${o.match}".`);
            continue;
          }
          const price = dictated(o.price);
          if (price !== null) {
            // The figure the user states is the figure. When it comes in under
            // what the line was listed at, the original is remembered so the
            // reduction prints struck through instead of quietly vanishing.
            const wasList =
              typeof target.listAmount === "number" ? target.listAmount : target.amount;
            target.amount = price;
            if (wasList > price) target.listAmount = wasList;
            else delete target.listAmount;
            // An agreed figure is no longer a "from" floor.
            target.startsAt = false;
          }
          const list = dictated(o.list_price);
          if (list !== null) {
            if (list > target.amount) target.listAmount = list;
            else delete target.listAmount;
          }
          const q = dictated(o.quantity);
          if (q !== null && q > 0) target.quantity = q;
          const lineNote = String(o.note ?? "").trim();
          if (lineNote) target.note = lineNote;
          if (o.hide_original === true) delete target.listAmount;
        }
        if (repriceProblems.length)
          return {
            content: {
              ok: false,
              error: "Nothing was changed — those lines couldn't be found.",
              problems: repriceProblems,
              lines: (selection.items ?? []).map((i) => ({ id: i.id, label: i.label })),
              ask: "Match a line by its id or its printed label, exactly as listed here.",
            },
          };

        if (orderLines.length) {
          const rest = [...(selection.items ?? [])];
          const ordered: ProposalLineItem[] = [];
          for (const n of orderLines) {
            const at = rest.findIndex((i) => matchesLine(i, [n]));
            if (at >= 0) ordered.push(...rest.splice(at, 1));
          }
          if (!ordered.length)
            return {
              content: {
                ok: false,
                error: "None of those names match a line on this proposal, so the order was left alone.",
                lines: rest.map((i) => ({ id: i.id, label: i.label })),
                ask: "Name the lines by their printed labels or ids, exactly as listed here, in the order they should print.",
              },
            };
          // Anything the user didn't name keeps its place behind the ones
          // they did — a partial order is not a licence to drop lines.
          selection.items = [...ordered, ...rest];
        }

        if (!selection.items?.length)
          return {
            content: {
              ok: false,
              error:
                "That would leave the proposal with nothing on it. Nothing was changed.",
              ask: "Ask the user what the client is actually buying before removing the last line.",
            },
          };
      }

      const itemDriven = hasItems(selection);
      const newNotes = strings(args.notes).slice(0, 6);
      if (itemDriven && newNotes.length) selection.notes = newNotes;

      // A proposal that prices each thing on its own line has no single
      // package to switch and no single price to set. Saying so beats
      // dropping a figure the user actually stated.
      if (
        itemDriven &&
        (String(args.project_type ?? "").trim() ||
          String(args.tier ?? "").trim() ||
          String(args.platform ?? "").trim() ||
          String(args.agent_platform ?? "").trim() ||
          dictated(args.package_price) !== null ||
          dictated(args.list_price) !== null ||
          args.hide_original === true ||
          String(args.price_note ?? "").trim())
      )
        return {
          content: {
            ok: false,
            error:
              "This proposal lists each thing being sold on its own line, so there is no single package or package price to change.",
            lines: (selection.items ?? []).map((i) => ({
              id: i.id,
              label: i.label,
              amount: i.amount,
              recurrence: i.recurrence,
            })),
            ask: "Use reprice_line_items to change what a line costs, add_line_items / remove_line_items to change what's on it, or items to rebuild the whole list.",
          },
        };

      const packageChanged = itemDriven ? false : applyPackage(selection, args);

      const maintenance = String(args.maintenance ?? "");
      const maintenanceChanged =
        ["none", "m3", "m6", "m12"].includes(maintenance) &&
        maintenance !== selection.maintenance;
      if (maintenanceChanged)
        selection.maintenance = maintenance as ProposalSelection["maintenance"];

      const seoChanged =
        typeof args.monthly_seo === "boolean" && args.monthly_seo !== selection.monthlySeo;
      if (seoChanged) selection.monthlySeo = args.monthly_seo === true;

      // Whatever they just switched to has no agreed price yet, so pull today's
      // figure for it. Anything they didn't touch keeps the price this proposal
      // was written with.
      if (packageChanged || maintenanceChanged || seoChanged) {
        const fresh = await resolveSelectionPrices(supabase, selection);
        const prices = { ...(selection.prices ?? {}) };
        if (packageChanged) {
          prices.base = fresh.base;
          prices.baseList = fresh.base ?? catalogBasePrice(selection);
        }
        if (maintenanceChanged) prices.maintenance = fresh.maintenance;
        if (seoChanged) prices.monthlySeo = fresh.monthlySeo;
        selection.prices = prices;
      }

      const drop = strings(args.remove_items).map((r) => r.toLowerCase());
      if (drop.length) {
        selection.customFeatures = (selection.customFeatures ?? []).filter((f) => {
          const label = f.name.toLowerCase();
          return !drop.some((r) => label.includes(r) || r.includes(label));
        });
      }
      const added = customItems(args.add_items);
      if (added.length)
        selection.customFeatures = [...(selection.customFeatures ?? []), ...added];

      const newBase = dictated(args.package_price);
      const newList = dictated(args.list_price);
      const newMaint = dictated(args.maintenance_price);
      const newSeo = dictated(args.monthly_seo_price);
      if (
        newBase !== null ||
        newList !== null ||
        newMaint !== null ||
        newSeo !== null ||
        args.hide_original === true
      ) {
        const prices = { ...(selection.prices ?? {}) };
        if (newBase !== null) {
          prices.base = newBase;
          // Proposals written before list prices were tracked carry none, so
          // fall back to the catalog and the reduction still shows.
          if (typeof prices.baseList !== "number")
            prices.baseList = catalogBasePrice(selection);
        }
        if (newList !== null) prices.baseList = newList;
        if (newMaint !== null) prices.maintenance = newMaint;
        if (newSeo !== null) prices.monthlySeo = newSeo;
        if (args.hide_original === true) delete prices.baseList;
        selection.prices = prices;
      }
      const priceNote = String(args.price_note ?? "").trim();
      if (priceNote) selection.baseNote = priceNote;

      const pricing = buildPricing(selection);
      const wrongWay =
        pricing.oneTimeTotal < 0
          ? { what: "one-time total", amount: pricing.oneTimeTotal }
          : (pricing.monthlyTotal ?? 0) < 0
            ? { what: "monthly total", amount: pricing.monthlyTotal ?? 0 }
            : (pricing.yearlyTotal ?? 0) < 0
              ? { what: "yearly total", amount: pricing.yearlyTotal ?? 0 }
              : null;
      if (wrongWay)
        return {
          content: {
            ok: false,
            error: `That would come to a ${wrongWay.what} of ${money(wrongWay.amount)} — the discount is larger than everything it's being taken off. Nothing was changed; check the figures with the user.`,
          },
        };

      const clientName = String(args.client_name ?? "").trim() || row.client_name;
      const projectName = String(args.project_name ?? "").trim() || row.project_name;
      const proposalDate =
        typeof args.proposal_date === "string" && args.proposal_date.trim()
          ? args.proposal_date.trim()
          : row.proposal_date;

      // Swapping the package makes the old copy wrong — it talks about pages,
      // SEO or an agent the client is no longer buying — so a package change
      // always rewrites, whether or not the model thought to ask for it.
      let next = content;
      if (args.rewrite === true || packageChanged || scopeChanged) {
        const instructions = String(args.instructions ?? "").trim();
        const requirements = strings(args.requirements).slice(0, 25);
        const description = content.overview.trim();
        if (
          !description &&
          !instructions &&
          !requirements.length &&
          !packageChanged &&
          !scopeChanged
        )
          return {
            content: {
              ok: false,
              error: "There's nothing to rewrite from.",
              ask: "Ask the user what should change about the wording, or what else the client told them, before rewriting.",
            },
          };
        const shape = narrativeShape(selection, args.free_form);
        const narrative = await generateProposalContent({
          businessDescription: description || `${clientName} — ${projectName}`,
          clientName,
          projectName,
          selectionSummary: selectionSummary(selection),
          includedFeatures: includedFeatures(selection),
          customFeatures: selection.customFeatures,
          requirements,
          teamInstructions: instructions || undefined,
          projectKind: shape.projectKind,
          packages: shape.packages,
          allowFreeSections: shape.allowFreeSections,
        });
        const rewritten: ProposalContent = {
          ...content,
          // The agent timeline and the website timeline describe different
          // work, so a switch in either direction has to swap it back.
          ...(packageChanged || scopeChanged
            ? {
                timeline:
                  shape.projectKind === "agent"
                    ? AGENT_TIMELINE
                    : defaultContent().timeline,
              }
            : {}),
          ...narrative,
        };
        // A rewrite replaces the WHOLE narrative. If the new one came back as
        // the fixed skeleton, the sections the old one composed have to go
        // with it — left behind they are what the PDF would print, and the
        // rewrite the user just asked for would be invisible.
        if (!narrative.sections) {
          delete rewritten.sections;
          delete rewritten.sectionsMode;
        }
        next = rewritten;
      }

      // Drop a written section by name, without rewriting the rest.
      const dropSections = strings(args.remove_sections).map((s) => s.toLowerCase());
      if (dropSections.length && Array.isArray(next.sections) && next.sections.length) {
        const kept = next.sections.filter((s) => {
          const hay = [s.id ?? "", s.heading ?? ""]
            .map((v) => String(v).toLowerCase().trim())
            .filter(Boolean);
          return !dropSections.some((n) => hay.some((h) => h.includes(n) || n.includes(h)));
        });
        if (!kept.length)
          return {
            content: {
              ok: false,
              error:
                "That would remove every written section and leave the proposal with only its pricing table. Nothing was changed.",
              sections: next.sections.map((s) => s.heading),
              ask: "Name only the sections to drop, or rewrite the proposal instead.",
            },
          };
        next = { ...next, sections: kept };
      }

      const { error } = await supabase
        .from("proposals")
        .update({
          client_name: clientName,
          project_name: projectName,
          proposal_date: proposalDate,
          selection: selection as unknown as Record<string, unknown>,
          content: next as unknown as Record<string, unknown>,
          grand_total: pricing.oneTimeTotal,
        })
        .eq("id", row.id);
      if (error)
        return { content: { ok: false, error: error.message } };

      const card = proposalCard({
        id: row.id,
        client_name: clientName,
        project_name: projectName,
        proposal_date: proposalDate,
        selection,
        content: next,
      });

      return {
        content: {
          ok: true,
          proposal_id: row.id,
          client: clientName,
          project: projectName,
          package: card.package_summary,
          line_items: spokenLines(pricing),
          grand_total: card.grand_total,
          one_time_total: pricing.oneTimeTotal,
          monthly_total: pricing.monthlyTotal ?? 0,
          yearly_total: pricing.yearlyTotal ?? 0,
          recurring_notes: card.recurring_notes,
          currency: "LKR",
          note: "The same proposal was updated and shown to the user again. Confirm what changed and read back the new one-time total — and, when monthly_total is above zero, the monthly figure SEPARATELY. The two are never added together.",
        },
        event: {
          kind: "updated",
          label: `Proposal — ${clientName}`,
          href: "/proposals",
        },
        card: { type: "proposal", proposal: card },
      };
    }

    default:
      return { content: { ok: false, error: `Unknown tool: ${name}` } };
  }
}
