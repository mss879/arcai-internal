"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

import { sendNotice } from "./actions";
import type { ClientLite, NoticePayload } from "./notices-view";

/**
 * The "email this notice" dialog, shared by the generator and Past notices.
 * Pick a client from the directory to fill their address in, or just type one
 * — the field stays editable either way, so a client with a stale address on
 * file doesn't block the send.
 *
 * `getNotice` is a callback rather than a value so the generator sends whatever
 * is on screen at the moment Send is clicked, not a snapshot from when the
 * dialog opened. `onSaved` lets the generator persist first and hand back an
 * id, so the sent notice gets stamped with its recipient.
 *
 * Callers mount this only while it's open, so each send starts from a blank
 * recipient — no reset effect needed.
 */
export function SendNoticeModal({
  open,
  onClose,
  getNotice,
  noticeId,
  clients,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  getNotice: () => NoticePayload;
  /** Set when sending an already-saved notice (Past notices). */
  noticeId?: string;
  clients: ClientLite[];
  /** Save-before-send hook; returns the row id to stamp, or null on failure. */
  onSaved?: () => Promise<string | null>;
}) {
  const router = useRouter();
  const [clientId, setClientId] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const pickClient = (id: string) => {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    if (c?.email) setEmail(c.email);
  };

  const withEmail = clients.filter((c) => c.email);

  async function handleSend() {
    setSending(true);
    try {
      // Persist first when sending from the generator, so the sent copy lands
      // in Past notices stamped with its recipient. A save failure isn't fatal
      // — the email is the point; it just goes out unstamped.
      const savedId = onSaved ? await onSaved() : null;
      const res = await sendNotice({
        id: noticeId ?? savedId ?? undefined,
        notice: getNotice(),
        emails: [email],
        message,
      });
      if (res.ok) {
        toast.success(`Notice sent to ${email}.`);
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send notice"
      description="Email the notice as a branded PDF attachment."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSend} loading={sending} disabled={!email.trim()}>
            <Send className="h-4 w-4" /> Send
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {withEmail.length > 0 && (
          <div>
            <label className="text-sm font-medium text-slate-700">
              Pick a client
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
              value={clientId}
              onChange={(e) => pickClient(e.target.value)}
            >
              <option value="">Choose from the client directory…</option>
              {withEmail.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""} ({c.email})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">
              Fills their address in below — or skip this and type one yourself.
            </p>
          </div>
        )}
        <div>
          <label className="text-sm font-medium text-slate-700">
            Recipient email
          </label>
          <Input
            type="email"
            placeholder="client@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setClientId("");
            }}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-slate-700">
            Message (optional)
          </label>
          <Textarea
            placeholder="Hi — please see the notice attached."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="mt-1"
          />
          <p className="mt-1 text-[11px] text-slate-400">
            A short cover note for the email itself. The notice PDF is attached
            either way.
          </p>
        </div>
      </div>
    </Modal>
  );
}
