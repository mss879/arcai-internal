import { AlertCircle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";

const STYLES = {
  error: {
    wrap: "bg-rose-50 text-rose-700 ring-rose-200",
    Icon: AlertCircle,
  },
  success: {
    wrap: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    Icon: CheckCircle2,
  },
  info: {
    wrap: "bg-primary-50 text-primary-700 ring-primary-200",
    Icon: Info,
  },
};

export function Alert({
  variant = "info",
  children,
  className,
}: {
  variant?: keyof typeof STYLES;
  children: React.ReactNode;
  className?: string;
}) {
  const { wrap, Icon } = STYLES[variant];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm ring-1 ring-inset",
        wrap,
        className,
      )}
    >
      <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0" />
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
