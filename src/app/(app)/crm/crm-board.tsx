"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import {
  KanbanSquare,
  MoreVertical,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import {
  LeadCardContent,
  SortableLeadCard,
} from "@/components/crm/lead-card";
import { LeadFormModal } from "@/components/crm/lead-form-modal";
import { STAGE_COLORS } from "@/lib/constants";
import { cn, formatCompactCurrency } from "@/lib/utils";
import type {
  Client,
  Lead,
  LeadWithAssignee,
  MemberLite,
  Pipeline,
  PipelineStage,
} from "@/lib/types";

import {
  createPipeline,
  createStage,
  deleteLead,
  deletePipeline,
  deleteStage,
  updateLeadPositions,
  updateStage,
} from "./actions";

type Items = Record<string, string[]>;

export function CrmBoard({
  pipelines,
  activePipelineId,
  stages,
  leads,
  members,
  clients,
}: {
  pipelines: Pipeline[];
  activePipelineId: string | null;
  stages: PipelineStage[];
  leads: LeadWithAssignee[];
  members: MemberLite[];
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  const router = useRouter();

  const leadMap = React.useMemo(() => {
    const m: Record<string, LeadWithAssignee> = {};
    for (const l of leads) m[l.id] = l;
    return m;
  }, [leads]);

  const buildItems = React.useCallback((): Items => {
    const next: Items = {};
    for (const s of stages) next[s.id] = [];
    for (const l of leads) {
      if (l.stage_id && next[l.stage_id]) next[l.stage_id].push(l.id);
    }
    for (const s of stages)
      next[s.id].sort(
        (a, b) => (leadMap[a]?.position ?? 0) - (leadMap[b]?.position ?? 0),
      );
    return next;
  }, [stages, leads, leadMap]);

  const [items, setItemsState] = React.useState<Items>(buildItems);
  const itemsRef = React.useRef(items);
  React.useEffect(() => {
    const next = buildItems();
    setItemsState(next);
    itemsRef.current = next;
  }, [buildItems]);

  const setItems = React.useCallback((next: Items) => {
    itemsRef.current = next;
    setItemsState(next);
  }, []);

  const [activeId, setActiveId] = React.useState<string | null>(null);

  // Modals
  const [leadModal, setLeadModal] = React.useState<{
    stageId: string;
    lead: Lead | null;
  } | null>(null);
  const [stageModal, setStageModal] = React.useState<PipelineStage | "new" | null>(
    null,
  );
  const [pipelineModal, setPipelineModal] = React.useState(false);
  const [stageToDelete, setStageToDelete] = React.useState<PipelineStage | null>(
    null,
  );
  const [leadToDelete, setLeadToDelete] = React.useState<Lead | null>(null);
  const [confirmPipelineDelete, setConfirmPipelineDelete] =
    React.useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function findContainer(id: string): string | undefined {
    if (id in itemsRef.current) return id;
    return Object.keys(itemsRef.current).find((key) =>
      itemsRef.current[key].includes(id),
    );
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;

    const from = findContainer(activeId);
    const to = findContainer(overId);
    if (!from || !to || from === to) return;

    const current = itemsRef.current;
    const fromItems = current[from];
    const toItems = current[to];
    let newIndex: number;
    if (overId in current) {
      newIndex = toItems.length;
    } else {
      const overIndex = toItems.indexOf(overId);
      newIndex = overIndex >= 0 ? overIndex : toItems.length;
    }

    setItems({
      ...current,
      [from]: fromItems.filter((id) => id !== activeId),
      [to]: [
        ...toItems.slice(0, newIndex),
        activeId,
        ...toItems.slice(newIndex),
      ],
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!overId) return;

    const from = findContainer(activeId);
    const to = findContainer(overId);
    if (!from || !to) return;

    if (from === to) {
      const list = itemsRef.current[from];
      const oldIndex = list.indexOf(activeId);
      const newIndex =
        overId in itemsRef.current ? list.length - 1 : list.indexOf(overId);
      if (oldIndex !== newIndex && newIndex >= 0) {
        setItems({ ...itemsRef.current, [from]: arrayMove(list, oldIndex, newIndex) });
      }
    }

    // Persist affected columns.
    const affected = Array.from(new Set([from, to]));
    const updates = affected.flatMap((stageId) =>
      itemsRef.current[stageId].map((id, index) => ({
        id,
        stage_id: stageId,
        position: index,
      })),
    );
    const res = await updateLeadPositions(updates);
    if (!res.ok) {
      toast.error("Couldn't save changes");
      router.refresh();
    }
  }

  if (pipelines.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="CRM Pipeline"
          description="Track leads through your sales stages with drag & drop."
        />
        <EmptyState
          icon={<KanbanSquare className="h-6 w-6" />}
          title="Create your first pipeline"
          description="Pipelines come with ready-made stages you can customise."
          action={
            <Button onClick={() => setPipelineModal(true)}>
              <Plus className="h-4 w-4" /> New pipeline
            </Button>
          }
        />
        <PipelineModal
          open={pipelineModal}
          onClose={() => setPipelineModal(false)}
        />
      </div>
    );
  }

  const activeLead = activeId ? leadMap[activeId] : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="CRM Pipeline"
        description="Drag leads between stages to update their status."
        actions={
          <Button onClick={() => setLeadModalForFirstStage()}>
            <Plus className="h-4 w-4" /> Add lead
          </Button>
        }
      />

      {/* Pipeline tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {pipelines.map((p) => (
          <button
            key={p.id}
            onClick={() => router.push(`/crm?p=${p.id}`)}
            className={cn(
              "rounded-xl border px-3.5 py-1.5 text-sm font-medium transition",
              p.id === activePipelineId
                ? "border-primary-300 bg-primary-50 text-primary-700"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
            )}
          >
            {p.name}
          </button>
        ))}
        <button
          onClick={() => setPipelineModal(true)}
          className="inline-flex items-center gap-1 rounded-xl border border-dashed border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
        >
          <Plus className="h-4 w-4" /> Pipeline
        </button>
        {activePipelineId && (
          <Dropdown
            trigger={
              <button className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-400 hover:text-slate-700">
                <Settings2 className="h-4 w-4" />
              </button>
            }
          >
            <DropdownItem
              destructive
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setConfirmPipelineDelete(true)}
            >
              Delete pipeline
            </DropdownItem>
          </Dropdown>
        )}
      </div>

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {stages.map((stage) => {
            const ids = items[stage.id] ?? [];
            const total = ids.reduce(
              (s, id) => s + (Number(leadMap[id]?.value) || 0),
              0,
            );
            return (
              <StageColumn
                key={stage.id}
                stage={stage}
                ids={ids}
                count={ids.length}
                total={total}
                onAddLead={() =>
                  setLeadModal({ stageId: stage.id, lead: null })
                }
                onEditStage={() => setStageModal(stage)}
                onDeleteStage={() => setStageToDelete(stage)}
              >
                {ids.map((id) =>
                  leadMap[id] ? (
                    <SortableLeadCard
                      key={id}
                      lead={leadMap[id]}
                      onClick={() =>
                        setLeadModal({ stageId: stage.id, lead: leadMap[id] })
                      }
                    />
                  ) : null,
                )}
              </StageColumn>
            );
          })}

          {/* Add stage */}
          <button
            onClick={() => setStageModal("new")}
            className="flex h-fit w-72 shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-slate-300 py-3 text-sm font-medium text-slate-500 hover:border-primary-300 hover:bg-primary-50/40"
          >
            <Plus className="h-4 w-4" /> Add stage
          </button>
        </div>

        <DragOverlay>
          {activeLead ? <LeadCardContent lead={activeLead} dragging /> : null}
        </DragOverlay>
      </DndContext>

      {/* Modals */}
      {activePipelineId && leadModal && (
        <LeadFormModal
          open
          onClose={() => setLeadModal(null)}
          pipelineId={activePipelineId}
          stages={stages}
          defaultStageId={leadModal.stageId}
          members={members}
          clients={clients}
          lead={leadModal.lead}
        />
      )}

      {activePipelineId && stageModal && (
        <StageModal
          open
          pipelineId={activePipelineId}
          stage={stageModal === "new" ? null : stageModal}
          onClose={() => setStageModal(null)}
        />
      )}

      <PipelineModal
        open={pipelineModal}
        onClose={() => setPipelineModal(false)}
      />

      <ConfirmDialog
        open={!!stageToDelete}
        onClose={() => setStageToDelete(null)}
        title="Delete stage"
        description={`Delete "${stageToDelete?.name}"? Its leads move to the first stage.`}
        onConfirm={async () => {
          if (!stageToDelete || !activePipelineId) return;
          const res = await deleteStage(stageToDelete.id, activePipelineId);
          if (res.ok) {
            toast.success("Stage deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />

      <ConfirmDialog
        open={!!leadToDelete}
        onClose={() => setLeadToDelete(null)}
        title="Delete lead"
        onConfirm={async () => {
          if (!leadToDelete) return;
          const res = await deleteLead(leadToDelete.id);
          if (res.ok) {
            toast.success("Lead deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />

      <ConfirmDialog
        open={confirmPipelineDelete}
        onClose={() => setConfirmPipelineDelete(false)}
        title="Delete pipeline"
        description="This removes the pipeline, its stages and all its leads."
        onConfirm={async () => {
          if (!activePipelineId) return;
          const res = await deletePipeline(activePipelineId);
          if (res.ok) {
            toast.success("Pipeline deleted");
            const remaining = pipelines.filter((p) => p.id !== activePipelineId);
            router.push(remaining[0] ? `/crm?p=${remaining[0].id}` : "/crm");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );

  function setLeadModalForFirstStage() {
    if (stages[0]) setLeadModal({ stageId: stages[0].id, lead: null });
    else setStageModal("new");
  }
}

function StageColumn({
  stage,
  ids,
  count,
  total,
  onAddLead,
  onEditStage,
  onDeleteStage,
  children,
}: {
  stage: PipelineStage;
  ids: string[];
  count: number;
  total: number;
  onAddLead: () => void;
  onEditStage: () => void;
  onDeleteStage: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: stage.color }}
          />
          <span className="text-sm font-semibold text-slate-800">
            {stage.name}
          </span>
          <span className="rounded-full bg-slate-100 px-1.5 text-xs font-medium text-slate-500">
            {count}
          </span>
        </div>
        <Dropdown
          trigger={
            <button className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <MoreVertical className="h-4 w-4" />
            </button>
          }
        >
          <DropdownItem
            icon={<Settings2 className="h-4 w-4" />}
            onClick={onEditStage}
          >
            Edit stage
          </DropdownItem>
          <DropdownItem
            destructive
            icon={<Trash2 className="h-4 w-4" />}
            onClick={onDeleteStage}
          >
            Delete stage
          </DropdownItem>
        </Dropdown>
      </div>

      {total > 0 && (
        <p className="mb-2 px-1 text-xs font-medium text-slate-400">
          {formatCompactCurrency(total)}
        </p>
      )}

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[120px] flex-1 flex-col gap-2.5 rounded-2xl border border-slate-200/70 bg-slate-50/60 p-2.5 transition",
          isOver && "border-primary-300 bg-primary-50/60",
        )}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
        <button
          onClick={onAddLead}
          className="flex items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 py-2 text-xs font-medium text-slate-400 transition hover:border-primary-300 hover:text-primary-600"
        >
          <Plus className="h-3.5 w-3.5" /> Add lead
        </button>
      </div>
    </div>
  );
}

function StageModal({
  open,
  pipelineId,
  stage,
  onClose,
}: {
  open: boolean;
  pipelineId: string;
  stage: PipelineStage | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState(STAGE_COLORS[0]);

  React.useEffect(() => {
    if (open) {
      setName(stage?.name ?? "");
      setColor(stage?.color ?? STAGE_COLORS[0]);
    }
  }, [open, stage]);

  function submit() {
    startTransition(async () => {
      const res = stage
        ? await updateStage(stage.id, { name, color })
        : await createStage(pipelineId, name, color);
      if (res.ok) {
        toast.success(stage ? "Stage updated" : "Stage added");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={stage ? "Edit stage" : "Add stage"}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {stage ? "Save" : "Add stage"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Stage name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Negotiation"
            autoFocus
          />
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {STAGE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-8 w-8 rounded-full ring-2 ring-offset-2 transition",
                  color === c ? "ring-slate-400" : "ring-transparent",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function PipelineModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");

  React.useEffect(() => {
    if (open) setName("");
  }, [open]);

  function submit() {
    startTransition(async () => {
      const res = await createPipeline(name);
      if (res.ok) {
        toast.success("Pipeline created");
        router.push(`/crm?p=${res.id}`);
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New pipeline"
      description="Starts with a default set of stages you can customise."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Create pipeline
          </Button>
        </>
      }
    >
      <Field label="Pipeline name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sales 2026"
          autoFocus
        />
      </Field>
    </Modal>
  );
}
