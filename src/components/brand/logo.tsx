import { cn } from "@/lib/utils";

export function Logo({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  variant?: "dark" | "light";
}) {
  const dims = {
    sm: "h-8 w-auto",
    md: "h-12 w-auto",
    lg: "h-20 w-auto",
  }[size];

  return (
    <div className={cn("flex items-center justify-center w-full", className)}>
      <img
        src="/new-logo.png?v=2"
        alt="ARC AI Logo"
        className={cn("object-contain shrink-0", dims)}
      />
    </div>
  );
}
