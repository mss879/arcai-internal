"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import {
  generateProposalContent,
  type GeneratedNarrative,
} from "@/lib/ai/proposal";
import {
  includedFeatures,
  proposalPackages,
  selectionSummary,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";
import type { ActionResult } from "@/lib/types";

export type GenerateProposalInput = {
  businessDescription: string;
  clientName: string;
  projectName: string;
  selection: ProposalSelection;
  /** Free-form typed/dictated instructions from the team. */
  extraInstructions?: string;
  /**
   * Whether the writer designs its own sections instead of filling the fixed
   * Overview/Objectives/Key Features/Educational/SEO slots. Undefined leaves
   * the decision to the proposal itself — free-form as soon as more than one
   * package is being sold, because that is exactly what the fixed skeleton
   * cannot describe.
   */
  freeSections?: boolean;
};

export async function generateProposal(
  input: GenerateProposalInput,
): Promise<
  { ok: true; content: GeneratedNarrative } | { ok: false; error: string }
> {
  if (!isOpenAIConfigured()) {
    return {
      ok: false,
      error: "OpenAI isn't configured. Add OPENAI_API_KEY to enable generation.",
    };
  }
  if (!input.businessDescription?.trim()) {
    return { ok: false, error: "Add a short business description first." };
  }
  try {
    const content = await generateProposalContent({
      businessDescription: input.businessDescription,
      clientName: input.clientName?.trim() || "the client",
      projectName: input.projectName?.trim() || "",
      selectionSummary: selectionSummary(input.selection),
      includedFeatures: includedFeatures(input.selection),
      // Every package with its OWN features kept together, so a website and a
      // monthly retainer are written about as two different things instead of
      // one flattened bullet list. Empty for a single-package selection, which
      // is what keeps its prompt byte-identical to what it has always sent.
      packages: proposalPackages(input.selection),
      customFeatures: input.selection.customFeatures,
      teamInstructions: input.extraInstructions,
      projectKind: input.selection.type === "agent" ? "agent" : "website",
      allowFreeSections: input.freeSections,
    });
    return { ok: true, content };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Generation failed.",
    };
  }
}

export type SaveProposalInput = {
  client_name: string;
  project_name: string;
  proposal_date: string;
  selection: ProposalSelection;
  content: ProposalContent;
  grand_total: number;
};

export async function saveProposal(
  input: SaveProposalInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.client_name?.trim()) {
    return { ok: false, error: "Client name is required." };
  }
  if (!input.proposal_date) {
    return { ok: false, error: "Proposal date is required." };
  }

  const { error } = await supabase.from("proposals").insert({
    client_name: input.client_name.trim(),
    project_name: input.project_name.trim(),
    proposal_date: input.proposal_date,
    selection: input.selection,
    content: input.content,
    grand_total: input.grand_total,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/proposals");
  return { ok: true };
}

export type UpdateProposalInput = SaveProposalInput & { id: string };

/**
 * Save an already-stored proposal back over itself.
 *
 * The generator can now reopen a saved proposal, so editing one must not
 * silently leave a second copy behind — this updates the row in place, keeping
 * its id, so anything linked to it (a project, a quote) still points at the
 * document the client is looking at. `selection` and `content` are written
 * exactly as the form produced them: no re-pricing, no reshaping.
 */
export async function updateProposal(
  input: UpdateProposalInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.id) return { ok: false, error: "Which proposal? No id given." };
  if (!input.client_name?.trim()) {
    return { ok: false, error: "Client name is required." };
  }
  if (!input.proposal_date) {
    return { ok: false, error: "Proposal date is required." };
  }

  const { error } = await supabase
    .from("proposals")
    .update({
      client_name: input.client_name.trim(),
      project_name: input.project_name.trim(),
      proposal_date: input.proposal_date,
      selection: input.selection,
      content: input.content,
      grand_total: input.grand_total,
    })
    .eq("id", input.id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/proposals");
  return { ok: true };
}

export async function deleteProposal(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("proposals").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/proposals");
  return { ok: true };
}
