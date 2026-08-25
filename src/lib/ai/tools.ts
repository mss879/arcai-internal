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
import { DELIVERY_STAGES } from "@/lib/constants";
import { topLeadPosition } from "@/lib/crm";
import { nextInvoiceNumber } from "@/lib/invoice";
import { formatPriceField } from "@/lib/pricing-catalog";
import {
  AGENT_TIMELINE,
  buildPricing,
  catalogBasePrice,
  defaultContent,
  defaultSelection,
  includedFeatures,
  money,
  selectionSummary,
  suggestedProjectName,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";
import {
  pricingSnapshot,
  resolveSelectionPrices,
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
        "List company payments from the Payments page — what clients/companies owe. Defaults to outstanding (unpaid) payments only. Use this to find how much a client still owes, e.g. before sending a payment reminder.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Filter by client / company name.",
          },
          include_paid: {
            type: "boolean",
            description: "Set true to also include payments already marked paid.",
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
        "Write and save a full client proposal — the narrative is generated by AI around what the client actually asked for, and the pricing is built from the package plus anything the user adds or changes. The saved proposal appears under Proposals and is shown to the user as a card with a PDF download. IMPORTANT: never guess your way into this tool. If you do not know the client's name, which package they want, or enough about their business to describe it in two sentences, ASK the user first — a proposal built on assumptions is worse than no proposal. The tool will tell you what is missing if you call it early.",
      parameters: {
        type: "object",
        properties: {
          client_name: {
            type: "string",
            description: "The client or company the proposal is for.",
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
              "What the client is buying: a business website, an e-commerce store, or a standalone AI agent + CRM with no website build.",
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
              "What the client is actually being charged for the main package, in LKR — for THIS proposal only. Use it whenever the user names a figure ('the package is 175,000 but I gave them 140,000' means package_price is 140000). Pass exactly what they said — never round it, never check it against the price list. Omit to charge the current Pricing page amount.",
          },
          list_price: {
            type: "number",
            description:
              "The package's NORMAL price, when it differs from what's being charged. You rarely need this: the list price is taken from the Pricing page automatically, and whenever package_price is lower the proposal prints the normal price struck through next to the offer price, so the client sees exactly what they were given off. Only pass it when the user states an original that is NOT the Pricing page figure.",
          },
          hide_original: {
            type: "boolean",
            description:
              "Set true only if the user explicitly wants just the one price shown, with no struck-through original.",
          },
          price_note: {
            type: "string",
            description:
              "Short note printed next to the package line when the price was negotiated, e.g. 'agreed rate' or 'launch offer'. Only when the user asks for one.",
          },
          custom_items: {
            type: "array",
            description:
              "Extra priced lines on top of the package — features the client wants that are not in it, or a DISCOUNT as a negative amount (e.g. name 'Introductory discount', price -25000).",
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
        required: ["client_name", "project_type", "business_description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_proposal",
      description:
        "Change a proposal that already exists — the price, the package, the extra line items, the client details, or the written narrative. Use this for every follow-up change ('make it three hundred thousand', 'add live chat for forty thousand', 'give them a discount', 'rewrite it warmer'). Never create a second proposal for the same client when they are asking you to change the first one. The updated proposal is shown to the user again as a card.",
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
          project_type: {
            type: "string",
            enum: ["business", "ecommerce", "agent"],
            description: "Switch what they're buying. Only pass it if the package itself is changing.",
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
              "New price for the main package line, in LKR, exactly as the user said it. If it comes in under the normal price, the proposal automatically prints the original struck through next to it. Pass 0 or less only if they genuinely want the package free.",
          },
          list_price: {
            type: "number",
            description:
              "The package's normal price, when the user states an original that isn't the Pricing page figure. Usually unnecessary.",
          },
          hide_original: {
            type: "boolean",
            description:
              "Set true only if the user explicitly wants the struck-through original removed, leaving one price.",
          },
          price_note: {
            type: "string",
            description: "Short note next to the package line, e.g. 'agreed rate'.",
          },
          add_items: {
            type: "array",
            description:
              "Priced lines to ADD. A discount is a negative amount, e.g. name 'Loyalty discount', price -30000.",
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
              "Labels of existing extra lines to remove — a close match is enough, e.g. 'live chat'.",
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
      let q = supabase
        .from("projects")
        .select("id, name, status, budget, currency, due_date")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(25);
      if (args.status) q = q.eq("status", args.status as ProjectStatus);
      const { data } = await q;
      return {
        content: {
          projects: (data ?? []).map((p) => ({
            name: p.name,
            status: p.status,
            budget: p.budget,
            currency: p.currency,
            due: fmtDateTime(p.due_date),
          })),
        },
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
      let q = supabase
        .from("company_payments")
        .select("company_name, price_lkr, status, is_paid")
        .order("created_at", { ascending: false })
        .limit(25);
      if (!args.include_paid) q = q.eq("is_paid", false);
      if (args.query) {
        q = q.ilike("company_name", `%${String(args.query)}%`);
      }
      const { data } = await q;
      return {
        content: {
          payments: (data ?? []).map((p) => ({
            company: p.company_name,
            amount: Number(p.price_lkr),
            currency: "LKR",
            status: p.status,
            paid: p.is_paid,
          })),
        },
        event: { kind: "read", label: "Looked up payments", href: "/payments" },
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
      const shaped = groups.map((g) => ({
        group: g.title,
        about: g.subtitle ?? "",
        packages: g.packages.map((p) => ({
          name: p.name,
          tagline: p.tagline ?? "",
          badge: p.badge ?? "",
          includes: p.features ?? [],
          prices: p.prices.map((f) => ({
            label: f.label,
            amount: f.amount,
            currency: f.currency ?? "LKR",
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
        },
        event: { kind: "read", label: "Checked pricing", href: "/pricing" },
      };
    }

    case "create_proposal": {
      const clientName = String(args.client_name ?? "").trim();
      const type = String(args.project_type ?? "").trim();
      const description = String(args.business_description ?? "").trim();

      // Rather than inventing the gaps, hand them back so the model asks.
      const missing: string[] = [];
      if (!clientName) missing.push("who the proposal is for — the client or company name");
      if (!["business", "ecommerce", "agent"].includes(type))
        missing.push(
          "what they're buying — a business website, an e-commerce store, or a standalone AI agent with CRM",
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

      // Start from what the team charges today, then let anything the user
      // dictated override it — and freeze the result onto this proposal so it
      // never re-prices when the Pricing page is edited later.
      selection.prices = await resolveSelectionPrices(supabase, selection);
      // Remember what the package normally goes for BEFORE any offer price is
      // applied, so a reduction prints as the list price struck through next
      // to what the client is actually paying.
      selection.prices.baseList =
        dictated(args.list_price) ??
        selection.prices.base ??
        catalogBasePrice(selection);
      const base = dictated(args.package_price);
      if (base !== null) selection.prices.base = base;
      if (args.hide_original === true) delete selection.prices.baseList;
      const maint = dictated(args.maintenance_price);
      if (maint !== null) selection.prices.maintenance = maint;
      const seo = dictated(args.monthly_seo_price);
      if (seo !== null) selection.prices.monthlySeo = seo;
      const priceNote = String(args.price_note ?? "").trim();
      if (priceNote) selection.baseNote = priceNote;

      const pricing = buildPricing(selection);
      if (pricing.oneTimeTotal < 0)
        return {
          content: {
            ok: false,
            error: `That works out to ${money(pricing.oneTimeTotal)} — the discount is larger than everything it's being taken off. Check the figures with the user before saving.`,
          },
        };

      const projectName =
        String(args.project_name ?? "").trim() || suggestedProjectName(selection);
      const instructions = String(args.instructions ?? "").trim();

      const narrative = await generateProposalContent({
        businessDescription: description,
        clientName,
        projectName,
        selectionSummary: selectionSummary(selection),
        includedFeatures: includedFeatures(selection),
        customFeatures: selection.customFeatures,
        requirements: strings(args.requirements).slice(0, 25),
        teamInstructions: instructions || undefined,
        projectKind: selection.type === "agent" ? "agent" : "website",
      });

      const proposalDate =
        typeof args.proposal_date === "string" && args.proposal_date.trim()
          ? args.proposal_date.trim()
          : today;

      const content: ProposalContent = {
        ...defaultContent(),
        // The stock timeline talks pages and design — wrong for an agent-only
        // deployment, which builds nothing of the sort.
        ...(selection.type === "agent" ? { timeline: AGENT_TIMELINE } : {}),
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
          line_items: card.line_items,
          grand_total: card.grand_total,
          recurring_notes: card.recurring_notes,
          currency: "LKR",
          note: "Saved under Proposals and shown to the user for review. Read back the client, the package and the total. To change anything, call update_proposal — never create a second proposal for the same client.",
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

      const packageChanged = applyPackage(selection, args);

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
      if (pricing.oneTimeTotal < 0)
        return {
          content: {
            ok: false,
            error: `That would come to ${money(pricing.oneTimeTotal)} — the discount is larger than everything it's being taken off. Nothing was changed; check the figures with the user.`,
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
      if (args.rewrite === true || packageChanged) {
        const instructions = String(args.instructions ?? "").trim();
        const requirements = strings(args.requirements).slice(0, 25);
        const description = content.overview.trim();
        if (!description && !instructions && !requirements.length && !packageChanged)
          return {
            content: {
              ok: false,
              error: "There's nothing to rewrite from.",
              ask: "Ask the user what should change about the wording, or what else the client told them, before rewriting.",
            },
          };
        const narrative = await generateProposalContent({
          businessDescription: description || `${clientName} — ${projectName}`,
          clientName,
          projectName,
          selectionSummary: selectionSummary(selection),
          includedFeatures: includedFeatures(selection),
          customFeatures: selection.customFeatures,
          requirements,
          teamInstructions: instructions || undefined,
          projectKind: selection.type === "agent" ? "agent" : "website",
        });
        next = {
          ...content,
          // The agent timeline and the website timeline describe different
          // work, so a switch in either direction has to swap it back.
          ...(packageChanged
            ? {
                timeline:
                  selection.type === "agent"
                    ? AGENT_TIMELINE
                    : defaultContent().timeline,
              }
            : {}),
          ...narrative,
        };
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
          line_items: card.line_items,
          grand_total: card.grand_total,
          recurring_notes: card.recurring_notes,
          currency: "LKR",
          note: "The same proposal was updated and shown to the user again. Confirm what changed and read back the new total.",
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
