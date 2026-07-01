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
export type CompanyPayment = Tables["company_payments"]["Row"];
export type Commission = Tables["commissions"]["Row"];
export type Resource = Tables["resources"]["Row"];
export type MeetingLink = Tables["meeting_links"]["Row"];
export type MeetingBooking = Tables["meeting_bookings"]["Row"];
export type Pipeline = Tables["pipelines"]["Row"];
export type PipelineStage = Tables["pipeline_stages"]["Row"];
export type Lead = Tables["leads"]["Row"];
export type Notification = Tables["notifications"]["Row"];
export type ContentReference = Tables["content_references"]["Row"];
export type ContentGeneration = Tables["content_generations"]["Row"];
export type WebsiteProject = Tables["website_projects"]["Row"];

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
  NotificationType,
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
