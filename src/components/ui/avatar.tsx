"use client";

import * as React from "react";

import { cn, colorFromString, getInitials } from "@/lib/utils";

const SIZES = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-16 w-16 text-xl",
};

export function Avatar({
  name,
  src,
  size = "md",
  className,
  ring,
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  ring?: boolean;
}) {
  const [errored, setErrored] = React.useState(false);
  const label = name ?? "User";
  const showImage = src && !errored;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white select-none",
        ring && "ring-2 ring-white",
        SIZES[size],
        className,
      )}
      style={showImage ? undefined : { backgroundColor: colorFromString(label) }}
      title={label}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={label}
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        getInitials(label)
      )}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 4,
  size = "sm",
}: {
  people: { id: string; full_name: string | null; avatar_url?: string | null }[];
  max?: number;
  size?: keyof typeof SIZES;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-2">
      {shown.map((p) => (
        <Avatar
          key={p.id}
          name={p.full_name}
          src={p.avatar_url}
          size={size}
          ring
        />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            "relative inline-flex items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600 ring-2 ring-white",
            SIZES[size],
          )}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
