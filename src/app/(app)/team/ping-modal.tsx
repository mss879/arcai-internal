"use client";

import * as React from "react";
import { toast } from "sonner";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { PING_EVENT, REPLY_EVENT, pingTopic, type PingPayload } from "@/lib/ping";
import type { Profile } from "@/lib/types";

type Bubble = { key: string; from: string; text: string; mine: boolean };

/**
 * Admin side of the ephemeral ping feature: sends a pop-up message to an
 * online member and shows their replies live. The conversation exists only
 * inside this open modal — close it and everything is gone (broadcast
 * messages are never stored).
 */
export function PingModal({
  member,
  adminName,
  onClose,
}: {
  member: Profile | null;
  adminName: string;
  onClose: () => void;
}) {
  const [text, setText] = React.useState("");
  const [thread, setThread] = React.useState<Bubble[]>([]);
  const [ready, setReady] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const channelRef = React.useRef<RealtimeChannel | null>(null);

  React.useEffect(() => {
    if (!member) return;
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setThread([]);
    setText("");
    setReady(false);

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        await supabase.realtime.setAuth(session?.access_token ?? null);
      } catch {
        /* subscribe below will simply fail to join */
      }
      if (cancelled) return;
      channel = supabase
        .channel(pingTopic(member.id), { config: { private: true } })
        .on("broadcast", { event: REPLY_EVENT }, ({ payload }) => {
          const p = payload as PingPayload;
          if (p?.text) {
            setThread((t) => [
              ...t,
              { key: `${p.id}-${t.length}`, from: p.from, text: p.text, mine: false },
            ]);
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setReady(true);
        });
      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      channelRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [member]);

  async function send() {
    const channel = channelRef.current;
    const body = text.trim();
    if (!channel || !member || !body) return;
    setSending(true);
    try {
      const payload: PingPayload = {
        id: crypto.randomUUID(),
        from: adminName,
        text: body,
      };
      const res = await channel.send({
        type: "broadcast",
        event: PING_EVENT,
        payload,
      });
      if (res !== "ok") throw new Error(String(res));
      setThread((t) => [
        ...t,
        { key: payload.id, from: adminName, text: body, mine: true },
      ]);
      setText("");
    } catch {
      toast.error("Couldn't send — they may have just gone offline.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={`Message ${member?.full_name || member?.username || ""}`}
      size="sm"
    >
      {member && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            Pops up on their screen right now. One-time only — nothing is
            saved, and closing this window ends the conversation.
          </p>

          {thread.length > 0 && (
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3">
              {thread.map((b) => (
                <div
                  key={b.key}
                  className={cn("flex", b.mine ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-xl px-3 py-2 text-sm",
                      b.mine
                        ? "bg-primary-600 text-white"
                        : "bg-white text-slate-700 ring-1 ring-slate-200",
                    )}
                  >
                    {!b.mine && (
                      <p className="text-[10px] font-semibold text-primary-600">
                        {b.from}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{b.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            autoFocus
            placeholder={`Type a message to ${member.full_name || member.username}…`}
            className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">
              {ready ? "Connected — replies appear here." : "Connecting…"}
            </span>
            <Button onClick={send} loading={sending} disabled={!text.trim() || !ready}>
              Send pop-up
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
