"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult,
  CommissionStatus,
  PaymentStatus,
  ProjectStatus,
} from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// --- Projects --------------------------------------------------
export type ProjectInput = {
  id?: string;
  name: string;
  description?: string;
  client_id?: string | null;
  status?: ProjectStatus;
  budget?: number | null;
  currency?: string;
  start_date?: string | null;
  due_date?: string | null;
};

export async function saveProject(input: ProjectInput): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "Project name is required." };

  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    client_id: input.client_id || null,
    status: input.status ?? "planning",
    budget: input.budget ?? null,
    currency: input.currency || "LKR",
    start_date: input.start_date || null,
    due_date: input.due_date || null,
  };

  const { error } = input.id
    ? await supabase.from("projects").update(payload).eq("id", input.id)
    : await supabase.from("projects").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  return { ok: true };
}

export async function deleteProject(id: string): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  return { ok: true };
}

// --- Payments --------------------------------------------------
export type PaymentInput = {
  id?: string;
  project_id: string;
  amount: number;
  currency?: string;
  status?: PaymentStatus;
  paid_at?: string | null;
  method?: string;
  notes?: string;
  receipt_path?: string | null;
};

export async function savePayment(input: PaymentInput): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a valid amount." };

  const payload = {
    project_id: input.project_id,
    amount: input.amount,
    currency: input.currency || "LKR",
    status: input.status ?? "paid",
    paid_at: input.paid_at || null,
    method: input.method?.trim() || null,
    notes: input.notes?.trim() || null,
    receipt_path: input.receipt_path || null,
  };

  const { error } = input.id
    ? await supabase.from("payments").update(payload).eq("id", input.id)
    : await supabase.from("payments").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/projects");
  return { ok: true };
}

export async function deletePayment(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("payments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// --- Commissions (admin only) ---------------------------------
export type CommissionInput = {
  id?: string;
  project_id: string;
  user_id: string;
  amount: number;
  percentage?: number | null;
  status?: CommissionStatus;
  note?: string;
};

export async function saveCommission(
  input: CommissionInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role, full_name, username")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { ok: false, error: "Only an admin can allocate commissions." };
  }
  if (!input.user_id) return { ok: false, error: "Choose a recipient." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a valid amount." };

  const payload = {
    project_id: input.project_id,
    user_id: input.user_id,
    amount: input.amount,
    percentage: input.percentage ?? null,
    status: input.status ?? "pending",
    note: input.note?.trim() || null,
    allocated_by: user.id,
  };

  let error;
  if (input.id) {
    ({ error } = await supabase
      .from("commissions")
      .update(payload)
      .eq("id", input.id));
  } else {
    ({ error } = await supabase.from("commissions").insert(payload));
    if (!error && input.user_id !== user.id) {
      await supabase.from("notifications").insert({
        user_id: input.user_id,
        actor_id: user.id,
        type: "commission",
        title: "You were allocated a commission",
        body: input.note?.trim() || "Check your profile for details.",
        link: "/profile",
      });
    }
  }

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/profile");
  return { ok: true };
}

export async function deleteCommission(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("commissions").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/profile");
  return { ok: true };
}
