"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { TodoFormModal } from "@/components/todos/todo-form-modal";
import type { MemberLite } from "@/lib/types";

export function QuickAddTask({ members }: { members: MemberLite[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/25 backdrop-blur transition hover:bg-white/25"
      >
        <Plus className="h-4 w-4" /> New task
      </button>
      <TodoFormModal
        open={open}
        onClose={() => setOpen(false)}
        members={members}
      />
    </>
  );
}
