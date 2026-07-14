import type { Database } from "@/lib/database.types";
import type { ProposalSelection, ProposalContent } from "@/lib/proposal";

type Tables = Database["public"]["Tables"];

export type Profile = Tables["profiles"]["Row"];
export type Invitation = Tables["invitations"]["Row"];
export type Client = Tables["clients"]["Row"];
export type Todo = Tables["todos"]["Row"];
export type TodoMention = Tables["todo_mentions"]["Row"];
export type TodoSubtask = Tables["todo_subtasks"]["Row"];
export type Project = Tables["projects"]["Row"] & {
  total_value?: number;
  deposit_paid?: number;
  share_token?: string;
  service_type?: string | null;
};
export type ProjectDocumentRequest = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: "pending" | "submitted";
  file_url: string | null;
  file_name: string | null;
  submitted_at: string | null;
  created_at: string;
};
export type Proposal = Omit<
  Tables["proposals"]["Row"],
  "selection" | "content"
> & {
  selection: ProposalSelection;
  content: ProposalContent;
};
export type Payment = Tables["payments"]["Row"];
export type Invoice = Tables["invoices"]["Row"];
export type CompanyPayment = Tables["company_payments"]["Row"];
export type Commission = Tables["commissions"]["Row"];
export type Resource = Tables["resources"]["Row"];
export type MeetingLink = Tables["meeting_links"]["Row"];
export type MeetingBooking = Tables["meeting_bookings"]["Row"];
export type Meeting = Tables["meetings"]["Row"];
export type MeetingAttendee = Tables["meeting_attendees"]["Row"];
/** A scheduled meeting plus the ids of its assigned members. */
export type MeetingWithAttendees = Meeting & { attendee_ids: string[] };
export type Pipeline = Tables["pipelines"]["Row"];
export type PipelineStage = Tables["pipeline_stages"]["Row"];
export type Lead = Tables["leads"]["Row"];
export type Notification = Tables["notifications"]["Row"];
/** The columns the notification dropdown/list UIs actually render. */
export type NotificationLite = Pick<
  Notification,
  "id" | "type" | "title" | "body" | "link" | "read" | "created_at"
>;
export type ContentReference = Tables["content_references"]["Row"];
export type ContentGeneration = Tables["content_generations"]["Row"];
export type CarouselPost = Tables["carousel_posts"]["Row"];
export type CarouselOption = Tables["carousel_options"]["Row"];
export type WebsiteProject = Tables["website_projects"]["Row"];
export type SmsMessage = Tables["sms_messages"]["Row"];
export type WaContact = Tables["wa_contacts"]["Row"];
export type WaMessage = Tables["wa_messages"]["Row"];
export type WaAgentConfig = Tables["wa_agent_config"]["Row"];
export type WaKeywordRule = Tables["wa_keyword_rules"]["Row"];
export type WaAgentLog = Tables["wa_agent_logs"]["Row"];
export type WaPromise = Tables["wa_promises"]["Row"];
export type WaShowcase = Tables["wa_showcases"]["Row"];
export type ProspectScanSchedule = Tables["prospect_scan_schedules"]["Row"];
export type WaCoaching = Tables["wa_coaching"]["Row"];
export type SmsWorkflow = Tables["sms_workflows"]["Row"];
export type SmsWorkflowStep = Tables["sms_workflow_steps"]["Row"];
export type SmsWorkflowRun = Tables["sms_workflow_runs"]["Row"];
export type Company = Tables["companies"]["Row"];
export type CrmField = Tables["crm_fields"]["Row"];
export type CrmSegment = Tables["crm_segments"]["Row"];
export type LeadActivity = Tables["lead_activities"]["Row"];
export type LeadOutreach = Tables["lead_outreach"]["Row"];
export type OutreachCampaign = Tables["outreach_campaigns"]["Row"];
export type CrmTask = Tables["crm_tasks"]["Row"];
export type Quote = Tables["quotes"]["Row"];
export type Automation = Tables["automations"]["Row"];
export type AutomationStep = Tables["automation_steps"]["Row"];
export type AutomationRun = Tables["automation_runs"]["Row"];
export type WebhookEndpoint = Tables["webhook_endpoints"]["Row"];
export type ApiKey = Tables["api_keys"]["Row"];
export type PaymentPlan = Tables["payment_plans"]["Row"];
export type PaymentInstallment = Tables["payment_installments"]["Row"];
export type Cheque = Tables["cheques"]["Row"];
export type Expense = Tables["expenses"]["Row"];
export type AiDigest = Tables["ai_digests"]["Row"];
export type ChurnAlert = Tables["churn_alerts"]["Row"];
export type Competitor = Tables["competitors"]["Row"];
export type CompetitorEntry = Tables["competitor_entries"]["Row"];
export type AdEntry = Tables["ad_entries"]["Row"];
export type VisitorEvent = Tables["visitor_events"]["Row"];
export type LeadResearch = Tables["lead_research"]["Row"];
export type ProspectScan = Tables["prospect_scans"]["Row"];
export type ProspectCandidate = Tables["prospect_candidates"]["Row"];

export type {
  UserRole,
  TodoPriority,
  TodoStatus,
  ProjectStatus,
  PaymentStatus,
  WebsiteStatus,
  CommissionStatus,
  ClientStatus,
  ResourceKind,
  InviteStatus,
  BookingStatus,
  MeetingLocationType,
  MeetingAttendance,
  NotificationType,
  SmsKind,
  SmsStatus,
  SmsStepKind,
  SmsRunStatus,
  CrmFieldKind,
  LeadActivityKind,
  CrmTaskStatus,
  LeadStatus,
  LeadScore,
  QuoteStatus,
  AutomationTrigger,
  AutomationStepKind,
  AutomationRunStatus,
  WebhookAction,
  PaymentPlanStatus,
  InstallmentStatus,
  ChequeDirection,
  ChequeStatus,
  ExpenseCategory,
  ChurnSeverity,
  ChurnStatus,
  ProspectScanStatus,
  ProspectVerdict,
  CarouselPostStatus,
  CarouselSlide,
  ProspectCandidateStatus,
  CompetitorEntryKind,
  AdPlatform,
  VisitorEventKind,
  LeadResearchStatus,
  WaDirection,
  WaMessageStatus,
  WaSentBy,
  WaMatchType,
  WaShowcaseStatus,
  WaVoiceReplies,
} from "@/lib/database.types";

/** A todo joined with the profile it's assigned to. */
export type TodoWithRelations = Todo & {
  assignee?: Pick<Profile, "id" | "full_name" | "username" | "avatar_url"> | null;
  creator?: Pick<Profile, "id" | "full_name" | "username" | "avatar_url"> | null;
  mentions?: Pick<Profile, "id" | "full_name" | "username" | "avatar_url">[];
  project?: Pick<Project, "id" | "name"> | null;
  subtasks?: TodoSubtask[];
};

export type LeadWithAssignee = Lead & {
  assignee?: Pick<Profile, "id" | "full_name" | "username" | "avatar_url"> | null;
};

export type ProjectWithClient = Project & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
  payments?: Payment[];
};

export type CommissionWithContext = Commission & {
  project?: Pick<Project, "id" | "name"> | null;
  recipient?: Pick<Profile, "id" | "full_name" | "username"> | null;
};

/** Standard return shape for server actions called from the client. */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Minimal member shape used in pickers / mentions / avatars. */
export type MemberLite = Pick<
  Profile,
  "id" | "full_name" | "username" | "avatar_url" | "role"
>;
