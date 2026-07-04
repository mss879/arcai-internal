"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AUTOMATION_RECIPES } from "@/lib/automation-recipes";
import { STEP_META, TRIGGER_META } from "@/lib/automation-meta";

import { installRecipe } from "./actions";

export function RecipesTab() {
  const [installing, setInstalling] = React.useState<string | null>(null);

  async function handleInstall(id: string) {
    setInstalling(id);
    const res = await installRecipe(id);
    setInstalling(null);
    if (res.ok) toast.success("Recipe installed and live — tweak it in Workflows.");
    else toast.error(res.error);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {AUTOMATION_RECIPES.map((recipe) => (
        <div
          key={recipe.id}
          className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden>
              {recipe.emoji}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{recipe.name}</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Trigger: {TRIGGER_META[recipe.trigger].label}
              </p>
            </div>
          </div>
          <p className="mt-3 flex-1 text-sm leading-relaxed text-slate-500">
            {recipe.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {recipe.steps.map((s, i) => (
              <span
                key={i}
                className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
              >
                {STEP_META[s.kind].label}
              </span>
            ))}
          </div>
          <Button
            className="mt-4 w-full"
            variant="outline"
            onClick={() => handleInstall(recipe.id)}
            loading={installing === recipe.id}
          >
            <Download className="h-4 w-4" />
            Install
          </Button>
        </div>
      ))}
    </div>
  );
}
