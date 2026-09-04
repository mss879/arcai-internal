import { requireProfile } from "@/lib/auth";
import type { ConversationChannel } from "@/lib/database.types";
import {
  listInboxThreads,
  loadInboxThread,
  type InboxFilter,
} from "@/lib/inbox";
import { createClient } from "@/lib/supabase/server";

import { InboxView } from "./inbox-view";

export const metadata = { title: "Inbox" };

const FILTERS: InboxFilter[] = ["all", "mine", "unassigned", "attention", "snoozed"];
const CHANNELS: ConversationChannel[] = ["whatsapp", "sms", "portal", "email"];

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; channel?: string; thread?: string }>;
}) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const params = await searchParams;

  const filter = FILTERS.includes(params.filter as InboxFilter)
    ? (params.filter as InboxFilter)
    : "all";
  const channel = CHANNELS.includes(params.channel as ConversationChannel)
    ? (params.channel as ConversationChannel)
    : "all";

  const [threads, teamRes] = await Promise.all([
    listInboxThreads(supabase, { filter, channel, userId: profile.id }),
    supabase.from("profiles").select("id, full_name, avatar_url").order("full_name"),
  ]);

  // The selected thread is loaded server-side so a deep link opens straight
  // into the conversation rather than flashing an empty pane.
  const selectedKey = params.thread ?? threads[0]?.key ?? null;
  const detail = selectedKey ? await loadInboxThread(supabase, selectedKey) : null;

  return (
    <InboxView
      threads={threads}
      detail={detail}
      filter={filter}
      channel={channel}
      team={teamRes.data ?? []}
      me={profile.id}
    />
  );
}
