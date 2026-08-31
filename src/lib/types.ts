import type { Database } from "@/lib/database.types";
import type { ProposalSelection, ProposalContent } from "@/lib/proposal";

type Tables = Database["public"]["Tables"];

export type Profile = Tables["profiles"]["Row"];
export type Invitation = Tables["invitations"]["Row"];
export type TrustedDevice = Tables["trusted_devices"]["Row"];
export type DeviceGrace = Tables["device_grace"]["Row"];
export type LoginSession = Tables["login_sessions"]["Row"];
export type MemberChange = Tables["member_changes"]["Row"];
export type Client = Tables["clients"]["Row"];
export type Todo = Tables["todos"]["Row"];
export type TodoMention = Tables["todo_mentions"]["Row"];
export type TodoSubtask = Tables["todo_subtasks"]["Row"];
// 0084 backfilled the Row type with every column (0016 portal, 0083 docs,
// 0084 delivery), so the optional patch-object this used to carry is gone.
export type Project = Tables["projects"]["Row"];
export type ProjectDocumentRequest =
  Tables["project_document_requests"]["Row"];
export type ProjectExpense = Tables["project_expenses"]["Row"];
export type ProjectTemplate = Tables["project_templates"]["Row"];
/** 0097 — a saved set of board filters (VIEW-2). */
export type ProjectSavedView = Tables["project_views"]["Row"];
/** 0098 — what a finished project taught us (AI-6). */
export type ProjectLesson = Tables["project_lessons"]["Row"];
/** 0098 — a rule-based duplicate/anomaly flag (AI-9). */
export type ProjectAnomaly = Tables["project_anomalies"]["Row"];
/** 0100 — a standing monthly income arrangement. */
export type RecurringIncome = Tables["recurring_income"]["Row"];
/** 0100 — one month of a recurring arrangement. */
export type RecurringIncomeEntry = Tables["recurring_income_entries"]["Row"];
export type ProjectTemplateItem = Tables["project_template_items"]["Row"];
export type ProjectMilestone = Tables["project_milestones"]["Row"];
export type ProjectMember = Tables["project_members"]["Row"];
export type TimeEntry = Tables["time_entries"]["Row"];
export type ProjectReview = Tables["project_reviews"]["Row"];
export type ProjectApproval = Tables["project_approvals"]["Row"];
export type ProjectChangeRequest = Tables["project_change_requests"]["Row"];
export type ProjectComment = Tables["project_comments"]["Row"];
export type ProjectPulse = Tables["project_pulses"]["Row"];
export type DeliverySettings = Tables["delivery_settings"]["Row"];
export type DeliveryEvent = Tables["delivery_events"]["Row"];
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
export type MemberLoan = Tables["member_loans"]["Row"];
export type MemberLoanRepayment = Tables["member_loan_repayments"]["Row"];
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
export type WaColdOutreach = Tables["wa_cold_outreach"]["Row"];
export type WaCampaign = Tables["wa_campaigns"]["Row"];
export type ProspectScanSchedule = Tables["prospect_scan_schedules"]["Row"];
export type WaCoaching = Tables["wa_coaching"]["Row"];
export type WaConvoInsight = Tables["wa_convo_insights"]["Row"];
export type WaLesson = Tables["wa_lessons"]["Row"];
export type WaRevival = Tables["wa_revival"]["Row"];
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

// 0105 — Web Analytics: www.arcai.agency, mirrored from the website's own
// Supabase project. Separate from VisitorEvent above, which is the in-app
// snippet for client sites.
export type WebSession = Tables["web_sessions"]["Row"];
export type WebEvent = Tables["web_events"]["Row"];
export type WebDaily = Tables["web_daily"]["Row"];
export type WebPageDaily = Tables["web_page_daily"]["Row"];
export type WebJourney = Tables["web_journeys"]["Row"];
export type WebChatSession = Tables["web_chat_sessions"]["Row"];
export type WebChatMessage = Tables["web_chat_messages"]["Row"];
export type WebReport = Tables["web_reports"]["Row"];
export type WebSyncState = Tables["web_sync_state"]["Row"];
export type WebSyncRun = Tables["web_sync_runs"]["Row"];

// 0106 — Careers: hiring for the agency's own site, run from the CRM.
export type CareerVacancy = Tables["careers_vacancies"]["Row"];
export type CareerApplication = Tables["careers_applications"]["Row"];
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
  MemberLoanStatus,
  MemberLoanApproval,
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
  WebChannel,
  WebDeviceType,
  WebJourneyKind,
  WebReportKind,
  VacancyStatus,
  ApplicationStage,
  LeadResearchStatus,
  WaDirection,
  WaMessageStatus,
  WaSentBy,
  WaMatchType,
  WaShowcaseStatus,
  WaVoiceReplies,
  WaCampaignStatus,
  DeliveryStage,
  AssetCategory,
  // 0098 — Projects theme 5 (AI)
  ProjectLessonCategory,
  ProjectLessonStatus,
  ProjectAnomalyKind,
  ProjectAnomalyStatus,
  // 0100
  RecurringIncomeCategory,
  RecurringIncomeStatus,
  AssetRequestStatus,
  AssetRequestSource,
  DeliveryEventKind,
  WaContactMode,
  CommissionBasis,
  TemplateItemKind,
  MilestoneKind,
  MilestoneStatus,
  PortalLanguage,
  ReviewStatus,
  ApprovalStatus,
  ChangeRequestStatus,
  ChangeRequestSource,
  CommentAuthor,
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
