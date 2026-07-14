"use client";

import * as React from "react";

/**
 * Push-to-talk dictation for a plain text box: hold the mic on, speak, stop,
 * and the transcript is appended to whatever's already typed. Records with
 * MediaRecorder and posts to /api/assistant/transcribe (Whisper) — the same
 * endpoint the voice assistant uses, so there's one transcription path to keep
 * working.
 *
 * Unlike the assistant's recorder this has no silence auto-stop: dictating a
 * notice means pausing to think, and cutting the recording off mid-thought is
 * worse than making the user press stop.
 */

function pickMimeType(): { mime: string; ext: string } {
  const candidates: { mime: string; ext: string }[] = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "mp4" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  if (typeof MediaRecorder !== "undefined") {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    }
  }
  return { mime: "", ext: "webm" };
}

export type DictationStatus = "idle" | "recording" | "transcribing";

export function useDictation(onText: (text: string) => void) {
  const [status, setStatus] = React.useState<DictationStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  // Keep the newest callback without re-creating start/stop on every keystroke.
  const onTextRef = React.useRef(onText);
  React.useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const teardown = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const transcribe = React.useCallback(async (blob: Blob, ext: string) => {
    setStatus("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, `dictation.${ext}`);
      const res = await fetch("/api/assistant/transcribe", {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "Could not transcribe.");
        return;
      }
      const text = (data?.text ?? "").toString().trim();
      if (text) onTextRef.current(text);
      else setError("Didn't catch that — try again.");
    } catch {
      setError("Could not transcribe audio.");
    } finally {
      setStatus("idle");
    }
  }, []);

  const start = React.useCallback(async () => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "Dictation needs a secure (https) connection."
          : "Microphone isn't available in this browser.",
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked. Allow mic access for this site.");
      return;
    }
    streamRef.current = stream;

    const { mime, ext } = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    );
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      teardown();
      const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
      if (blob.size > 0) void transcribe(blob, ext);
      else setStatus("idle");
    };

    recorder.start();
    setStatus("recording");
  }, [teardown, transcribe]);

  const stop = React.useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else setStatus("idle");
  }, []);

  const toggle = React.useCallback(() => {
    if (status === "recording") stop();
    else if (status === "idle") void start();
  }, [status, start, stop]);

  const clearError = React.useCallback(() => setError(null), []);

  // Never leave the mic light on if the page navigates mid-recording.
  React.useEffect(() => teardown, [teardown]);

  return { status, error, start, stop, toggle, clearError };
}
