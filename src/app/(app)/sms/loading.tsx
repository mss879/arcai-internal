import { Skeleton } from "@/components/ui/skeleton";

export default function SmsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-6 w-48 rounded-full" />
      </div>

      <Skeleton className="h-11 w-full max-w-xl rounded-xl" />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm">
          <Skeleton className="mb-2 h-5 w-40" />
          <Skeleton className="mb-5 h-3 w-2/3" />
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-11 rounded-xl" />
            <Skeleton className="h-11 rounded-xl" />
          </div>
          <Skeleton className="mb-4 h-28 rounded-xl" />
          <div className="flex justify-end">
            <Skeleton className="h-10 w-32 rounded-xl" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-5 w-48" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
