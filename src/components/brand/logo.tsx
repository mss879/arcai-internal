import { cn } from "@/lib/utils";

export function Logo({
  className,
  size = "md",
  variant = "dark",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  variant?: "dark" | "light";
}) {
  const dims = {
    sm: { box: "h-7 w-7 text-sm rounded-lg", text: "text-base" },
    md: { box: "h-9 w-9 text-base rounded-xl", text: "text-lg" },
    lg: { box: "h-11 w-11 text-lg rounded-2xl", text: "text-2xl" },
  }[size];

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src="/arclogo.webp"
        alt="ARC AI Logo"
        className={cn("object-contain shrink-0", dims.box)}
      />
      <div className="leading-none">
        <div
          className={cn(
            "font-bold tracking-tight",
            dims.text,
            variant === "light" ? "text-white" : "text-slate-900",
          )}
        >
          ARC AI
        </div>
      </div>
    </div>
  );
}
