import type { Database } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];

export type Profile = Tables["profiles"]["Row"];
export type Invitation = Tables["invitations"]["Row"];
export type Client = Tables["clients"]["Row"];
export type Todo = Tables["todos"]["Row"];
export type TodoMention = Tables["todo_mentions"]["Row"];
export type Project = Tables["projects"]["Row"];
export type Payment = Tables["payments"]["Row"];
export type Commission = Tables["commissions"]["Row"];
export type Resource = Tables["resources"]["Row"];
export type MeetingLink = Tables["meeting_links"]["Row"];
export type MeetingBooking = Tables["meeting_bookings"]["Row"];
export type Pipeline = Tables["pipelines"]["Row"];
export type PipelineStage = Tables["pipeline_stages"]["Row"];
export type Lead = Tables["leads"]["Row"];
export type Notification = Tables["notifications"]["Row"];

export type {
  UserRole,
  TodoPriority,
  TodoStatus,
  ProjectStatus,
  PaymentStatus,
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
