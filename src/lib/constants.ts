import type {
  TodoPriority,
  TodoStatus,
  ProjectStatus,
  PaymentStatus,
  WebsiteStatus,
  CommissionStatus,
  ClientStatus,
} from "@/lib/types";

export const PRIORITY_META: Record<
  TodoPriority,
  { label: string; dot: string; badge: string; order: number }
> = {
  urgent: {
    label: "Urgent",
    dot: "bg-rose-500",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
    order: 0,
  },
  high: {
    label: "High",
    dot: "bg-orange-500",
    badge: "bg-orange-50 text-orange-600 ring-orange-200",
    order: 1,
  },
  medium: {
    label: "Medium",
    dot: "bg-amber-400",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
    order: 2,
  },
  low: {
    label: "Low",
    dot: "bg-emerald-400",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    order: 3,
  },
};

export const TODO_STATUS_META: Record<
  TodoStatus,
  { label: string; badge: string }
> = {
  todo: { label: "To do", badge: "bg-slate-100 text-slate-600 ring-slate-200" },
  in_progress: {
    label: "In progress",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
  },
  done: {
    label: "Done",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
};

export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { label: string; badge: string }
> = {
  planning: {
    label: "Planning",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
  },
  active: {
    label: "Active",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
  },
  on_hold: {
    label: "On hold",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
  },
  completed: {
    label: "Completed",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
  },
};

export const WEBSITE_STATUS_META: Record<
  WebsiteStatus,
  { label: string; badge: string }
> = {
  in_progress: {
    label: "In progress",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
  },
  waiting_client: {
    label: "Waiting on client",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
  },
  launched: {
    label: "Launched",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
};

export const PAYMENT_STATUS_META: Record<
  PaymentStatus,
  { label: string; badge: string }
> = {
  paid: {
    label: "Paid",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  pending: {
    label: "Pending",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
  },
  overdue: {
    label: "Overdue",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
  },
};

export const COMMISSION_STATUS_META: Record<
  CommissionStatus,
  { label: string; badge: string }
> = {
  pending: {
    label: "Pending",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
  },
  approved: {
    label: "Approved",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
  },
  paid: {
    label: "Paid",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
};

export const CLIENT_STATUS_META: Record<
  ClientStatus,
  { label: string; badge: string }
> = {
  active: {
    label: "Active",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  lead: {
    label: "Lead",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
  },
  inactive: {
    label: "Inactive",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
  },
};

/** Default stages created with a new CRM pipeline. */
export const DEFAULT_PIPELINE_STAGES: { name: string; color: string }[] = [
  { name: "New Lead", color: "#f97316" },
  { name: "Contacted", color: "#22b8cf" },
  { name: "Proposal Sent", color: "#ffb020" },
  { name: "Awaiting Payment", color: "#ff7a59" },
  { name: "Won", color: "#16c79a" },
];

/** Palette offered when creating / editing a CRM stage. */
export const STAGE_COLORS = [
  "#f97316",
  "#ea580c",
  "#22b8cf",
  "#16c79a",
  "#51cf66",
  "#ffb020",
  "#ff7a59",
  "#ff5c8a",
  "#94a3b8",
];

export const STORAGE_BUCKETS = {
  receipts: "receipts",
  resources: "resources",
  avatars: "avatars",
  contentReferences: "content-references",
  contentGenerations: "content-generations",
} as const;

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  business_website: "Business Website",
  ecommerce_website: "E-commerce Website",
  social_media_marketing: "Social Media Marketing",
};
