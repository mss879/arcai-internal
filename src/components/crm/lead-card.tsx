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
  stageColor,
  onClick,
}: {
  lead: LeadWithAssignee;
  dragging?: boolean;
  stageColor?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={stageColor ? { borderLeftColor: stageColor, borderLeftWidth: "4px" } : undefined}
      className={cn(
        "group cursor-pointer rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_4px_20px_rgb(0,0,0,0.03)] transition-all duration-200",
        dragging
          ? "rotate-2 scale-[1.03] shadow-xl border-primary-300 ring-4 ring-primary-100/30"
          : "hover:border-primary-300 hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] hover:-translate-y-0.5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold text-slate-800 leading-snug text-[13px] tracking-tight group-hover:text-primary-600 transition-colors">
          {lead.title}
        </p>
        {lead.value != null && (
          <span className="shrink-0 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-600 shadow-xs tracking-tight">
            {formatCurrency(Number(lead.value), lead.currency)}
          </span>
        )}
      </div>

      {lead.company && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
          <Building2 className="h-3.5 w-3.5 text-slate-400/80" />
          <span className="truncate">{lead.company}</span>
        </p>
      )}

      {(lead.contact_email || lead.contact_phone) && (
        <div className="mt-3 space-y-1 rounded-xl bg-slate-50/50 border border-slate-100/70 p-2.5 text-[11px] text-slate-500 transition-colors group-hover:bg-slate-50">
          {lead.contact_email && (
            <p className="flex items-center gap-2 truncate">
              <Mail className="h-3.5 w-3.5 text-slate-400/70 shrink-0" />
              <span className="truncate font-medium">{lead.contact_email}</span>
            </p>
          )}
          {lead.contact_phone && (
            <p className="flex items-center gap-2">
              <Phone className="h-3.5 w-3.5 text-slate-400/70 shrink-0" />
              <span className="font-medium">{lead.contact_phone}</span>
            </p>
          )}
        </div>
      )}

      <div className="mt-3.5 flex items-center justify-between border-t border-slate-100/60 pt-2.5">
        {lead.contact_name ? (
          <span className="text-[11px] font-medium text-slate-400">
            {lead.contact_name}
          </span>
        ) : (
          <span />
        )}
        {lead.assignee && (
          <div className="relative group/avatar">
            <div className="absolute inset-0 rounded-full bg-primary-400 opacity-20 blur-sm scale-95 group-hover/avatar:scale-110 transition duration-300" />
            <Avatar
              name={lead.assignee.full_name}
              src={lead.assignee.avatar_url}
              size="xs"
              className="relative border border-white shadow-xs"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function SortableLeadCard({
  lead,
  stageColor,
  onClick,
}: {
  lead: LeadWithAssignee;
  stageColor?: string;
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
      <LeadCardContent lead={lead} stageColor={stageColor} onClick={onClick} />
    </div>
  );
}

export { GripVertical };
