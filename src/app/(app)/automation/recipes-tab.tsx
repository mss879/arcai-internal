"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Download, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AUTOMATION_RECIPES } from "@/lib/automation-recipes";
import { STEP_META, TRIGGER_META } from "@/lib/automation-meta";

import { installRecipe } from "./actions";

export function RecipesTab({
  installedNames = [],
}: {
  /** Names of the automations that exist, so an installed recipe says so (0112). */
  installedNames?: string[];
}) {
  const [installing, setInstalling] = React.useState<string | null>(null);
  const installed = React.useMemo(() => new Set(installedNames), [installedNames]);
  // Recommended recipes first, in their own order after that.
  const recipes = React.useMemo(
    () =>
      AUTOMATION_RECIPES.filter((r) => r.category !== "delivery").sort(
        (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
      ),
    [],
  );

  async function handleInstall(id: string) {
    setInstalling(id);
    const res = await installRecipe(id);
    setInstalling(null);
    if (res.ok) toast.success("Recipe installed and live — tweak it in Workflows.");
    else toast.error(res.error);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {/* Delivery recipes live in their own gallery: Client Delivery → Automations. */}
      {recipes.map((recipe) => (
        <div
          key={recipe.id}
          className={
            recipe.recommended
              ? "flex flex-col rounded-2xl border border-primary-200 bg-primary-50/30 p-5 shadow-[var(--shadow-card)]"
              : "flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
          }
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden>
              {recipe.emoji}
            </span>
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-900">
                {recipe.name}
                {recipe.recommended && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-primary-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    <Sparkles className="h-3 w-3" /> Recommended
                  </span>
                )}
              </h3>
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
          {installed.has(recipe.name) ? (
            <p className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <Check className="h-4 w-4" /> Installed — edit it in Workflows
            </p>
          ) : (
            <Button
              className="mt-4 w-full"
              variant={recipe.recommended ? "primary" : "outline"}
              onClick={() => handleInstall(recipe.id)}
              loading={installing === recipe.id}
            >
              <Download className="h-4 w-4" />
              Install
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
