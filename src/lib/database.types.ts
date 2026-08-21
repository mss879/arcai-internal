/**
 * Hand-authored database types.
 *
 * Keep this in sync with the SQL migrations in `supabase/migrations`.
 * After you run the migrations you can replace this file with the
 * auto-generated types via:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */

type Timestamp = string;
type UUID = string;

export type UserRole = "admin" | "member";
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type ClientStatus = "active" | "lead" | "inactive";
export type TodoPriority = "low" | "medium" | "high" | "urgent";
export type TodoStatus = "todo" | "in_progress" | "done";
export type ProjectStatus =
  | "planning"
  | "active"
  | "on_hold"
  | "completed"
  | "cancelled";
export type PaymentStatus = "pending" | "paid" | "overdue";
export type WebsiteStatus = "in_progress" | "waiting_client" | "launched";
export type CommissionStatus = "pending" | "approved" | "paid";
export type ResourceKind = "file" | "link";
export type BookingStatus = "confirmed" | "cancelled";
export type NotificationType =
  | "mention"
  | "assignment"
  | "commission"
  | "system";
export type SmsKind =
  | "custom"
  | "payment_reminder"
  | "automation"
  | "promotion"
  | "todo_reminder"
  | "meeting_reminder"
  | "prospecting"
  | "team_alert";
/** "Find Leads" prospecting scan pipeline (0044). */
export type ProspectScanStatus =
  | "pending"
  | "searching"
  | "qualifying"
  | "drafting"
  | "importing"
  | "done"
  | "error";
export type ProspectVerdict =
  | "pending"
  | "no_website"
  | "facebook_only"
  | "bad_website"
  | "broken"
  | "good_website"
  | "excluded"
  | "duplicate"
  | "unverified";
export type ProspectCandidateStatus =
  | "pending"
  | "qualified"
  | "skipped"
  | "imported"
  | "emailed";
/** Where a scheduled meeting happens (0042). */
export type MeetingLocationType = "online" | "in_person";
/** An attendee's answer to the post-meeting "did you attend?" prompt (0043). */
export type MeetingAttendance = "attended" | "missed";
/** Carousel calendar post pipeline states (0046). */
export type CarouselPostStatus =
  | "planned"
  | "copywriting"
  | "rendering"
  | "ready"
  | "approved"
  | "error";
/**
 * One slide of a carousel option (0046). Copy fields are written at the
 * copywriting step; image fields fill in as each slide renders.
 */
export type CarouselSlide = {
  index: number;
  headline: string;
  body: string;
  image_url?: string | null;
  image_path?: string | null;
};
export type SmsStatus = "sent" | "failed";
export type SmsStepKind = "send_sms" | "wait";
export type SmsRunStatus = "running" | "completed" | "cancelled" | "failed";
export type CrmFieldKind =
  | "text"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "url"
  | "phone";
export type LeadActivityKind =
  | "created"
  | "note"
  | "call"
  | "email"
  | "sms"
  | "meeting"
  | "stage_changed"
  | "field_changed"
  | "status_changed"
  | "task"
  | "quote"
  | "merged"
  | "restored"
  | "automation"
  | "score";
export type CrmTaskStatus = "open" | "done";
export type LeadStatus = "open" | "won" | "lost";
export type LeadScore = "hot" | "warm" | "cold";
/** Automated outreach pipeline state (0056). Draft → approve → send. */
export type LeadOutreachStatus =
  | "pending"
  | "researching"
  | "drafting"
  | "ready"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "discarded";
/** Bulk outreach run (0058). Owner can pause/cancel a run mid-flight. */
export type OutreachCampaignStatus =
  | "running"
  | "paused"
  | "done"
  | "cancelled";
/** Automatic WhatsApp cold-outreach pipeline state (0063). */
export type WaColdOutreachStatus =
  | "researching"
  | "ready"
  | "sent"
  | "delivered"
  | "replied"
  | "no_whatsapp"
  | "failed"
  | "skipped";
/** Meta-ad campaign the WhatsApp agent sells from (0065). Only one
 * row may be "active" at a time — enforced by a partial unique index. */
export type WaCampaignStatus = "draft" | "active" | "paused" | "ended";
export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired";
export type AutomationTrigger =
  | "lead_created"
  | "form_submitted"
  | "stage_changed"
  | "tag_added"
  | "lead_inactive"
  | "date_reached"
  | "invoice_unpaid"
  | "installment_due"
  | "cheque_due"
  | "quote_accepted"
  | "client_created"
  | "webhook"
  | "wa_message_received"
  | "quote_viewed"
  | "payment_received"
  // 0085 — Client Delivery
  | "project_stage_changed"
  | "project_delivered"
  | "asset_submitted"
  | "assets_complete";
export type AutomationStepKind =
  | "send_sms"
  | "send_email"
  | "create_task"
  | "add_tag"
  | "remove_tag"
  | "assign_user"
  | "move_stage"
  | "update_field"
  | "update_score"
  | "notify"
  | "webhook"
  | "ai_agent"
  | "enroll_sms_workflow"
  | "wait"
  | "send_whatsapp"
  | "convert_quote_to_invoice"
  | "create_project"
  // 0085 — Client Delivery
  | "start_wa_onboarding"
  | "set_delivery_stage";
/** Client Delivery pipeline (0084). NULL on projects = not started. */
export type DeliveryStage =
  | "onboarding"
  | "assets"
  | "build"
  | "review"
  | "delivered"
  | "aftercare";
export type AssetCategory = "brand" | "content" | "photos" | "access";
export type AssetRequestStatus = "pending" | "submitted" | "na";
export type AssetRequestSource = "portal" | "whatsapp" | "team";
export type DeliveryEventKind =
  | "kickoff"
  | "stage_changed"
  | "asset_submitted"
  | "asset_filed"
  | "asset_na"
  | "chase_sent"
  | "stalled_alert"
  | "assets_complete"
  | "milestone_sent";
/** Which brain the WhatsApp agent runs for a contact (0086). */
export type WaContactMode = "sales" | "onboarding";
/** WhatsApp system (0048). */
export type WaDirection = "in" | "out";
export type WaMessageStatus =
  | "received"
  | "sent"
  | "delivered"
  | "read"
  | "failed";
export type WaSentBy = "agent" | "team" | "automation" | "keyword";
export type WaMatchType = "exact" | "contains" | "starts_with";
/** Live sales showcase pipeline (0049; `reporting` added in 0050). */
export type WaShowcaseStatus =
  | "pending"
  | "reporting"
  | "rendering"
  | "ready"
  | "sent"
  | "error";
export type WaVoiceReplies = "off" | "match";
/** Promise tracking — prospect commitments the agent follows up on (0054). */
export type WaPromiseStatus = "pending" | "sent" | "cancelled";
/** Language matching — detected chat language incl. romanized variants (0055). */
export type WaLanguage = "en" | "si" | "ta" | "si-latn" | "ta-latn";

// 0073 — nightly conversation scoring + the approve-first lesson queue
export type WaInsightStatus = "pending" | "scored" | "failed";
export type WaInsightOutcome =
  | "won"
  | "call_booked"
  | "quoted_pending"
  | "open"
  | "ghosted"
  | "declined"
  | "lost";
export type WaLessonKind = "objection_rebuttal" | "faq" | "phrasing" | "playbook";
export type WaLessonSource = "nightly_miner" | "weekly_coach" | "manual";
export type WaLessonStatus = "pending" | "approved" | "rejected";

// 0076 — revival of aged dead threads
export type WaRevivalStatus = "queued" | "sent" | "replied" | "skipped" | "failed";
// 0077 — campaign first-reply A/B
export type WaFirstReplyVariant = "a" | "b";
export type AutomationRunStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed";
export type WebhookAction = "create_lead" | "fire_automation";
export type PaymentPlanStatus = "active" | "completed" | "cancelled";
export type InstallmentStatus = "pending" | "paid";
export type ChequeDirection = "received" | "issued";
export type ChequeStatus =
  | "pending"
  | "deposited"
  | "cleared"
  | "bounced"
  | "cancelled";
