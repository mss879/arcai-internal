import { createClient } from "@/lib/supabase/server";

import { MeetingsView } from "./meetings-view";

export const metadata = { title: "Meetings" };

export default async function MeetingsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("meeting_links")
    .select("*, bookings:meeting_bookings(count)")
    .order("created_at", { ascending: false });

  return (
    <MeetingsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      links={(data ?? []) as any}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
