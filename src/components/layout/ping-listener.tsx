"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { MessageSquareText, X } from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { PING_EVENT, REPLY_EVENT, pingTopic, type PingPayload } from "@/lib/ping";

/**
 * Member side of the ephemeral ping feature: listens on the member's own
 * private broadcast channel and pops incoming admin messages up on screen.
 * One reply, then it's gone — nothing is stored anywhere.
 */
export function PingListener({
  userId,
  selfName,
}: {
  userId: string;
  selfName: string;
}) {
  const [ping, setPing] = React.useState<PingPayload | null>(null);
  const [reply, setReply] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const channelRef = React.useRef<RealtimeChannel | null>(null);

  React.useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Private channels are authorized with the user's JWT.
        const {
          data: { session },
        } = await supabase.auth.getSession();
        await supabase.realtime.setAuth(session?.access_token ?? null);
      } catch {
        /* if auth fails the subscribe below just won't join — fine */
      }
      if (cancelled) return;
      channel = supabase
        .channel(pingTopic(userId), { config: { private: true } })
        .on("broadcast", { event: PING_EVENT }, ({ payload }) => {
          const p = payload as PingPayload;
          if (p?.text) {
            setPing(p);
            setReply("");
          }
        })
        .subscribe();
      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      channelRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [userId]);

  async function sendReply() {
    const channel = channelRef.current;
    const text = reply.trim();
    if (!channel || !ping || !text) return;
    setSending(true);
    try {
      const res = await channel.send({
        type: "broadcast",
        event: REPLY_EVENT,
        payload: { id: ping.id, from: selfName, text } satisfies PingPayload,
      });
      if (res !== "ok") throw new Error(String(res));
      setPing(null);
      setReply("");
      toast.success("Reply sent");
    } catch {
      toast.error("Couldn't send the reply — try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <AnimatePresence>
      {ping && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ type: "spring", duration: 0.35 }}
          className="fixed bottom-5 right-5 z-[95] w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border border-primary-200 bg-white p-4 shadow-[var(--shadow-lift)]"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary-50 text-primary-500">
                <MessageSquareText className="h-4 w-4" />
              </span>
              Message from {ping.from}
            </p>
            <button
              onClick={() => setPing(null)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="Dismiss message"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-2.5 whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
            {ping.text}
          </p>

          <div className="mt-3 space-y-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={2}
              placeholder="Type a quick reply…"
              className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPing(null)}>
                Dismiss
              </Button>
              <Button
                size="sm"
                onClick={sendReply}
                loading={sending}
                disabled={!reply.trim()}
              >
                Reply
              </Button>
            </div>
          </div>

          <p className="mt-2 text-center text-[10px] text-slate-300">
            One-time message — nothing is saved.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
