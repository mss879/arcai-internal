import { Skeleton } from "@/components/ui/skeleton";

export default function DeliveryLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-52" />
        <Skeleton className="mt-2 h-4 w-96" />
      </div>
      <Skeleton className="h-11 w-[26rem] rounded-xl" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, col) => (
          <div key={col} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: col === 0 ? 3 : 2 }).map((_, row) => (
              <Skeleton key={row} className="h-40 rounded-2xl" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
