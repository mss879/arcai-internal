import { CalendarDays, KanbanSquare, Users, Wallet } from "lucide-react";

import { Logo } from "@/components/brand/logo";

const FEATURES = [
  { icon: KanbanSquare, label: "Drag-and-drop CRM pipelines" },
  { icon: CalendarDays, label: "Shared calendar & to-dos" },
  { icon: Wallet, label: "Projects, payments & commissions" },
  { icon: Users, label: "Invite your team in seconds" },
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden gradient-primary lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(40rem 40rem at 80% -10%, rgba(255,255,255,0.18), transparent 60%), radial-gradient(30rem 30rem at -10% 100%, rgba(34,184,207,0.35), transparent 55%)",
          }}
        />
        <div className="relative">
          <Logo variant="light" size="lg" />
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight text-white">
            One shared workspace for your whole agency.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-white/75">
            Manage clients, projects, payments and your pipeline — together, in
            real time.
          </p>

          <ul className="mt-8 space-y-3">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex items-center gap-3 text-white/90">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15 backdrop-blur">
                  <f.icon className="h-4.5 w-4.5" />
                </span>
                <span className="text-sm font-medium">{f.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-white/50">
          © {new Date().getFullYear()} ARC AI. All rights reserved.
        </div>
      </div>

      {/* Form panel */}
      <div className="app-bg flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo size="md" />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
