"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Download, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AUTOMATION_RECIPES } from "@/lib/automation-recipes";
import { STEP_META, TRIGGER_META } from "@/lib/automation-meta";

import { installRecipe } from "../automation/actions";

export function AutomationsTab({
  automations,
}: {
  automations: { id: string; name: string; is_active: boolean }[];
}) {
  const router = useRouter();
  const [installing, setInstalling] = React.useState<string | null>(null);
  const installedNames = new Set(automations.map((a) => a.name));

  async function handleInstall(id: string) {
    setInstalling(id);
    const res = await installRecipe(id);
    setInstalling(null);
    if (res.ok) {
      toast.success("Recipe installed and live — tweak it under Automation → Workflows.");
      router.refresh();
    } else toast.error(res.error);
  }

  const recipes = AUTOMATION_RECIPES.filter((r) => r.category === "delivery");

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-2xl border border-slate-200/80 bg-white p-4 text-xs leading-relaxed text-slate-500 shadow-[var(--shadow-card)]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
        <p>
          The content chaser, stalled-project alerts and milestone messages are{" "}
          <span className="font-semibold text-slate-700">built in</span> — switch them on
          in the Settings tab, no recipe needed. The recipes below are the optional
          extras: install one and it goes live immediately (edit or pause it anytime
          under Automation → Workflows). Nothing runs until you install it — including
          the payment auto-start, since onboarding is button-first by your choice.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {recipes.map((recipe) => {
          const installed = installedNames.has(recipe.name);
          return (
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
              {installed ? (
                <div className="mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-50 text-sm font-medium text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  Installed
                </div>
              ) : (
                <Button
                  className="mt-4 w-full"
                  variant="outline"
                  onClick={() => handleInstall(recipe.id)}
                  loading={installing === recipe.id}
                >
                  <Download className="h-4 w-4" />
                  Install
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
