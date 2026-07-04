"use server";

import { revalidatePath } from "next/cache";

import {
  enrollAutomationRun,
  processDueAutomationRuns,
  scanTimeBasedTriggers,
} from "@/lib/automation";
import { getRecipe } from "@/lib/automation-recipes";
import { processFinanceReminders } from "@/lib/finance";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult, Automation } from "@/lib/types";
import type {
  AutomationStepKind,
  AutomationTrigger,
} from "@/lib/database.types";

// --- Automations ------------------------------------------------

export async function createAutomation(
  name: string,
): Promise<ActionResult<{ automation: Automation }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .from("automations")
    .insert({ name: name.trim() || "Untitled automation", is_active: false })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true, automation: data as Automation };
}

export async function updateAutomation(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    is_active?: boolean;
    trigger?: AutomationTrigger;
    trigger_config?: Record<string, unknown>;
    conditions?: Record<string, unknown>[];
  },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("automations").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function deleteAutomation(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("automations").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export type AutomationStepInput = {
  kind: AutomationStepKind;
  config: Record<string, unknown>;
};

/** Replace an automation's steps wholesale (the builder saves all at once). */
export async function saveAutomationSteps(
  automationId: string,
  steps: AutomationStepInput[],
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error: delError } = await supabase
    .from("automation_steps")
    .delete()
    .eq("automation_id", automationId);
  if (delError) return { ok: false, error: delError.message };

  if (steps.length > 0) {
    const { error } = await supabase.from("automation_steps").insert(
      steps.map((s, i) => ({
        automation_id: automationId,
        position: i,
        kind: s.kind,
        config: s.config,
      })),
    );
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/automation");
  return { ok: true };
}

// --- Recipes ----------------------------------------------------

export async function installRecipe(
  recipeId: string,
): Promise<ActionResult<{ automationId: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, error: "Unknown recipe." };

  const { data: automation, error } = await supabase
    .from("automations")
    .insert({
      name: recipe.name,
      description: recipe.description,
      trigger: recipe.trigger,
      trigger_config: recipe.trigger_config,
      conditions: recipe.conditions,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !automation) {
    return { ok: false, error: error?.message ?? "Could not install." };
  }

  const { error: stepsError } = await supabase.from("automation_steps").insert(
    recipe.steps.map((s, i) => ({
      automation_id: automation.id,
      position: i,
      kind: s.kind,
      config: s.config,
    })),
  );
  if (stepsError) return { ok: false, error: stepsError.message };

  revalidatePath("/automation");
  return { ok: true, automationId: automation.id };
}

// --- Test run ---------------------------------------------------

/** Fire an automation manually with a test contact so flows can be verified. */
export async function testAutomation(
  automationId: string,
  contact: { name: string; phone?: string; email?: string },
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: automation } = await supabase
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .single();
  if (!automation) return { ok: false, error: "Automation not found." };

  await enrollAutomationRun(supabase, automation as Automation, {
    trigger: automation.trigger,
    payload: {
      name: contact.name,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      test: true,
    },
  });
  revalidatePath("/automation");
  return { ok: true };
}

// --- Runs -------------------------------------------------------

export async function cancelAutomationRun(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("automation_runs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function deleteAutomationRun(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("automation_runs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

/** Advance timers while the page is open (cron covers the rest). */
export async function tickAutomations(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  // Service client: steps send SMS/email and write bookkeeping regardless
  // of which member happens to have the page open.
  const admin = createAdminClient();
  await scanTimeBasedTriggers(admin);
  await processDueAutomationRuns(admin);
  await processFinanceReminders(admin);
}

// --- Webhooks + API keys ---------------------------------------

export async function createWebhookEndpoint(input: {
  name: string;
  action: "create_lead" | "fire_automation";
  config: Record<string, unknown>;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("webhook_endpoints").insert({
    name: input.name.trim() || "Inbound webhook",
    action: input.action,
    config: input.config,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function deleteWebhookEndpoint(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("webhook_endpoints").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function createApiKey(name: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("api_keys")
    .insert({ name: name.trim() || "API key" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function setApiKeyActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("api_keys")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}

export async function deleteApiKey(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("api_keys").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/automation");
  return { ok: true };
}
