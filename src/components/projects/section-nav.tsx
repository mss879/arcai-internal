"use client";

/**
 * One nav for the whole Projects section.
 *
 * The board grew four sibling pages — insights, reports, templates and the
 * phone view — and each arrived as another button in the board's header. Seven
 * buttons in a row is not navigation; it is a pile. Worse, two of them
 * (Insights and Reports) are both "analysis" and nothing on screen said which
 * answered what.
 *
 * A strip on every page in the section fixes both: you can always see where
 * you are, always reach the others, and each carries the sentence that says
 * what it is for.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, FolderKanban, Layers, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

const SECTIONS = [
  {
    href: "/projects",
    label: "Board",
    icon: FolderKanban,
    hint: "The work itself",
  },
  {
    href: "/projects/insights",
    label: "Insights",
    icon: Sparkles,
    hint: "What needs you, and anything you want to ask",
  },
  {
    href: "/projects/reports",
    label: "Reports",
    icon: BarChart3,
    hint: "What the numbers say — profit, people, time",
  },
  {
    href: "/projects/templates",
    label: "Templates",
    icon: Layers,
    hint: "The plan a new project starts from",
  },
] as const;

export function ProjectsSectionNav() {
  const pathname = usePathname();

  // `/projects` must not light up for `/projects/reports`, and a project's own
  // page (`/projects/<uuid>`) belongs to the board.
  const activeHref =
    SECTIONS.map((s) => s.href)
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .sort((a, b) => b.length - a.length)[0] ?? "/projects";

  return (
    <nav className="-mx-1 overflow-x-auto px-1 pb-1">
      <div className="inline-flex min-w-max rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {SECTIONS.map((s) => {
          const active = activeHref === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              title={s.hint}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                active
                  ? "bg-primary-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