export type ExpenseCategory =
  | "salaries"
  | "rent"
  | "software"
  | "ads"
  | "hosting"
  | "equipment"
  | "transport"
  | "utilities"
  | "fees"
  | "other";
export type ChurnSeverity = "cooling" | "warm" | "cold";
export type ChurnStatus = "open" | "actioned" | "dismissed";
export type CompetitorEntryKind = "price" | "post" | "ad" | "news" | "note";
export type AdPlatform = "meta" | "google" | "tiktok" | "other";
export type VisitorEventKind =
  | "pageview"
  | "form_start"
  | "form_abandon"
  | "form_submit"
  | "click";
export type LeadResearchStatus =
  | "pending"
  | "running"
  | "discovered"
  | "analyzed"
  | "audited"
  | "synthesizing"
  | "done"
  | "error";

/** A single saved invoice line item (stored as JSONB on `invoices.items`). */
export type InvoiceItem = {
  item: string;
  description: string;
  qty: string;
  rate: string;
  total: number;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: UUID;
          full_name: string;
          username: string;
          email: string;
          role: UserRole;
          title: string | null;
          phone: string | null;
          avatar_url: string | null;
          created_at: Timestamp;
        };
        Insert: {
          id: UUID;
          full_name: string;
          username: string;
          email: string;
          role?: UserRole;
          title?: string | null;
          phone?: string | null;
          avatar_url?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      invitations: {
        Row: {
          id: UUID;
          email: string;
          role: UserRole;
          token: string;
          status: InviteStatus;
          invited_by: UUID | null;
          accepted_at: Timestamp | null;
          expires_at: Timestamp;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          email: string;
          role?: UserRole;
          token: string;
          status?: InviteStatus;
          invited_by?: UUID | null;
          accepted_at?: Timestamp | null;
          expires_at?: Timestamp;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["invitations"]["Insert"]>;
        Relationships: [];
      };
      clients: {
        Row: {
          id: UUID;
          name: string;
          company: string | null;
          email: string | null;
          phone: string | null;
          city: string | null;
          status: ClientStatus;
          notes: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          company?: string | null;
          email?: string | null;
          phone?: string | null;
          city?: string | null;
          status?: ClientStatus;
          notes?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["clients"]["Insert"]>;
        Relationships: [];
      };
      todos: {
        Row: {
          id: UUID;
          title: string;
          description: string | null;
          priority: TodoPriority;
          status: TodoStatus;
          due_date: Timestamp | null;
          assigned_to: UUID | null;
          project_id: UUID | null;
          position: number;
          created_by: UUID | null;
          completed_at: Timestamp | null;
          reminder_sent_at: Timestamp | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          title: string;
          description?: string | null;
          priority?: TodoPriority;
          status?: TodoStatus;
          due_date?: Timestamp | null;
          assigned_to?: UUID | null;
          project_id?: UUID | null;
          position?: number;
          created_by?: UUID | null;
          completed_at?: Timestamp | null;
          reminder_sent_at?: Timestamp | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["todos"]["Insert"]>;
        Relationships: [];
      };
      todo_subtasks: {
        Row: {
          id: UUID;
          todo_id: UUID;
          title: string;
          is_done: boolean;
          position: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          todo_id: UUID;
          title: string;
          is_done?: boolean;
          position?: number;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["todo_subtasks"]["Insert"]>;
        Relationships: [];
      };
      todo_mentions: {
        Row: {
          id: UUID;
          todo_id: UUID;
          user_id: UUID;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          todo_id: UUID;
          user_id: UUID;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["todo_mentions"]["Insert"]>;
        Relationships: [];
      };
      projects: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          client_id: UUID | null;
          status: ProjectStatus;
          budget: number | null;
          currency: string;
          start_date: string | null;
          due_date: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
          // 0016 — client portal
          total_value: number | null;
          deposit_paid: number | null;
          share_token: UUID | null;
          service_type: string | null;
          // 0083 — attached proposal/invoice documents
          proposal_url: string | null;
          proposal_name: string | null;
          proposal_path: string | null;
          invoice_url: string | null;
          invoice_name: string | null;
          invoice_path: string | null;
          // 0084 — Client Delivery pipeline
          delivery_stage: DeliveryStage | null;
          delivery_stage_changed_at: Timestamp | null;
          /** When WhatsApp onboarding was kicked off — doubles as the
           * one-kickoff-per-project claim. */
          onboarding_started_at: Timestamp | null;
          stalled_alerted_at: Timestamp | null;
          chaser_paused: boolean;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          client_id?: UUID | null;
          status?: ProjectStatus;
          budget?: number | null;
          currency?: string;
          start_date?: string | null;
          due_date?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          // 0016
          total_value?: number | null;
          deposit_paid?: number | null;
          share_token?: UUID | null;
          service_type?: string | null;
          // 0083
          proposal_url?: string | null;
          proposal_name?: string | null;
          proposal_path?: string | null;
          invoice_url?: string | null;
          invoice_name?: string | null;
          invoice_path?: string | null;
          // 0084
          delivery_stage?: DeliveryStage | null;
          delivery_stage_changed_at?: Timestamp | null;
          onboarding_started_at?: Timestamp | null;
          stalled_alerted_at?: Timestamp | null;
          chaser_paused?: boolean;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
        Relationships: [];
      };
      // 0016 — per-project asset checklist; 0084 grew it into the
      // Client Delivery asset-collection engine.
      project_document_requests: {
        Row: {
          id: UUID;
          project_id: UUID;
          title: string;
          description: string | null;
          status: AssetRequestStatus;
          file_url: string | null;
          file_name: string | null;
          submitted_at: Timestamp | null;
          created_at: Timestamp;
          // 0084
          category: AssetCategory | null;
          required: boolean;
          position: number;
          source: AssetRequestSource;
          wa_message_id: UUID | null;
          file_size: number | null;
          file_type: string | null;
          chase_count: number;
          last_chased_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          project_id: UUID;
          title: string;
          description?: string | null;
          status?: AssetRequestStatus;
          file_url?: string | null;
          file_name?: string | null;
          submitted_at?: Timestamp | null;
          created_at?: Timestamp;
          category?: AssetCategory | null;
          required?: boolean;
          position?: number;
          source?: AssetRequestSource;
          wa_message_id?: UUID | null;
          file_size?: number | null;
          file_type?: string | null;
          chase_count?: number;
          last_chased_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["project_document_requests"]["Insert"]
        >;
        Relationships: [];
      };
      // 0084 — Client Delivery settings singleton (id = 1).
      delivery_settings: {
        Row: {
          id: number;
          chaser_enabled: boolean;
          chaser_interval_days: number;
          chaser_max_touches: number;
          chaser_message: string;
          chaser_template_name: string | null;
          chaser_template_lang: string;
          stalled_days: number;
          stalled_alerts_enabled: boolean;
          onboarding_template_name: string | null;
          onboarding_template_lang: string;
          welcome_message: string;
          milestone_notify_enabled: boolean;
          /** Per-stage client message overrides, keyed by DeliveryStage. */
          milestone_messages: Record<string, string>;
          review_ask_enabled: boolean;
          google_review_url: string | null;
          updated_at: Timestamp;
        };
        Insert: Partial<
          Database["public"]["Tables"]["delivery_settings"]["Row"]
        > & { id: number };
        Update: Partial<Database["public"]["Tables"]["delivery_settings"]["Row"]>;
        Relationships: [];
      };
      // 0084 — Client Delivery activity feed.
      delivery_events: {
        Row: {
          id: UUID;
          project_id: UUID;
          kind: DeliveryEventKind;
          detail: string | null;
          actor: string | null;
          meta: Record<string, unknown> | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          project_id: UUID;
          kind: DeliveryEventKind;
          detail?: string | null;
          actor?: string | null;
          meta?: Record<string, unknown> | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["delivery_events"]["Insert"]>;
        Relationships: [];
      };
      company_payments: {
        Row: {
          id: UUID;
          company_name: string;
          price_lkr: number;
          status: "pending" | "upcoming";
          is_paid: boolean;
          // 0083 — the project this payment settles. NULL = standalone.
          project_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          company_name: string;
          price_lkr: number;
          status?: "pending" | "upcoming";
          is_paid?: boolean;
          // 0083 — see the Row comment
          project_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["company_payments"]["Insert"]>;
        Relationships: [];
      };
      invoices: {
        Row: {
          id: UUID;
          invoice_number: string;
          invoice_date: string;
          bill_to_name: string;
          bill_to_details: string;
          items: InvoiceItem[];
          grand_total: number;
          due_today: number;
          /** Already paid toward this invoice; null = nothing paid yet. */
          amount_paid: number | null;
          stamp: string | null;
          /** Bank account id from INVOICE_BANKS; null = the default account. */
          bank_account: string | null;
          recipient_email: string | null;
          sent_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          invoice_number: string;
          invoice_date: string;
          bill_to_name?: string;
          bill_to_details?: string;
          items?: InvoiceItem[];
          grand_total?: number;
          due_today?: number;
          amount_paid?: number | null;
          stamp?: string | null;
          bank_account?: string | null;
          recipient_email?: string | null;
          sent_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["invoices"]["Insert"]>;
        Relationships: [];
      };
      notices: {
        Row: {
          id: UUID;
          notice_number: string;
          notice_date: string;
          to_name: string;
          to_details: string;
          subject: string;
          body: string;
          source_input: string;
          recipient_email: string | null;
          sent_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          notice_number: string;
          notice_date: string;
          to_name?: string;
          to_details?: string;
          subject?: string;
          body?: string;
          source_input?: string;
          recipient_email?: string | null;
          sent_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["notices"]["Insert"]>;
        Relationships: [];
      };
      proposals: {
        Row: {
          id: UUID;
          client_name: string;
          project_name: string;
          proposal_date: string;
          selection: Record<string, unknown>;
          content: Record<string, unknown>;
          grand_total: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          client_name?: string;
          project_name?: string;
          proposal_date: string;
          selection?: Record<string, unknown>;
          content?: Record<string, unknown>;
          grand_total?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["proposals"]["Insert"]>;
        Relationships: [];
      };
      content_references: {
        Row: {
          id: UUID;
          name: string;
          description: string;
          image_url: string;
          image_path: string;
          mime_type: string;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          description?: string;
          image_url: string;
          image_path: string;
          mime_type?: string;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["content_references"]["Insert"]>;
        Relationships: [];
      };
      content_generations: {
        Row: {
          id: UUID;
          prompt: string;
          image_url: string;
          image_path: string;
          mime_type: string;
          aspect_ratio: string;
          image_size: string;
          model: string;
          reference_ids: string[];
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          prompt?: string;
          image_url: string;
          image_path: string;
          mime_type?: string;
          aspect_ratio?: string;
          image_size?: string;
          model?: string;
          reference_ids?: string[];
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["content_generations"]["Insert"]>;
        Relationships: [];
      };
      carousel_posts: {
        Row: {
          id: UUID;
          topic: string;
          notes: string;
          scheduled_for: string;
          status: CarouselPostStatus;
          caption: string;
          hashtags: string[];
          chosen_option_id: UUID | null;
          analysis: Record<string, unknown>;
          error: string | null;
          locked_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          topic: string;
          notes?: string;
          scheduled_for: string;
          status?: CarouselPostStatus;
          caption?: string;
          hashtags?: string[];
          chosen_option_id?: UUID | null;
          analysis?: Record<string, unknown>;
          error?: string | null;
          locked_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["carousel_posts"]["Insert"]>;
        Relationships: [];
      };
      carousel_options: {
        Row: {
          id: UUID;
          post_id: UUID;
          variant: number;
          concept: string;
          slides: CarouselSlide[];
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          post_id: UUID;
          variant: number;
          concept?: string;
          slides?: CarouselSlide[];
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["carousel_options"]["Insert"]>;
        Relationships: [];
      };
      website_projects: {
        Row: {
          id: UUID;
          name: string;
          url: string;
          client_id: UUID | null;
          progress: number;
          status: WebsiteStatus;
          notes: string;
          launched_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          url?: string;
          client_id?: UUID | null;
          progress?: number;
          status?: WebsiteStatus;
          notes?: string;
          launched_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["website_projects"]["Insert"]>;
        Relationships: [];
      };
      payments: {
        Row: {
          id: UUID;
          project_id: UUID;
          amount: number;
          currency: string;
          status: PaymentStatus;
          paid_at: string | null;
          method: string | null;
          notes: string | null;
          receipt_url: string | null;
          receipt_path: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          project_id: UUID;
          amount: number;
          currency?: string;
          status?: PaymentStatus;
          paid_at?: string | null;
          method?: string | null;
          notes?: string | null;
          receipt_url?: string | null;
          receipt_path?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["payments"]["Insert"]>;
        Relationships: [];
      };
      commissions: {
        Row: {
          id: UUID;
          project_id: UUID | null;
          payment_id: UUID | null;
          user_id: UUID;
          amount: number;
          percentage: number | null;
          status: CommissionStatus;
          note: string | null;
          allocated_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          project_id?: UUID | null;
          payment_id?: UUID | null;
          user_id: UUID;
          amount: number;
          percentage?: number | null;
          status?: CommissionStatus;
          note?: string | null;
          allocated_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["commissions"]["Insert"]>;
        Relationships: [];
      };
      resources: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          kind: ResourceKind;
          file_url: string | null;
          file_path: string | null;
          file_type: string | null;
          file_size: number | null;
          link_url: string | null;
          uploaded_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          kind?: ResourceKind;
          file_url?: string | null;
          file_path?: string | null;
          file_type?: string | null;
          file_size?: number | null;
          link_url?: string | null;
          uploaded_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["resources"]["Insert"]>;
        Relationships: [];
      };
      meeting_links: {
        Row: {
          id: UUID;
          slug: string;
          title: string;
          description: string | null;
          duration_minutes: number;
          start_hour: number;
          end_hour: number;
          advance_days: number;
          location: string | null;
          active: boolean;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          slug: string;
          title: string;
          description?: string | null;
          duration_minutes?: number;
          start_hour?: number;
          end_hour?: number;
          advance_days?: number;
          location?: string | null;
          active?: boolean;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["meeting_links"]["Insert"]>;
        Relationships: [];
      };
      meeting_bookings: {
        Row: {
          id: UUID;
          meeting_link_id: UUID;
          client_name: string;
          client_email: string | null;
          client_phone: string | null;
          notes: string | null;
          booking_date: string;
          start_time: string;
          end_time: string;
          status: BookingStatus;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          meeting_link_id: UUID;
          client_name: string;
          client_email?: string | null;
          client_phone?: string | null;
          notes?: string | null;
          booking_date: string;
          start_time: string;
          end_time: string;
          status?: BookingStatus;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["meeting_bookings"]["Insert"]
        >;
        Relationships: [];
      };
      meetings: {
        Row: {
          id: UUID;
          title: string;
          description: string | null;
          meeting_at: Timestamp;
          duration_minutes: number;
          location_type: MeetingLocationType;
          location: string | null;
          meeting_url: string | null;
          reminder_sent_at: Timestamp | null;
          // 0067 — how many hours ahead the reminder fires (1-5), and the
          // client this meeting is with.
          reminder_hours: number;
          client_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          title: string;
          description?: string | null;
          meeting_at: Timestamp;
          duration_minutes?: number;
          location_type?: MeetingLocationType;
          location?: string | null;
          meeting_url?: string | null;
          reminder_sent_at?: Timestamp | null;
          // 0067 — see the Row comment
          reminder_hours?: number;
          client_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["meetings"]["Insert"]>;
        Relationships: [];
      };
      meeting_attendees: {
        Row: {
          meeting_id: UUID;
          user_id: UUID;
          attendance: MeetingAttendance | null;
          responded_at: Timestamp | null;
          created_at: Timestamp;
        };
        Insert: {
          meeting_id: UUID;
          user_id: UUID;
          attendance?: MeetingAttendance | null;
          responded_at?: Timestamp | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["meeting_attendees"]["Insert"]
        >;
        Relationships: [];
      };
      prospect_scans: {
        Row: {
          id: UUID;
          status: ProspectScanStatus;
          country: string;
          city: string;
          categories: string[];
          max_results: number;
          min_score: number;
          fire_automations: boolean;
          pipeline_id: UUID | null;
          stage_id: UUID | null;
          analysis: Record<string, unknown>;
          found: number;
          qualified: number;
          skipped: number;
          imported: number;
          error: string | null;
          locked_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          status?: ProspectScanStatus;
          country?: string;
          city: string;
          categories?: string[];
          max_results?: number;
          min_score?: number;
          fire_automations?: boolean;
          pipeline_id?: UUID | null;
          stage_id?: UUID | null;
          analysis?: Record<string, unknown>;
          found?: number;
          qualified?: number;
          skipped?: number;
          imported?: number;
          error?: string | null;
          locked_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["prospect_scans"]["Insert"]>;
        Relationships: [];
      };
      prospect_candidates: {
        Row: {
          id: UUID;
          scan_id: UUID;
          place_id: string;
          name: string;
          category: string;
          address: string;
          phone: string;
          website: string;
          rating: number | null;
          rating_count: number;
          website_verdict: ProspectVerdict;
          score: number | null;
          issues: string[];
          emails: string[];
          contact_name: string;
          draft_subject: string;
          draft_body: string;
          draft_sms: string;
          status: ProspectCandidateStatus;
          reason: string;
          lead_id: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          scan_id: UUID;
          place_id: string;
          name: string;
          category?: string;
          address?: string;
          phone?: string;
          website?: string;
          rating?: number | null;
          rating_count?: number;
          website_verdict?: ProspectVerdict;
          score?: number | null;
          issues?: string[];
          emails?: string[];
          contact_name?: string;
          draft_subject?: string;
          draft_body?: string;
          draft_sms?: string;
          status?: ProspectCandidateStatus;
          reason?: string;
          lead_id?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["prospect_candidates"]["Insert"]
        >;
        Relationships: [];
      };
      pipelines: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          position: number;
          stale_after_days: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          position?: number;
          stale_after_days?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["pipelines"]["Insert"]>;
        Relationships: [];
      };
      pipeline_stages: {
        Row: {
          id: UUID;
          pipeline_id: UUID;
          name: string;
          color: string;
          position: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          pipeline_id: UUID;
          name: string;
          color?: string;
          position?: number;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["pipeline_stages"]["Insert"]
        >;
        Relationships: [];
      };
      leads: {
        Row: {
          id: UUID;
          pipeline_id: UUID;
          stage_id: UUID | null;
          title: string;
          company: string | null;
          contact_name: string | null;
          contact_email: string | null;
          contact_phone: string | null;
          value: number | null;
          currency: string;
          notes: string | null;
          position: number;
          assigned_to: UUID | null;
          client_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          // 0030 — CRM core
          tags: string[];
          custom: Record<string, unknown>;
          source: string;
          company_id: UUID | null;
          deleted_at: Timestamp | null;
          last_activity_at: Timestamp;
          // 0031 — deal fields
          status: LeadStatus;
          won_at: Timestamp | null;
          lost_at: Timestamp | null;
          lost_reason: string | null;
          expected_close_date: string | null;
          probability: number | null;
          score: LeadScore | null;
          score_reason: string | null;
          ai_summary: string | null;
          ai_next_action: string | null;
          // 0038 — research anchor
          company_website: string | null;
        };
        Insert: {
          id?: UUID;
          pipeline_id: UUID;
          stage_id?: UUID | null;
          title: string;
          company?: string | null;
          contact_name?: string | null;
          contact_email?: string | null;
          contact_phone?: string | null;
          value?: number | null;
          currency?: string;
          notes?: string | null;
          position?: number;
          assigned_to?: UUID | null;
          client_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          tags?: string[];
          custom?: Record<string, unknown>;
          source?: string;
          company_id?: UUID | null;
          deleted_at?: Timestamp | null;
          last_activity_at?: Timestamp;
          status?: LeadStatus;
          won_at?: Timestamp | null;
          lost_at?: Timestamp | null;
          lost_reason?: string | null;
          expected_close_date?: string | null;
          probability?: number | null;
          score?: LeadScore | null;
          score_reason?: string | null;
          ai_summary?: string | null;
          ai_next_action?: string | null;
          company_website?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["leads"]["Insert"]>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: UUID;
          user_id: UUID;
          actor_id: UUID | null;
          type: NotificationType;
          title: string;
          body: string | null;
          link: string | null;
          read: boolean;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          user_id: UUID;
          actor_id?: UUID | null;
          type: NotificationType;
          title: string;
          body?: string | null;
          link?: string | null;
          read?: boolean;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          id: UUID;
          user_id: UUID;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          user_id: UUID;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["push_subscriptions"]["Insert"]
        >;
        Relationships: [];
      };
      trusted_devices: {
        Row: {
          id: UUID;
          user_id: UUID;
          token_hash: string;
          label: string;
          user_agent: string | null;
          created_at: Timestamp;
          last_used_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          user_id: UUID;
          token_hash: string;
          label?: string;
          user_agent?: string | null;
          created_at?: Timestamp;
          last_used_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["trusted_devices"]["Insert"]
        >;
        Relationships: [];
      };
      device_grace: {
        Row: {
          user_id: UUID;
          started_at: Timestamp;
          pair_code_hash: string | null;
          pair_code_expires_at: Timestamp | null;
          pair_code_attempts: number;
          pair_code_sent_at: Timestamp | null;
        };
        Insert: {
          user_id: UUID;
          started_at?: Timestamp;
          pair_code_hash?: string | null;
          pair_code_expires_at?: Timestamp | null;
          pair_code_attempts?: number;
          pair_code_sent_at?: Timestamp | null;
        };
        Update: Partial<Database["public"]["Tables"]["device_grace"]["Insert"]>;
        Relationships: [];
      };
      login_sessions: {
        Row: {
          id: UUID;
          user_id: UUID;
          device_id: UUID | null;
          device_label: string | null;
          ip: string | null;
          city: string | null;
          region: string | null;
          country: string | null;
          user_agent: string | null;
          logged_in_at: Timestamp;
          last_active_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          user_id: UUID;
          device_id?: UUID | null;
          device_label?: string | null;
          ip?: string | null;
          city?: string | null;
          region?: string | null;
          country?: string | null;
          user_agent?: string | null;
          logged_in_at?: Timestamp;
          last_active_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["login_sessions"]["Insert"]
        >;
        Relationships: [];
      };
      member_changes: {
        Row: {
          id: number;
          user_id: UUID;
          table_name: string;
          op: "created" | "updated" | "deleted";
          row_id: string | null;
          label: string | null;
          changed_fields: string[] | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: number;
          user_id: UUID;
          table_name: string;
          op: "created" | "updated" | "deleted";
          row_id?: string | null;
          label?: string | null;
          changed_fields?: string[] | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["member_changes"]["Insert"]
        >;
        Relationships: [];
      };
      sms_workflows: {
        Row: {
          id: UUID;
          name: string;
          is_active: boolean;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          is_active?: boolean;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["sms_workflows"]["Insert"]>;
        Relationships: [];
      };
      sms_workflow_steps: {
        Row: {
          id: UUID;
          workflow_id: UUID;
          position: number;
          kind: SmsStepKind;
          message: string;
          wait_minutes: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          workflow_id: UUID;
          position?: number;
          kind?: SmsStepKind;
          message?: string;
          wait_minutes?: number;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["sms_workflow_steps"]["Insert"]
        >;
        Relationships: [];
      };
      sms_workflow_runs: {
        Row: {
          id: UUID;
          workflow_id: UUID;
          client_id: UUID | null;
          client_name: string;
          to_number: string;
          step_index: number;
          status: SmsRunStatus;
          next_run_at: Timestamp;
          error: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
          completed_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          workflow_id: UUID;
          client_id?: UUID | null;
          client_name?: string;
          to_number: string;
          step_index?: number;
          status?: SmsRunStatus;
          next_run_at?: Timestamp;
          error?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          completed_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["sms_workflow_runs"]["Insert"]
        >;
        Relationships: [];
      };
      sms_messages: {
        Row: {
          id: UUID;
          to_number: string;
          message: string;
          client_id: UUID | null;
          client_name: string;
          kind: SmsKind;
          status: SmsStatus;
          error: string | null;
          invoice_id: UUID | null;
          workflow_id: UUID | null;
          lead_id: UUID | null;
          segments: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          to_number: string;
          message: string;
          client_id?: UUID | null;
          client_name?: string;
          kind?: SmsKind;
          status?: SmsStatus;
          error?: string | null;
          invoice_id?: UUID | null;
          workflow_id?: UUID | null;
          lead_id?: UUID | null;
          segments?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["sms_messages"]["Insert"]>;
        Relationships: [];
      };
      companies: {
        Row: {
          id: UUID;
          name: string;
          website: string | null;
          email: string | null;
          phone: string | null;
          city: string | null;
          industry: string | null;
          notes: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          website?: string | null;
          email?: string | null;
          phone?: string | null;
          city?: string | null;
          industry?: string | null;
          notes?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["companies"]["Insert"]>;
        Relationships: [];
      };
      crm_fields: {
        Row: {
          id: UUID;
          key: string;
          label: string;
          kind: CrmFieldKind;
          options: string[];
          required: boolean;
          position: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          key: string;
          label: string;
          kind?: CrmFieldKind;
          options?: string[];
          required?: boolean;
          position?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["crm_fields"]["Insert"]>;
        Relationships: [];
      };
      crm_segments: {
        Row: {
          id: UUID;
          name: string;
          filters: Record<string, unknown>;
          position: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          filters?: Record<string, unknown>;
          position?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["crm_segments"]["Insert"]>;
        Relationships: [];
      };
      lead_activities: {
        Row: {
          id: UUID;
          lead_id: UUID;
          kind: LeadActivityKind;
          title: string;
          body: string | null;
          meta: Record<string, unknown>;
          actor_id: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          lead_id: UUID;
          kind?: LeadActivityKind;
          title?: string;
          body?: string | null;
          meta?: Record<string, unknown>;
          actor_id?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["lead_activities"]["Insert"]
        >;
        Relationships: [];
      };
      lead_outreach: {
        Row: {
          id: UUID;
          lead_id: UUID;
          status: LeadOutreachStatus;
          recipients: string[];
          sent_to: string[];
          subject: string;
          body: string;
          audit: Record<string, unknown> | null;
          audit_score: number | null;
          company_facts: Record<string, unknown> | null;
          message_ids: string[];
          from_email: string;
          source: string;
          attempts: number;
          error: string | null;
          locked_at: Timestamp | null;
          requested_by: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          sent_at: Timestamp | null;
          // 0058 — bulk campaigns
          auto_send: boolean;
          campaign_id: UUID | null;
          research_started_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          lead_id: UUID;
          status?: LeadOutreachStatus;
          recipients?: string[];
          sent_to?: string[];
          subject?: string;
          body?: string;
          audit?: Record<string, unknown> | null;
          audit_score?: number | null;
          company_facts?: Record<string, unknown> | null;
          message_ids?: string[];
          from_email?: string;
          source?: string;
          attempts?: number;
          error?: string | null;
          locked_at?: Timestamp | null;
          requested_by?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          sent_at?: Timestamp | null;
          // 0058 — bulk campaigns
          auto_send?: boolean;
          campaign_id?: UUID | null;
          research_started_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["lead_outreach"]["Insert"]
        >;
        Relationships: [];
      };
      outreach_campaigns: {
        Row: {
          id: UUID;
          name: string;
          status: OutreachCampaignStatus;
          auto_send: boolean;
          daily_cap: number;
          filters: Record<string, unknown>;
          queued: number;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          finished_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          name?: string;
          status?: OutreachCampaignStatus;
          auto_send?: boolean;
          daily_cap?: number;
          filters?: Record<string, unknown>;
          queued?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          finished_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["outreach_campaigns"]["Insert"]
        >;
        Relationships: [];
      };
      outreach_suppressions: {
        Row: {
          email: string;
          reason: string;
          lead_id: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          email: string;
          reason?: string;
          lead_id?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["outreach_suppressions"]["Insert"]
        >;
        Relationships: [];
      };
      crm_tasks: {
        Row: {
          id: UUID;
          lead_id: UUID | null;
          company_id: UUID | null;
          title: string;
          notes: string | null;
          due_at: Timestamp | null;
          assigned_to: UUID | null;
          status: CrmTaskStatus;
          completed_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          lead_id?: UUID | null;
          company_id?: UUID | null;
          title: string;
          notes?: string | null;
          due_at?: Timestamp | null;
          assigned_to?: UUID | null;
          status?: CrmTaskStatus;
          completed_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["crm_tasks"]["Insert"]>;
        Relationships: [];
      };
      quotes: {
        Row: {
          id: UUID;
          quote_number: string;
          title: string;
          customer_name: string;
          customer_email: string | null;
          customer_phone: string | null;
          lead_id: UUID | null;
          client_id: UUID | null;
          items: InvoiceItem[];
          subtotal: number;
          discount: number;
          tax_rate: number;
          tax_amount: number;
          grand_total: number;
          currency: string;
          valid_until: string | null;
          notes: string | null;
          terms: string | null;
          status: QuoteStatus;
          share_token: string;
          sent_at: Timestamp | null;
          viewed_at: Timestamp | null;
          signed_name: string | null;
          signature_data: string | null;
          signed_ip: string | null;
          accepted_at: Timestamp | null;
          declined_at: Timestamp | null;
          declined_reason: string | null;
          invoice_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          quote_number: string;
          title?: string;
          customer_name?: string;
          customer_email?: string | null;
          customer_phone?: string | null;
          lead_id?: UUID | null;
          client_id?: UUID | null;
          items?: InvoiceItem[];
          subtotal?: number;
          discount?: number;
          tax_rate?: number;
          tax_amount?: number;
          grand_total?: number;
          currency?: string;
          valid_until?: string | null;
          notes?: string | null;
          terms?: string | null;
          status?: QuoteStatus;
          share_token?: string;
          sent_at?: Timestamp | null;
          viewed_at?: Timestamp | null;
          signed_name?: string | null;
          signature_data?: string | null;
          signed_ip?: string | null;
          accepted_at?: Timestamp | null;
          declined_at?: Timestamp | null;
          declined_reason?: string | null;
          invoice_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["quotes"]["Insert"]>;
        Relationships: [];
      };
      automations: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          is_active: boolean;
          trigger: AutomationTrigger;
          trigger_config: Record<string, unknown>;
          conditions: Record<string, unknown>[];
          runs_started: number;
          last_run_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          description?: string | null;
          is_active?: boolean;
          trigger?: AutomationTrigger;
          trigger_config?: Record<string, unknown>;
          conditions?: Record<string, unknown>[];
          runs_started?: number;
          last_run_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["automations"]["Insert"]>;
        Relationships: [];
      };
      automation_steps: {
        Row: {
          id: UUID;
          automation_id: UUID;
          position: number;
          kind: AutomationStepKind;
          config: Record<string, unknown>;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          automation_id: UUID;
          position?: number;
          kind?: AutomationStepKind;
          config?: Record<string, unknown>;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["automation_steps"]["Insert"]
        >;
        Relationships: [];
      };
      automation_runs: {
        Row: {
          id: UUID;
          automation_id: UUID;
          lead_id: UUID | null;
          client_id: UUID | null;
          // 0085 — the project this run concerns, when the trigger knew it.
          project_id: UUID | null;
          subject_name: string;
          subject_phone: string | null;
          subject_email: string | null;
          context: Record<string, unknown>;
          trigger_key: string | null;
          step_index: number;
          status: AutomationRunStatus;
          next_run_at: Timestamp;
          log: Record<string, unknown>[];
          error: string | null;
          created_at: Timestamp;
          completed_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          automation_id: UUID;
          lead_id?: UUID | null;
          client_id?: UUID | null;
          // 0085
          project_id?: UUID | null;
          subject_name?: string;
          subject_phone?: string | null;
          subject_email?: string | null;
          context?: Record<string, unknown>;
          trigger_key?: string | null;
          step_index?: number;
          status?: AutomationRunStatus;
          next_run_at?: Timestamp;
          log?: Record<string, unknown>[];
          error?: string | null;
          created_at?: Timestamp;
          completed_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["automation_runs"]["Insert"]
        >;
        Relationships: [];
      };
      webhook_endpoints: {
        Row: {
          id: UUID;
          name: string;
          token: string;
          action: WebhookAction;
          config: Record<string, unknown>;
          hits: number;
          last_hit_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          token?: string;
          action?: WebhookAction;
          config?: Record<string, unknown>;
          hits?: number;
          last_hit_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["webhook_endpoints"]["Insert"]
        >;
        Relationships: [];
      };
      api_keys: {
        Row: {
          id: UUID;
          name: string;
          key: string;
          is_active: boolean;
          last_used_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name?: string;
          key?: string;
          is_active?: boolean;
          last_used_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["api_keys"]["Insert"]>;
        Relationships: [];
      };
      app_settings: {
        Row: {
          key: string;
          value: Record<string, unknown>;
          updated_at: Timestamp;
        };
        Insert: {
          key: string;
          value?: Record<string, unknown>;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["app_settings"]["Insert"]>;
        Relationships: [];
      };
      payment_plans: {
        Row: {
          id: UUID;
          title: string;
          client_id: UUID | null;
          lead_id: UUID | null;
          invoice_id: UUID | null;
          contact_name: string;
          phone: string | null;
          total: number;
          currency: string;
          notes: string | null;
          status: PaymentPlanStatus;
          remind_days_before: number | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          title: string;
          client_id?: UUID | null;
          lead_id?: UUID | null;
          invoice_id?: UUID | null;
          contact_name?: string;
          phone?: string | null;
          total?: number;
          currency?: string;
          notes?: string | null;
          status?: PaymentPlanStatus;
          remind_days_before?: number | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["payment_plans"]["Insert"]
        >;
        Relationships: [];
      };
      payment_installments: {
        Row: {
          id: UUID;
          plan_id: UUID;
          seq: number;
          amount: number;
          due_date: string;
          status: InstallmentStatus;
          paid_at: Timestamp | null;
          reminder_sent_at: Timestamp | null;
          overdue_sent_at: Timestamp | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          plan_id: UUID;
          seq?: number;
          amount?: number;
          due_date: string;
          status?: InstallmentStatus;
          paid_at?: Timestamp | null;
          reminder_sent_at?: Timestamp | null;
          overdue_sent_at?: Timestamp | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["payment_installments"]["Insert"]
        >;
        Relationships: [];
      };
      cheques: {
        Row: {
          id: UUID;
          direction: ChequeDirection;
          party_name: string;
          client_id: UUID | null;
          bank: string | null;
          cheque_number: string | null;
          amount: number;
          currency: string;
          due_date: string;
          status: ChequeStatus;
          notes: string | null;
          alerted_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          direction?: ChequeDirection;
          party_name: string;
          client_id?: UUID | null;
          bank?: string | null;
          cheque_number?: string | null;
          amount?: number;
          currency?: string;
          due_date: string;
          status?: ChequeStatus;
          notes?: string | null;
          alerted_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["cheques"]["Insert"]>;
        Relationships: [];
      };
      expenses: {
        Row: {
          id: UUID;
          expense_date: string;
          category: ExpenseCategory;
          description: string;
          vendor: string | null;
          amount: number;
          currency: string;
          payment_method: string | null;
          tax_amount: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          expense_date?: string;
          category?: ExpenseCategory;
          description: string;
          vendor?: string | null;
          amount?: number;
          currency?: string;
          payment_method?: string | null;
          tax_amount?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["expenses"]["Insert"]>;
        Relationships: [];
      };
      ai_digests: {
        Row: {
          id: UUID;
          week_start: string;
          content: string;
          stats: Record<string, unknown>;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          week_start: string;
          content?: string;
          stats?: Record<string, unknown>;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["ai_digests"]["Insert"]>;
        Relationships: [];
      };
      churn_alerts: {
        Row: {
          id: UUID;
          client_id: UUID | null;
          client_name: string;
          severity: ChurnSeverity;
          reason: string;
          draft_message: string | null;
          status: ChurnStatus;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          client_id?: UUID | null;
          client_name?: string;
          severity?: ChurnSeverity;
          reason?: string;
          draft_message?: string | null;
          status?: ChurnStatus;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["churn_alerts"]["Insert"]>;
        Relationships: [];
      };
      competitors: {
        Row: {
          id: UUID;
          name: string;
          website: string | null;
          facebook: string | null;
          instagram: string | null;
          notes: string | null;
          ai_summary: string | null;
          ai_summary_at: Timestamp | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          website?: string | null;
          facebook?: string | null;
          instagram?: string | null;
          notes?: string | null;
          ai_summary?: string | null;
          ai_summary_at?: Timestamp | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["competitors"]["Insert"]>;
        Relationships: [];
      };
      competitor_entries: {
        Row: {
          id: UUID;
          competitor_id: UUID;
          kind: CompetitorEntryKind;
          content: string;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          competitor_id: UUID;
          kind?: CompetitorEntryKind;
          content: string;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["competitor_entries"]["Insert"]
        >;
        Relationships: [];
      };
      ad_entries: {
        Row: {
          id: UUID;
          platform: AdPlatform;
          campaign: string;
          period_start: string;
          period_end: string;
          spend: number;
          currency: string;
          impressions: number | null;
          clicks: number | null;
          leads: number | null;
          revenue: number | null;
          notes: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          platform?: AdPlatform;
          campaign: string;
          period_start: string;
          period_end: string;
          spend?: number;
          currency?: string;
          impressions?: number | null;
          clicks?: number | null;
          leads?: number | null;
          revenue?: number | null;
          notes?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["ad_entries"]["Insert"]>;
        Relationships: [];
      };
      visitor_events: {
        Row: {
          id: UUID;
          site: string;
          session_id: string;
          kind: VisitorEventKind;
          path: string;
          referrer: string | null;
          meta: Record<string, unknown>;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          site?: string;
          session_id?: string;
          kind?: VisitorEventKind;
          path?: string;
          referrer?: string | null;
          meta?: Record<string, unknown>;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["visitor_events"]["Insert"]
        >;
        Relationships: [];
      };
      lead_research: {
        Row: {
          id: UUID;
          lead_id: UUID;
          company_name: string;
          status: LeadResearchStatus;
          error: string | null;
          sources: Record<string, unknown>[];
          report: Record<string, unknown>;
          requested_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          // 0039 — multi-step dossier pipeline
          analysis: Record<string, unknown>;
          locked_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          lead_id: UUID;
          company_name: string;
          status?: LeadResearchStatus;
          error?: string | null;
          sources?: Record<string, unknown>[];
          report?: Record<string, unknown>;
          requested_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          analysis?: Record<string, unknown>;
          locked_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["lead_research"]["Insert"]
        >;
        Relationships: [];
      };
      wa_contacts: {
        Row: {
          id: UUID;
          wa_id: string;
          profile_name: string | null;
          display_name: string | null;
          lead_id: UUID | null;
          client_id: UUID | null;
          agent_enabled: boolean;
          needs_attention: boolean;
          unread: number;
          last_message_at: Timestamp | null;
          last_message_preview: string | null;
          last_direction: WaDirection | null;
          last_inbound_at: Timestamp | null;
          followup_stage: number;
          next_followup_at: Timestamp | null;
          do_not_contact: boolean;
          agent_due_at: Timestamp | null;
          language: WaLanguage | null;
          // 0065 — which campaign was live when they first wrote
          campaign_id: UUID | null;
          // 0066 — newest inbound the agent has actually answered
          // (replaces the last_direction skip), failure backoff,
          // instant-first-line CAS claim, and the response-time metric.
          agent_answered_through: Timestamp | null;
          agent_attempts: number;
          first_reply_sent_at: Timestamp | null;
          first_reply_seconds: number | null;
          // 0072 — the agreed phone-call slot and the To-Do that carries it,
          // so a reschedule updates the same task instead of stacking one.
          call_booked_at: Timestamp | null;
          call_todo_id: UUID | null;
          // 0083 — the single post-call "did the team reach you?" check-in.
          // Set = the agent has asked once and now waits for their reply.
          post_call_checkin_sent_at: Timestamp | null;
          // 0077 — which instant first reply they received (A/B)
          first_reply_variant: WaFirstReplyVariant | null;
          // 0086 — which brain the agent runs for this thread. 'onboarding'
          // = delivery coordinator collecting project assets; the sales
          // machinery (follow-ups, promises, revival) skips the thread.
          mode: WaContactMode;
          onboarding_project_id: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          wa_id: string;
          profile_name?: string | null;
          display_name?: string | null;
          lead_id?: UUID | null;
          client_id?: UUID | null;
          agent_enabled?: boolean;
          needs_attention?: boolean;
          unread?: number;
          last_message_at?: Timestamp | null;
          last_message_preview?: string | null;
          last_direction?: WaDirection | null;
          last_inbound_at?: Timestamp | null;
          followup_stage?: number;
          next_followup_at?: Timestamp | null;
          do_not_contact?: boolean;
          agent_due_at?: Timestamp | null;
          language?: WaLanguage | null;
          // 0065 — which campaign was live when they first wrote
          campaign_id?: UUID | null;
          // 0066 — see the Row comment
          agent_answered_through?: Timestamp | null;
          agent_attempts?: number;
          first_reply_sent_at?: Timestamp | null;
          first_reply_seconds?: number | null;
          // 0072 — agreed phone-call slot + the To-Do carrying it
          call_booked_at?: Timestamp | null;
          call_todo_id?: UUID | null;
          // 0083 — the single post-call check-in stamp (see the Row comment)
          post_call_checkin_sent_at?: Timestamp | null;
          // 0077 — which instant first reply they received (A/B)
          first_reply_variant?: WaFirstReplyVariant | null;
          // 0086 — see the Row comment
          mode?: WaContactMode;
          onboarding_project_id?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["wa_contacts"]["Insert"]>;
        Relationships: [];
      };
      wa_messages: {
        Row: {
          id: UUID;
          contact_id: UUID;
          wa_message_id: string | null;
          direction: WaDirection;
          message_type: string;
          body: string;
          status: WaMessageStatus;
          error: string | null;
          sent_by: WaSentBy | null;
          author_id: UUID | null;
          meta: Record<string, unknown>;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          contact_id: UUID;
          wa_message_id?: string | null;
          direction: WaDirection;
          message_type?: string;
          body?: string;
          status?: WaMessageStatus;
          error?: string | null;
          sent_by?: WaSentBy | null;
          author_id?: UUID | null;
          meta?: Record<string, unknown>;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["wa_messages"]["Insert"]>;
        Relationships: [];
      };
      wa_agent_config: {
        Row: {
          id: number;
          enabled: boolean;
          agent_name: string;
          greeting: string;
          persona: string;
          knowledge: string;
          ask_name: boolean;
          auto_create_lead: boolean;
          pipeline_id: UUID | null;
          stage_id: UUID | null;
          lead_source: string;
          allowed_tools: string[];
          voice_replies: WaVoiceReplies;
          followups_enabled: boolean;
          followup_template_name: string | null;
          followup_template_lang: string;
          max_autonomous_discount_pct: number;
          quiet_hours_enabled: boolean;
          quiet_hours_start: number;
          quiet_hours_end: number;
          timezone: string;
          language_matching: boolean;
          updated_at: Timestamp;
          // 0063 — automatic cold outreach
          cold_outreach_enabled: boolean;
          cold_daily_cap: number;
          cold_template_name: string | null;
          cold_template_lang: string;
          cold_template_params: string[];
          cold_pipeline_id: UUID | null;
          cold_stage_id: UUID | null;
          // 0064 — follow-up nudge + daily digest
          cold_followup_template_name: string | null;
          cold_followup_template_lang: string;
          cold_followup_template_params: string[];
          cold_followup_days: number;
          cold_digest_sent_for: string | null;
          // 0065 — campaign mode
          campaign_mode_enabled: boolean;
          // 0066 — once-a-day attempt gate for the weekly coaching run
          coaching_ran_for: string | null;
          // 0073 — nightly insight scorer + lesson miner claim stamps
          insights_ran_for: string | null;
          lessons_ran_for: string | null;
          // 0076 — revival of aged dead threads
          revival_enabled: boolean;
          revival_daily_cap: number;
          revival_template_name: string | null;
          revival_template_lang: string;
          revival_template_params: string[];
          revival_min_age_days: number;
          // 0078 — morning agent digest claim stamp
          agent_digest_sent_for: string | null;
        };
        Insert: {
          id?: number;
          enabled?: boolean;
          agent_name?: string;
          greeting?: string;
          persona?: string;
          knowledge?: string;
          ask_name?: boolean;
          auto_create_lead?: boolean;
          pipeline_id?: UUID | null;
          stage_id?: UUID | null;
          lead_source?: string;
          allowed_tools?: string[];
          voice_replies?: WaVoiceReplies;
          followups_enabled?: boolean;
          followup_template_name?: string | null;
          followup_template_lang?: string;
          max_autonomous_discount_pct?: number;
          quiet_hours_enabled?: boolean;
          quiet_hours_start?: number;
          quiet_hours_end?: number;
          timezone?: string;
          language_matching?: boolean;
          updated_at?: Timestamp;
          // 0063 — automatic cold outreach
          cold_outreach_enabled?: boolean;
          cold_daily_cap?: number;
          cold_template_name?: string | null;
          cold_template_lang?: string;
          cold_template_params?: string[];
          cold_pipeline_id?: UUID | null;
          cold_stage_id?: UUID | null;
          // 0064 — follow-up nudge + daily digest
          cold_followup_template_name?: string | null;
          cold_followup_template_lang?: string;
          cold_followup_template_params?: string[];
          cold_followup_days?: number;
          cold_digest_sent_for?: string | null;
          // 0065 — campaign mode
          campaign_mode_enabled?: boolean;
          // 0066 — once-a-day attempt gate for the weekly coaching run
          coaching_ran_for?: string | null;
          // 0073 — nightly insight scorer + lesson miner claim stamps
          insights_ran_for?: string | null;
          lessons_ran_for?: string | null;
          // 0076 — revival of aged dead threads
          revival_enabled?: boolean;
          revival_daily_cap?: number;
          revival_template_name?: string | null;
          revival_template_lang?: string;
          revival_template_params?: string[];
          revival_min_age_days?: number;
          // 0078 — morning agent digest claim stamp
          agent_digest_sent_for?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_agent_config"]["Insert"]
        >;
        Relationships: [];
      };
      wa_cold_outreach: {
        Row: {
          id: UUID;
          lead_id: UUID;
          wa_id: string;
          status: WaColdOutreachStatus;
          picked_for: string;
          research_started_at: Timestamp | null;
          template_name: string | null;
          template_lang: string | null;
          template_params: string[];
          contact_id: UUID | null;
          wa_message_id: string | null;
          sent_at: Timestamp | null;
          error: string | null;
          attempts: number;
          locked_at: Timestamp | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          // 0064 — follow-up nudge + reply tracking
          followup_sent_at: Timestamp | null;
          followup_wa_message_id: string | null;
          replied_at: Timestamp | null;
        };
        Insert: {
          id?: UUID;
          lead_id: UUID;
          wa_id: string;
          status?: WaColdOutreachStatus;
          picked_for: string;
          research_started_at?: Timestamp | null;
          template_name?: string | null;
          template_lang?: string | null;
          template_params?: string[];
          contact_id?: UUID | null;
          wa_message_id?: string | null;
          sent_at?: Timestamp | null;
          error?: string | null;
          attempts?: number;
          locked_at?: Timestamp | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          // 0064 — follow-up nudge + reply tracking
          followup_sent_at?: Timestamp | null;
          followup_wa_message_id?: string | null;
          replied_at?: Timestamp | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_cold_outreach"]["Insert"]
        >;
        Relationships: [];
      };
      wa_campaigns: {
        Row: {
          id: UUID;
          name: string;
          status: WaCampaignStatus;
          image_url: string | null;
          image_path: string | null;
          image_summary: string | null;
          details: string;
          // 0066 — the instant line the webhook fires on first contact
          first_reply: string | null;
          // 0077 — optional A/B variant of that instant line
          first_reply_b: string | null;
          // 0068 — the only thing the agent may say when price comes up
          pricing_note: string;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          status?: WaCampaignStatus;
          image_url?: string | null;
          image_path?: string | null;
          image_summary?: string | null;
          details?: string;
          // 0066 — the instant line the webhook fires on first contact
          first_reply?: string | null;
          // 0077 — optional A/B variant of that instant line
          first_reply_b?: string | null;
          // 0068 — the only thing the agent may say when price comes up
          pricing_note?: string;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["wa_campaigns"]["Insert"]>;
        Relationships: [];
      };
      pricing_config: {
        Row: {
          id: number;
          overrides: Record<string, number>;
          updated_at: Timestamp;
          created_at: Timestamp;
        };
        Insert: {
          id?: number;
          overrides?: Record<string, number>;
          updated_at?: Timestamp;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["pricing_config"]["Insert"]
        >;
        Relationships: [];
      };
      wa_keyword_rules: {
        Row: {
          id: UUID;
          keyword: string;
          match_type: WaMatchType;
          reply: string | null;
          add_tag: string | null;
          notify_team: boolean;
          handoff: boolean;
          automation_id: UUID | null;
          is_active: boolean;
          hits: number;
          position: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          keyword: string;
          match_type?: WaMatchType;
          reply?: string | null;
          add_tag?: string | null;
          notify_team?: boolean;
          handoff?: boolean;
          automation_id?: UUID | null;
          is_active?: boolean;
          hits?: number;
          position?: number;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_keyword_rules"]["Insert"]
        >;
        Relationships: [];
      };
      wa_agent_logs: {
        Row: {
          id: UUID;
          contact_id: UUID | null;
          tool: string;
          args: Record<string, unknown>;
          ok: boolean;
          result: string | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          contact_id?: UUID | null;
          tool: string;
          args?: Record<string, unknown>;
          ok?: boolean;
          result?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_agent_logs"]["Insert"]
        >;
        Relationships: [];
      };
      wa_promises: {
        Row: {
          id: UUID;
          contact_id: UUID;
          summary: string;
          source_quote: string | null;
          due_at: Timestamp;
          status: WaPromiseStatus;
          result: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          contact_id: UUID;
          summary: string;
          source_quote?: string | null;
          due_at: Timestamp;
          status?: WaPromiseStatus;
          result?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_promises"]["Insert"]
        >;
        Relationships: [];
      };
      wa_showcases: {
        Row: {
          id: UUID;
          token: string;
          contact_id: UUID;
          lead_id: UUID | null;
          status: WaShowcaseStatus;
          config: Record<string, unknown>;
          payload: Record<string, unknown>;
          before_image_url: string | null;
          mockup_image_url: string | null;
          report_pdf_url: string | null;
          error: string | null;
          attempts: number;
          locked_at: Timestamp | null;
          viewed_at: Timestamp | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          token?: string;
          contact_id: UUID;
          lead_id?: UUID | null;
          status?: WaShowcaseStatus;
          config?: Record<string, unknown>;
          payload?: Record<string, unknown>;
          before_image_url?: string | null;
          mockup_image_url?: string | null;
          report_pdf_url?: string | null;
          error?: string | null;
          attempts?: number;
          locked_at?: Timestamp | null;
          viewed_at?: Timestamp | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_showcases"]["Insert"]
        >;
        Relationships: [];
      };
      prospect_scan_schedules: {
        Row: {
          id: UUID;
          label: string;
          area: string;
          category: string;
          threshold: number;
          max_results: number;
          cadence_days: number;
          next_run_at: Timestamp;
          auto_outreach: boolean;
          template_name: string | null;
          template_lang: string;
          is_active: boolean;
          last_scan_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          label?: string;
          area: string;
          category: string;
          threshold?: number;
          max_results?: number;
          cadence_days?: number;
          next_run_at?: Timestamp;
          auto_outreach?: boolean;
          template_name?: string | null;
          template_lang?: string;
          is_active?: boolean;
          last_scan_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["prospect_scan_schedules"]["Insert"]
        >;
        Relationships: [];
      };
      wa_coaching: {
        Row: {
          id: UUID;
          week_start: string;
          stats: Record<string, unknown>;
          notes: string;
          is_active: boolean;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          week_start: string;
          stats?: Record<string, unknown>;
          notes?: string;
          is_active?: boolean;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_coaching"]["Insert"]
        >;
        Relationships: [];
      };
      wa_convo_insights: {
        Row: {
          id: UUID;
          contact_id: UUID;
          campaign_id: UUID | null;
          lead_id: UUID | null;
          convo_ended_at: Timestamp;
          status: WaInsightStatus;
          outcome: WaInsightOutcome | null;
          stage_reached: string | null;
          objections: string[];
          questions_asked: string[];
          buying_signals: string[];
          faq_gaps: string[];
          quality_flags: string[];
          language: string | null;
          messages_in: number;
          messages_out: number;
          summary: string | null;
          attempts: number;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          contact_id: UUID;
          campaign_id?: UUID | null;
          lead_id?: UUID | null;
          convo_ended_at: Timestamp;
          status?: WaInsightStatus;
          outcome?: WaInsightOutcome | null;
          stage_reached?: string | null;
          objections?: string[];
          questions_asked?: string[];
          buying_signals?: string[];
          faq_gaps?: string[];
          quality_flags?: string[];
          language?: string | null;
          messages_in?: number;
          messages_out?: number;
          summary?: string | null;
          attempts?: number;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["wa_convo_insights"]["Insert"]
        >;
        Relationships: [];
      };
      wa_lessons: {
        Row: {
          id: UUID;
          kind: WaLessonKind;
          title: string;
          body: string;
          evidence: Record<string, unknown>;
          source: WaLessonSource;
          status: WaLessonStatus;
          decided_by: UUID | null;
          decided_at: Timestamp | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          kind: WaLessonKind;
          title: string;
          body: string;
          evidence?: Record<string, unknown>;
          source?: WaLessonSource;
          status?: WaLessonStatus;
          decided_by?: UUID | null;
          decided_at?: Timestamp | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["wa_lessons"]["Insert"]>;
        Relationships: [];
      };
      wa_revival: {
        Row: {
          id: UUID;
          contact_id: UUID;
          picked_for: string;
          status: WaRevivalStatus;
          template_name: string | null;
          template_lang: string | null;
          wa_message_id: string | null;
          sent_at: Timestamp | null;
          replied_at: Timestamp | null;
          error: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          contact_id: UUID;
          picked_for: string;
          status?: WaRevivalStatus;
          template_name?: string | null;
          template_lang?: string | null;
          wa_message_id?: string | null;
          sent_at?: Timestamp | null;
          replied_at?: Timestamp | null;
          error?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["wa_revival"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      is_admin: {
        Args: { uid: UUID };
        Returns: boolean;
      };
      // 0074 — Analytics tab aggregates
      wa_funnel_stats: {
        Args: { p_since: Timestamp; p_campaign?: UUID | null };
        Returns: Record<string, unknown>;
      };
      wa_daily_message_counts: {
        Args: { p_since: Timestamp; p_timezone?: string };
        Returns: { day: string; inbound: number; outbound: number }[];
      };
      wa_tool_stats: {
        Args: { p_since: Timestamp };
        Returns: { tool: string; total: number; ok_count: number }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
