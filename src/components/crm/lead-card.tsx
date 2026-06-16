"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Building2, GripVertical, Mail, Phone } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { cn, formatCurrency } from "@/lib/utils";
import type { LeadWithAssignee } from "@/lib/types";

export function LeadCardContent({
  lead,
  dragging,
  onClick,
}: {
  lead: LeadWithAssignee;
  dragging?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group cursor-pointer rounded-xl border border-slate-200 bg-white p-3.5 shadow-[var(--shadow-soft)] transition",
        dragging
          ? "rotate-2 scale-[1.02] shadow-[var(--shadow-lift)] ring-2 ring-primary-200"
          : "hover:border-primary-200 hover:shadow-[var(--shadow-card)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-snug text-slate-900">{lead.title}</p>
        {lead.value != null && (
          <span className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-600">
            {formatCurrency(Number(lead.value), lead.currency)}
          </span>
        )}
      </div>

      {lead.company && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-slate-400">
          <Building2 className="h-3 w-3" /> {lead.company}
        </p>
      )}

      {(lead.contact_email || lead.contact_phone) && (
        <div className="mt-2 space-y-0.5 text-xs text-slate-400">
          {lead.contact_email && (
            <p className="flex items-center gap-1.5 truncate">
              <Mail className="h-3 w-3" /> {lead.contact_email}
            </p>
          )}
          {lead.contact_phone && (
            <p className="flex items-center gap-1.5">
              <Phone className="h-3 w-3" /> {lead.contact_phone}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        {lead.contact_name ? (
          <span className="text-xs text-slate-400">{lead.contact_name}</span>
        ) : (
          <span />
        )}
        {lead.assignee && (
          <Avatar
            name={lead.assignee.full_name}
            src={lead.assignee.avatar_url}
            size="xs"
          />
        )}
      </div>
    </div>
  );
}

export function SortableLeadCard({
  lead,
  onClick,
}: {
  lead: LeadWithAssignee;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: lead.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
      className="touch-none"
    >
      <LeadCardContent lead={lead} onClick={onClick} />
    </div>
  );
}

export { GripVertical };
