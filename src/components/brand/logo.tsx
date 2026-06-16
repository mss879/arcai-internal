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
    sm: "h-12 w-12",
    md: "h-20 w-20",
    lg: "h-32 w-32",
  }[size];

  return (
    <div className={cn("flex items-center justify-center w-full", className)}>
      <img
        src="/arclogo.webp"
        alt="ARC AI Logo"
        className={cn("object-contain shrink-0", dims)}
      />
    </div>
  );
}
