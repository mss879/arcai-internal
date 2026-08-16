"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Download,
  FilePlus2,
  Loader2,
  Mic,
  Send,
  Sparkles,
  Square,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDictation } from "@/hooks/use-dictation";
import {
  FIRST_NOTICE_NUMBER,
  NOTICE_COMPANY,
  NOTICE_GREETING,
  NOTICE_SIGNOFF,
  displaySubject,
  nextNoticeNumber,
  noticeParagraphs,
} from "@/lib/notice";

import { generateNoticeBody, refineNoticeBody, saveNotice } from "./actions";
import { downloadNoticePdf } from "./download-pdf";
import { SendNoticeModal } from "./send-notice-modal";
import type { ClientLite, NoticePayload, SavedNotice } from "./notices-view";

const fieldCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100";
const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

export function NoticeGenerator({
  pastNotices = [],
  clients = [],
}: {
  pastNotices?: SavedNotice[];
  clients?: ClientLite[];
}) {
  // The notice number fills itself in: highest saved number + 1, exactly like
  // the invoice generator. Once a notice is filed it keeps the number it went
  // out under — "New notice" is what pulls the following one in.
  const pastNumbers = pastNotices.map((n) => n.notice_number);
  const [noticeNumber, setNoticeNumber] = React.useState(() =>
    nextNoticeNumber(pastNumbers),
  );
  // What the next notice gets: everything saved plus whatever's on screen, so
  // the series moves forward even before a save has refreshed the page data.
  const nextNumber = nextNoticeNumber([...pastNumbers, noticeNumber]);

  const [noticeDate, setNoticeDate] = React.useState(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [toName, setToName] = React.useState("");
  const [toDetails, setToDetails] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  /** What the user dictated/typed — the raw intent the AI writes from. */
  const [rawInput, setRawInput] = React.useState("");
  const [loadedId, setLoadedId] = React.useState("");
  /**
   * The Past-notices row this on-screen notice is filed as — null until it's
   * been saved. Re-saving (Download, then Send) updates that row rather than
   * filing a second copy under the same number.
   */
  const [savedId, setSavedId] = React.useState<string | null>(null);

  const [writing, setWriting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [sendOpen, setSendOpen] = React.useState(false);
  const router = useRouter();

  // Dictation appends to whatever's already in the box, so you can speak,
  // type a correction, then speak again.
  const appendDictation = React.useCallback((text: string) => {
    setRawInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
  }, []);
  const dictation = useDictation(appendDictation);

  const { error: dictationError, clearError } = dictation;
  React.useEffect(() => {
    if (!dictationError) return;
    toast.error(dictationError);
    clearError();
  }, [dictationError, clearError]);

  /** Clear the form for the next notice, with the next number filled in. */
  const startNewNotice = () => {
    setLoadedId("");
    setSavedId(null);
    setNoticeNumber(nextNumber);
    setNoticeDate(format(new Date(), "yyyy-MM-dd"));
    setToName("");
    setToDetails("");
    setSubject("");
    setBody("");
    setRawInput("");
  };

  // Load a past notice back into the form — same "re-issue it" affordance the
  // invoice generator has. The blank option resets to a fresh notice.
  const loadPastNotice = (id: string) => {
    setLoadedId(id);
    const n = pastNotices.find((p) => p.id === id);
    if (!n) {
      startNewNotice();
      return;
    }
    // Starting from a past notice files a fresh copy — the loaded row is left
    // untouched, and this one goes out under the next number in the series.
    setSavedId(null);
    setNoticeNumber(nextNumber);
    setNoticeDate((n.notice_date || "").slice(0, 10));
    setToName(n.to_name || "");
    setToDetails(n.to_details || "");
    setSubject(n.subject || "");
    setBody(n.body || "");
    setRawInput(n.source_input || "");
  };

  /** Raw notes -> formal notice. Fills the subject only if it's still empty. */
  const handleWrite = async () => {
    if (!rawInput.trim()) {
      toast.error("Say or type what the notice is about first.");
      return;
    }
    setWriting(true);
    const res = await generateNoticeBody({
      rawInput,
      toName,
      subject: subject.trim() || undefined,
    });
    setWriting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setBody(res.body);
    if (!subject.trim() && res.subject) setSubject(res.subject);
    toast.success("Notice written — edit it below if you like.");
  };

  /** Re-polish whatever's currently in the message box. */
  const handleRefine = async () => {
    if (!body.trim()) {
      toast.error("There's no message to polish yet.");
      return;
    }
    setWriting(true);
    const res = await refineNoticeBody({
      body,
      toName,
      subject: subject.trim() || undefined,
    });
    setWriting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setBody(res.body);
    if (!subject.trim() && res.subject) setSubject(res.subject);
    toast.success("Polished.");
  };

  /** The document exactly as it stands — what gets rendered, sent and saved. */
  const buildPayload = React.useCallback(
    (): NoticePayload => ({
      notice_number: noticeNumber,
      notice_date: noticeDate,
      to_name: toName,
      to_details: toDetails,
      subject,
      body,
    }),
    [noticeNumber, noticeDate, toName, toDetails, subject, body],
  );

  // Save a snapshot to "Past notices", then download the PDF. The download
  // always proceeds even if saving fails — getting the file is the primary
  // action; archiving it is the bonus. (Same trade as the invoice generator.)
  const handleDownload = async () => {
    if (!body.trim()) {
      toast.error("Write the notice message first.");
      return;
    }
    setSaving(true);
    const payload = buildPayload();
    const res = await saveNotice({
      ...payload,
      source_input: rawInput,
      id: savedId ?? undefined,
    });
    if (res.ok) {
      setSavedId(res.id);
      toast.success(`Saved to Past notices as ${payload.notice_number}.`);
      router.refresh();
    } else {
      toast.error(`Couldn't save: ${res.error}`);
    }
    try {
      await downloadNoticePdf(payload);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setSaving(false);
    }
  };

  // Archive the notice as it goes out, so a sent copy always lands in Past
  // notices and can be stamped with its recipient. Returns null on failure —
  // the send still proceeds, just unstamped.
  const persistBeforeSend = React.useCallback(async (): Promise<string | null> => {
    const res = await saveNotice({
      ...buildPayload(),
      source_input: rawInput,
      id: savedId ?? undefined,
    });
    if (!res.ok) return null;
    setSavedId(res.id);
    router.refresh();
    return res.id;
  }, [buildPayload, rawInput, router, savedId]);

  const toLines = toDetails.split("\n").filter(Boolean);
  const displayDate = noticeDate
    ? format(new Date(noticeDate), "dd/MM/yyyy")
    : "";
  const recording = dictation.status === "recording";
  const transcribing = dictation.status === "transcribing";

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Notice Generation
          </h1>
          <p className="text-sm text-slate-500">
            Speak or type the reason — AI writes it up professionally. The
            preview updates live. Click Download to save a PDF.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Only offered once the notice is filed, so it can't wipe a draft. */}
          {savedId && (
            <Button variant="outline" onClick={startNewNotice}>
              <FilePlus2 className="h-4 w-4" />
              New notice ({nextNumber})
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setSendOpen(true)}
            disabled={!body.trim()}
          >
            <Send className="h-4 w-4" />
            Send notice
          </Button>
          <Button onClick={handleDownload} loading={saving}>
            <Download className="h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,400px)_1fr]">
        {/* ---------- FORM ---------- */}
        <div className="no-print space-y-5">
          {pastNotices.length > 0 && (
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">
                Start from…
              </h2>
              <div>
                <label className={labelCls}>A past notice</label>
                <select
                  className={fieldCls}
                  value={loadedId}
                  onChange={(e) => loadPastNotice(e.target.value)}
                >
                  <option value="">New blank notice</option>
                  {pastNotices.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.notice_number} — {n.to_name || "—"}
                      {n.subject ? ` (${n.subject})` : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">
                  Loads the notice&rsquo;s details so you can tweak it and send
                  it out again — under the next notice number.
                </p>
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">
              Notice details
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Notice number</label>
                <input
                  className={fieldCls}
                  value={noticeNumber}
                  onChange={(e) => setNoticeNumber(e.target.value)}
                  placeholder={FIRST_NOTICE_NUMBER}
                />
              </div>
              <div>
                <label className={labelCls}>Notice date</label>
                <input
                  type="date"
                  className={fieldCls}
                  value={noticeDate}
                  onChange={(e) => setNoticeDate(e.target.value)}
                />
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              {savedId
                ? `Filed as ${noticeNumber} — “New notice” starts ${nextNumber}.`
                : "Follows on from the last notice — change it if you need to."}
            </p>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">To</h2>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Name</label>
                <input
                  className={fieldCls}
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                  placeholder="Franley"
                />
              </div>
              <div>
                <label className={labelCls}>Address & contact</label>
                <textarea
                  className={cn(fieldCls, "min-h-[88px] resize-y")}
                  value={toDetails}
                  onChange={(e) => setToDetails(e.target.value)}
                  placeholder={
                    "10, Atapattu Road,\nDehiwala, Sri Lanka\n+94 77 442 9216"
                  }
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  One line per row — shown exactly as typed.
                </p>
              </div>
            </div>
          </section>

          {/* ---------- THE AI BOX ---------- */}
          <section className="rounded-2xl border border-primary-200/70 bg-primary-50/30 p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">
              What&rsquo;s this notice about?
            </h2>
            <p className="mb-4 text-[11px] text-slate-500">
              Say it however it comes out — hit the mic and talk, or just type.
              AI turns it into the formal wording.
            </p>

            <div className="relative">
              <textarea
                className={cn(fieldCls, "min-h-[120px] resize-y pr-12")}
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                placeholder="e.g. tell them the site will be down saturday night from 10 till about 2 for the server upgrade, everything will be back to normal sunday morning"
              />
              <button
                type="button"
                onClick={dictation.toggle}
                disabled={transcribing}
                aria-label={recording ? "Stop dictation" : "Dictate the notice"}
                title={recording ? "Stop dictation" : "Dictate the notice"}
                className={cn(
                  "absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg transition-colors",
                  recording
                    ? "bg-rose-600 text-white hover:bg-rose-700"
                    : "bg-white text-slate-400 ring-1 ring-slate-200 hover:text-primary-600",
                  transcribing && "cursor-not-allowed opacity-60",
                )}
              >
                {transcribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : recording ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
            </div>

            {(recording || transcribing) && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                {recording ? (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                    Listening — press the square when you&rsquo;re done.
                  </>
                ) : (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Writing down what you said…
                  </>
                )}
              </p>
            )}

            <Button
              className="mt-3 w-full"
              onClick={handleWrite}
              loading={writing}
              disabled={!rawInput.trim()}
            >
              <Sparkles className="h-4 w-4" />
              Write the notice
            </Button>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Message</h2>
              <button
                onClick={handleRefine}
                disabled={writing || !body.trim()}
                className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2.5 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Wand2 className="h-3.5 w-3.5" />
                Polish
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Subject</label>
                <input
                  className={fieldCls}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Scheduled Maintenance"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Printed in caps above the greeting. Left blank, AI suggests one.
                </p>
              </div>
              <div>
                <label className={labelCls}>Body</label>
                <textarea
                  className={cn(fieldCls, "min-h-[220px] resize-y")}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write the notice above, or type the body here yourself."
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Blank line between paragraphs. &ldquo;{NOTICE_GREETING}&rdquo;
                  and the signature are added automatically.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ---------- LIVE PREVIEW ---------- */}
        <div className="overflow-x-auto">
          <NoticeDocument
            noticeNumber={noticeNumber}
            displayDate={displayDate}
            toName={toName}
            toLines={toLines}
            subject={subject}
            body={body}
          />
        </div>
      </div>

      {sendOpen && (
        <SendNoticeModal
          open
          onClose={() => setSendOpen(false)}
          getNotice={buildPayload}
          clients={clients}
          onSaved={persistBeforeSend}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The printable notice — same letterhead and sign-off as the invoice. */
/* ------------------------------------------------------------------ */

export function NoticeDocument({
  noticeNumber,
  displayDate,
  toName,
  toLines,
  subject,
  body,
}: {
  noticeNumber: string;
  displayDate: string;
  toName: string;
  toLines: string[];
  subject: string;
  body: string;
}) {
  const paras = noticeParagraphs(body);

  return (
    <div
      id="notice-print"
      className="notice-doc relative mx-auto w-[794px] max-w-full bg-white px-14 py-12 text-neutral-900 shadow-[var(--shadow-lift)] ring-1 ring-slate-200"
    >
      {/* Wordmark — centred, unlike the invoice's left-aligned one */}
      <h1 className="invoice-wordmark text-center font-black text-neutral-900">
        NOTICE
      </h1>

      <div className="mt-6 border-t border-neutral-300" />

      {/* Header: from / to / notice meta */}
      <div className="mt-6 grid grid-cols-3 gap-6 text-[12px] leading-relaxed text-neutral-700">
        <div>
          <p className="font-bold text-neutral-900">{NOTICE_COMPANY.name}</p>
          <p className="mt-1">{NOTICE_COMPANY.phones}</p>
          <p>{NOTICE_COMPANY.email}</p>
          <p>{NOTICE_COMPANY.website}</p>
          {NOTICE_COMPANY.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>

        <div>
          <p className="font-bold text-neutral-900">TO</p>
          <p className="mt-1">{toName || "—"}</p>
          {toLines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>

        <div>
          <p className="font-bold text-neutral-900">NOTICE</p>
          <p className="mt-1">NoticeNumber:{noticeNumber}</p>
          <p>Notice Date: {displayDate}</p>
        </div>
      </div>

      {/* The message — where the invoice carries its line-item table */}
      <div className="mt-10 min-h-[260px] text-[12px] leading-relaxed text-neutral-700">
        <p className="text-[14px] font-bold text-neutral-900">
          {displaySubject(subject)}
        </p>
        <p className="mt-5 text-neutral-900">{NOTICE_GREETING}</p>
        {paras.length > 0 ? (
          paras.map((p, i) => (
            <p key={i} className="mt-3 text-justify">
              {p}
            </p>
          ))
        ) : (
          <p className="mt-3 italic text-neutral-300">
            Your message will appear here.
          </p>
        )}
      </div>

      <div className="mt-10 border-t border-neutral-300" />

      {/* Footer: contact details */}
      <div className="mt-6 grid grid-cols-2 gap-6 text-[12px] leading-relaxed text-neutral-700">
        <div>
          <p className="font-bold text-neutral-900">CONTACT</p>
          <p className="mt-1">{NOTICE_COMPANY.phones}</p>
          <p>{NOTICE_COMPANY.website}</p>
          <p>{NOTICE_COMPANY.email}</p>
          {NOTICE_COMPANY.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        <div />
      </div>

      <div className="mt-12 border-t border-neutral-300" />

      {/* Sign-off */}
      <div className="mt-6">
        <p className="max-w-[60%] text-[12px] font-bold uppercase leading-relaxed text-neutral-900">
          {NOTICE_SIGNOFF.questionsLine}
        </p>
        <div className="mt-8 flex items-end justify-between">
          <span className="text-[13px] font-bold text-neutral-900">
            {NOTICE_SIGNOFF.signerName}
          </span>
          <div className="flex items-end gap-10">
            <span className="pb-1 text-[12px] text-neutral-500">
              {NOTICE_SIGNOFF.signerTitle}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={NOTICE_SIGNOFF.signatureImage}
              alt="Authorised signature"
              className="relative h-20 w-auto -translate-x-10 translate-y-3 object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
