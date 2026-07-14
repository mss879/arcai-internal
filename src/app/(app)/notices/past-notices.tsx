"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Download, Mail, ScrollText, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import { NoticeDocument } from "./notice-generator";
import { deleteNotice } from "./actions";
import { downloadNoticePdf } from "./download-pdf";
import { SendNoticeModal } from "./send-notice-modal";
import type { ClientLite, NoticePayload, SavedNotice } from "./notices-view";

/** A saved row as the PDF renderer / emailer wants it. */
function toPayload(n: SavedNotice): NoticePayload {
  return {
    notice_number: n.notice_number,
    notice_date: n.notice_date,
    to_name: n.to_name,
    to_details: n.to_details || "",
    subject: n.subject || "",
    body: n.body || "",
  };
}

export function PastNotices({
  notices,
  clients = [],
}: {
  notices: SavedNotice[];
  clients?: ClientLite[];
}) {
  useRealtimeSync("notices");
  const router = useRouter();
  const [viewing, setViewing] = React.useState<SavedNotice | null>(null);
  const [toDelete, setToDelete] = React.useState<SavedNotice | null>(null);
  const [toSend, setToSend] = React.useState<SavedNotice | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  if (notices.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-6 w-6" />}
        title="No saved notices yet"
        description="Create a notice and click Download — it'll be saved here automatically."
      />
    );
  }

  const handleDelete = async () => {
    if (!toDelete) return;
    const res = await deleteNotice(toDelete.id);
    if (res.ok) {
      toast.success("Notice deleted.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  };

  const handleDownload = async (n: SavedNotice) => {
    setDownloading(true);
    try {
      await downloadNoticePdf(toPayload(n));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Notice</th>
              <th className="px-4 py-3">To</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {notices.map((n) => (
              <tr
                key={n.id}
                className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
              >
                <td className="px-4 py-3 font-semibold text-slate-900">
                  <div className="flex items-center gap-2">
                    {n.notice_number}
                    {n.recipient_email && (
                      <span
                        title={`Emailed to ${n.recipient_email}`}
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                      >
                        <Mail className="h-3 w-3" />
                        Emailed
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">{n.to_name || "—"}</td>
                <td className="max-w-[280px] truncate px-4 py-3 text-slate-600">
                  {n.subject || "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {fmtDate(n.notice_date)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setToSend(n)}
                    >
                      <Send className="h-4 w-4" />
                      Send
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setViewing(n)}
                    >
                      <Download className="h-4 w-4" />
                      View
                    </Button>
                    <button
                      onClick={() => setToDelete(n)}
                      aria-label="Delete notice"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* View + re-download a saved notice */}
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Notice ${viewing.notice_number}` : ""}
        size="xl"
      >
        {viewing && (
          <div className="space-y-4">
            <div className="no-print flex justify-end gap-2">
              <Button variant="outline" onClick={() => setToSend(viewing)}>
                <Send className="h-4 w-4" />
                Send notice
              </Button>
              <Button
                onClick={() => handleDownload(viewing)}
                loading={downloading}
              >
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <div className="overflow-x-auto">
              <NoticeDocument
                noticeNumber={viewing.notice_number}
                displayDate={fmtDate(viewing.notice_date)}
                toName={viewing.to_name}
                toLines={(viewing.to_details || "").split("\n").filter(Boolean)}
                subject={viewing.subject || ""}
                body={viewing.body || ""}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Email a saved notice. Keyed so switching rows resets the dialog. */}
      {toSend && (
        <SendNoticeModal
          key={toSend.id}
          open
          onClose={() => setToSend(null)}
          getNotice={() => toPayload(toSend)}
          noticeId={toSend.id}
          clients={clients}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete notice?"
        description={
          toDelete
            ? `Notice ${toDelete.notice_number} will be removed from Past notices. This cannot be undone.`
            : undefined
        }
      />
    </div>
  );
}

function fmtDate(d: string): string {
  if (!d) return "";
  try {
    return format(new Date(d), "dd/MM/yyyy");
  } catch {
    return d;
  }
}
