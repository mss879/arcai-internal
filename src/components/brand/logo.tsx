import Image from "next/image";

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
      {/* The source PNG is 1310×360 (~830KB); next/image serves a display-
          sized WebP instead of the full file on every page. */}
      <Image
        src="/new-logo.png"
        alt="ARC AI Logo"
        width={1310}
        height={360}
        sizes="300px"
        priority
        className={cn("object-contain shrink-0", dims)}
      />
    </div>
  );
}
