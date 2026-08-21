import { NextResponse } from "next/server";

import type { Database, WaLanguage, WaMessageStatus } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  detectWaOptOut,
  handleInboundPaymentSlip,
  handleInboundWaMessage,
  handleWaOptOut,
} from "@/lib/wa-agent";
import {
  baseLanguage,
  detectScriptLanguage,
  whisperLanguageToCode,
} from "@/lib/wa-lang";
import { markWhatsAppRead, verifyWaSignature, whatsAppVerifyToken } from "@/lib/whatsapp";

/**
 * Meta WhatsApp Business Cloud API webhook.
 *
 * Point the webhook at  https://<your-domain>/api/whatsapp/webhook  in the
 * Meta App Dashboard (WhatsApp → Configuration), subscribe to the
 * `messages` field, and use WHATSAPP_VERIFY_TOKEN as the verify token.
 *
 *   GET   the one-time subscription handshake (hub.challenge echo)
 *   POST  inbound messages + delivery statuses. Each message is stored,
 *         deduped (Meta retries!), run through keyword rules, fired into
 *         the automation engine and finally answered by the AI agent.
 *
 * Always answers 200 — a thrown error would make Meta retry forever and
 * eventually disable the webhook.
 */

type WaWebhookMessage = {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  // An emoji reaction on an earlier message. `emoji` is absent when the
  // customer REMOVES their reaction; `message_id` is the wa_message_id of
  // the message they reacted to.
  reaction?: { message_id?: string; emoji?: string };
};

type WaWebhookValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaWebhookMessage[];
  statuses?: {
    id?: string;
    status?: string;
    errors?: { code?: number; title?: string; message?: string }[];
  }[];
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && token && token === whatsAppVerifyToken()) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed." }, { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (!verifyWaSignature(raw, request.headers.get("x-hub-signature-256"))) {
    // Signed apps only: reject forgeries outright.
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let payload: { entry?: { changes?: { value?: WaWebhookValue }[] }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    const supabase = createAdminClient();
    const ownNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        // Multi-number safety: ignore events for numbers we don't manage.
        if (
          ownNumberId &&
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== ownNumberId
        ) {
          continue;
        }

        await handleStatuses(supabase, value);
        await handleMessages(supabase, value);
      }
    }
  } catch (e) {
    console.error("[whatsapp] webhook processing failed:", e);
  }

  return NextResponse.json({ ok: true });
}

type DB = ReturnType<typeof createAdminClient>;

async function handleStatuses(supabase: DB, value: WaWebhookValue): Promise<void> {
  for (const status of value.statuses ?? []) {
    if (!status.id || !status.status) continue;
    const mapped: WaMessageStatus | null =
      status.status === "sent"
        ? "sent"
        : status.status === "delivered"
          ? "delivered"
          : status.status === "read"
            ? "read"
            : status.status === "failed"
              ? "failed"
              : null;
    if (!mapped) continue;

    const patch: Database["public"]["Tables"]["wa_messages"]["Update"] = {
      status: mapped,
    };
    if (mapped === "failed") {
      // Keep Meta's numeric code in front — cold outreach reads it to tell
      // "not on WhatsApp" (131026) apart from other delivery failures.
      const err = status.errors?.[0];
      patch.error =
        [err?.code, err?.message || err?.title].filter(Boolean).join(" ") ||
        "Delivery failed.";
    }

    let query = supabase.from("wa_messages").update(patch).eq("wa_message_id", status.id);
    // Never downgrade read → delivered when statuses arrive out of order.
    if (mapped === "delivered") query = query.in("status", ["sent", "delivered"]);
    await query;
  }
}

async function handleMessages(supabase: DB, value: WaWebhookValue): Promise<void> {
  for (const message of value.messages ?? []) {
    const waId = (message.from ?? "").replace(/[^\d]/g, "");
    if (!waId) continue;

    const profileName =
      value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null;

    // Find-or-create the contact first — media storage needs its id.
    let { data: contact } = await supabase
      .from("wa_contacts")
      .select("*")
      .eq("wa_id", waId)
      .maybeSingle();
    if (!contact) {
      // Stamp whichever campaign was live the moment they first wrote —
      // that's how each campaign's lead count is counted later. Costs two
      // queries, but only ever on a contact's first message.
      const campaignId = await activeCampaignId(supabase);
      const { data: created } = await supabase
        .from("wa_contacts")
        .upsert(
          { wa_id: waId, profile_name: profileName, campaign_id: campaignId },
          { onConflict: "wa_id" },
        )
        .select("*")
        .single();
      contact = created;
    }
    if (!contact) continue;

    // A reaction annotates an existing message rather than being one of its
    // own, and WhatsApp allows exactly ONE per person per message. So clear
    // any earlier reaction from this contact on the same target first —
    // otherwise swapping 👍 for ❤️ would leave both behind. A REMOVED
    // reaction arrives in this same shape with no emoji, and that delete is
    // the entire job.
    if (message.type === "reaction") {
      const target = message.reaction?.message_id?.trim();
      if (!target) continue;
      await supabase
        .from("wa_messages")
        .delete()
        .eq("contact_id", contact.id)
        .eq("message_type", "reaction")
        .eq("meta->>reaction_target", target);
      if (!message.reaction?.emoji?.trim()) {
        if (message.id) void markWhatsAppRead(message.id);
        continue;
      }
    }

    // Media is heavy (download + vision) — skip Meta's retries before
    // paying for it. Text still relies on the upsert dedupe below.
    const isMedia = message.type === "image" || message.type === "document";
    if (isMedia && message.id) {
      const { data: dupe } = await supabase
        .from("wa_messages")
        .select("id")
        .eq("wa_message_id", message.id)
        .limit(1);
      if (dupe?.length) continue;
    }

    // Body: text, a transcribed voice note, or an analyzed image/document —
    // so the agent can "see" whatever the customer sends.
    let body = extractBody(message);
    let isVoice = false;
    let meta: Record<string, unknown> = {};
    let voiceLanguage: "en" | "si" | "ta" | null = null;
    if (message.type === "audio" && message.audio?.id) {
      const transcript = await transcribeVoiceNote(
        message.audio.id,
        contact.language ? baseLanguage(contact.language) : undefined,
      );
      if (transcript) {
        body = transcript.text;
        isVoice = true;
        voiceLanguage = transcript.language;
        meta = { voice: true, ...(transcript.language ? { language: transcript.language } : {}) };
      }
    } else if (message.type === "image" && message.image?.id) {
      const media = await ingestInboundMedia(supabase, contact.id, message.image.id, "image");
      const analysis = media ? await analyzeInboundImage(media.url) : null;
      const caption = message.image.caption?.trim();
      body = `📷 ${analysis?.description || "[photo]"}${caption ? ` — "${caption}"` : ""}`;
      meta = {
        image: true,
        ...(media
          ? { image_url: media.url, mime: media.mimeType, size: media.size }
          : {}),
        ...(analysis ? { kind: analysis.kind, slip: analysis.slip } : {}),
      };
    } else if (message.type === "document" && message.document?.id) {
      const media = await ingestInboundMedia(
        supabase,
        contact.id,
        message.document.id,
        "document",
      );
      const filename = message.document.filename?.trim() || "document";
      const caption = message.document.caption?.trim();
      // PDFs get READ (0086): text out, one-line AI summary in — so the
      // agent genuinely knows what a brand guide, catalog or slip says
      // instead of seeing only a filename.
      const isPdf =
        (media?.mimeType ?? message.document.mime_type ?? "").includes("pdf") ||
        filename.toLowerCase().endsWith(".pdf");
      const pdf =
        media && isPdf ? await analyzeInboundPdf(media.data, filename) : null;
      body = pdf
        ? `📄 ${filename} — ${pdf.summary}${caption ? ` — "${caption}"` : ""}`
        : `📄 [document] ${filename}${caption ? ` — "${caption}"` : ""}`;
      meta = {
        document: true,
        filename,
        ...(media
          ? { document_url: media.url, mime: media.mimeType, size: media.size }
          : {}),
        ...(pdf
          ? { doc_kind: pdf.doc_kind, doc_summary: pdf.summary }
          : media && isPdf
            ? { doc_unreadable: true }
            : {}),
      };
    } else if (message.type === "reaction") {
      // Tagged with the message it targets so the inbox can render it ON
      // that bubble instead of as a message in its own right.
      meta = {
        reaction: true,
        reaction_target: message.reaction?.message_id?.trim() ?? null,
      };
    }
    const now = new Date().toISOString();

    // Store the message; the unique wa_message_id dedupes Meta's retries.
    const { data: stored } = await supabase
      .from("wa_messages")
      .upsert(
        {
          contact_id: contact.id,
          wa_message_id: message.id ?? null,
          direction: "in",
          message_type: message.type ?? "text",
          body: isVoice ? `🎤 ${body}` : body,
          status: "received",
          ...(Object.keys(meta).length ? { meta } : {}),
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      )
      .select("id");
    // Already processed this exact message on a previous delivery attempt.
    if (message.id && (stored ?? []).length === 0) continue;

    // Language: native Sinhala/Tamil SCRIPT in a typed message always wins
    // (it also captures their script preference). A voice note's detected
    // language only fills a blank/English slot — it must never clobber a
    // romanized "Singlish" classification (they type Latin, Whisper hears
    // Sinhala). Plain-Latin text never downgrades anything — the agent's
    // set_language tool handles romanized detection.
    let language: WaLanguage | null = contact.language;
    const scriptLang = isVoice ? null : detectScriptLanguage(body);
    if (scriptLang) language = scriptLang;
    else if (
      (voiceLanguage === "si" || voiceLanguage === "ta") &&
      (!language || language === "en")
    )
      language = voiceLanguage;

    await supabase
      .from("wa_contacts")
      .update({
        profile_name: profileName ?? contact.profile_name,
        unread: (contact.unread ?? 0) + 1,
        last_message_at: now,
        last_inbound_at: now,
        last_message_preview: body.slice(0, 160),
        last_direction: "in",
        language,
        // Any reply instantly clears the autonomous follow-up cadence —
        // including the post-call hold, so the agent is free to work the
        // conversation again the moment they actually speak to us.
        followup_stage: 0,
        next_followup_at: null,
        post_call_checkin_sent_at: null,
      })
      .eq("id", contact.id);
    contact.profile_name = profileName ?? contact.profile_name;
    contact.last_inbound_at = now;
    contact.language = language;
    contact.followup_stage = 0;
    contact.next_followup_at = null;

    // Blue ticks + "typing…" right away — the queued agent reply follows.
    if (message.id) void markWhatsAppRead(message.id);

    if (isMedia) {
      // Durable CRM memory: what the customer sent lives on the lead too.
      if (contact.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: contact.lead_id,
          kind: "note",
          title: `Customer sent ${message.type === "image" ? `image — ${String((meta as { kind?: string }).kind ?? "photo")}` : "a document"}`,
          body: [body, (meta.image_url ?? meta.document_url ?? null) as string | null]
            .filter(Boolean)
            .join("\n"),
          actor_id: null,
        });
      }

      // Payment-slip watch: a classified slip always alerts the team — in
      // ANY mode, so a balance payment mid-onboarding still surfaces. The
      // fuzzy path is now only for media the analyzers couldn't read (0086:
      // it used to be EVERY document, which meant a client's brand-guide
      // PDF during onboarding pinged accounts) — and never in onboarding,
      // where unclassified files are almost certainly assets.
      const kind = (meta as { kind?: string }).kind;
      const docKind = (meta as { doc_kind?: string }).doc_kind;
      const certainSlip = kind === "payment_slip" || docKind === "payment_slip";
      const maybeSlip =
        contact.mode !== "onboarding" &&
        ((message.type === "image" && !kind) ||
          (message.type === "document" && !docKind));
      if (certainSlip || maybeSlip) {
        await handleInboundPaymentSlip(supabase, contact, {
          description: body,
          mediaUrl: (meta.image_url ?? meta.document_url ?? null) as string | null,
          slip: (meta as { slip?: InboundSlip }).slip ?? null,
          requirePendingInstallment: !certainSlip,
        });
      }
    }

    // Text, transcribed voice AND analyzed media all reach the rules +
    // agent — the 📷/📄 description line is how the agent "sees" media.
    const textual =
      ["text", "button", "interactive", "image", "document"].includes(
        message.type ?? "text",
      ) || isVoice;
    if (body && textual) {
      if (!contact.do_not_contact && detectWaOptOut(body)) {
        await handleWaOptOut(supabase, contact);
      } else {
        await handleInboundWaMessage(supabase, contact, body, message.id ?? null, {
          // AI image descriptions must not trip keyword auto-replies.
          skipRules: isMedia,
        });
      }
    }
  }
}

/** The campaign the agent is currently selling, when campaign mode is on.
 * Only one row can be "active" at a time (migration 0065). */
async function activeCampaignId(supabase: DB): Promise<string | null> {
  const { data: config } = await supabase
    .from("wa_agent_config")
    .select("campaign_mode_enabled")
    .eq("id", 1)
    .maybeSingle();
  if (!config?.campaign_mode_enabled) return null;

  const { data } = await supabase
    .from("wa_campaigns")
    .select("id")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

type InboundSlip = {
  amount?: number | null;
  currency?: string | null;
  date?: string | null;
  bank?: string | null;
  reference?: string | null;
} | null;

type ImageAnalysis = {
  kind:
    | "payment_slip"
    | "website"
    | "logo"
    | "product"
    | "brand_asset"
    | "photo"
    | "content_doc"
    | "other";
  description: string;
  slip: InboundSlip;
};

type PdfAnalysis = {
  doc_kind:
    | "payment_slip"
    | "brand_asset"
    | "content_doc"
    | "company_profile"
    | "other";
  summary: string;
};

/** Download inbound media and persist it to storage. Null on any failure —
 * the message still stores with a generic body, nothing is lost. */
async function ingestInboundMedia(
  supabase: DB,
  contactId: string,
  mediaId: string,
  label: "image" | "document",
): Promise<{ url: string; mimeType: string; size: number; data: Buffer } | null> {
  try {
    const { downloadWaMedia } = await import("@/lib/whatsapp");
    const media = await downloadWaMedia(mediaId);
    if (!media.ok) return null;
    if (media.data.length > 10 * 1024 * 1024) return null; // 10MB guard

    const { STORAGE_BUCKETS } = await import("@/lib/constants");
    const ext = extFromMime(media.mimeType, label);
    const path = `inbound/${contactId}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKETS.waMedia)
      .upload(path, media.data, { contentType: media.mimeType, upsert: true });
    if (error) return null;
    const { data } = supabase.storage
      .from(STORAGE_BUCKETS.waMedia)
      .getPublicUrl(path);
    // The buffer rides along so PDF extraction needn't re-download.
    return {
      url: data.publicUrl,
      mimeType: media.mimeType,
      size: media.data.length,
      data: media.data,
    };
  } catch (e) {
    console.error(`[whatsapp] inbound ${label} ingest failed:`, e);
    return null;
  }
}

function extFromMime(mime: string, label: "image" | "document"): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("pdf")) return "pdf";
  return label === "image" ? "jpg" : "bin";
}

/** Vision-classify an inbound photo (payment slip? website screenshot?
 * logo?). Null on any failure — the message degrades to a plain "[photo]". */
async function analyzeInboundImage(url: string): Promise<ImageAnalysis | null> {
  try {
    const { isOpenAIConfigured, openaiVisionJSON } = await import("@/lib/ai/openai");
    if (!isOpenAIConfigured()) return null;

    const raw = await openaiVisionJSON(
      url,
      `You are analyzing a photo a customer sent to a web agency on WhatsApp. Reply ONLY with JSON:
{"kind":"payment_slip"|"website"|"logo"|"product"|"brand_asset"|"photo"|"content_doc"|"other","description":"1-2 short sentences saying what the image shows — include any business names, amounts or important visible text","slip":null|{"amount":number|null,"currency":string|null,"date":string|null,"bank":string|null,"reference":string|null}}
"payment_slip" = a bank transfer receipt, deposit slip or payment confirmation screenshot (fill "slip" from what's visible). "website" = a screenshot of a website or app. "logo" = a logo file/mark on its own. "brand_asset" = other brand material (colour palette, letterhead, brand-guide page). "photo" = a real-world photo of a business, products, team or premises. "content_doc" = a photographed/scanned page of text (menu, price list, about-us text).`,
      { timeoutMs: 20_000 },
    );
    const parsed = JSON.parse(raw) as Partial<ImageAnalysis>;
    const kind = (
      [
        "payment_slip",
        "website",
        "logo",
        "product",
        "brand_asset",
        "photo",
        "content_doc",
        "other",
      ] as const
    ).includes(parsed.kind as ImageAnalysis["kind"])
      ? (parsed.kind as ImageAnalysis["kind"])
      : "other";
    const description = String(parsed.description ?? "").trim();
    if (!description) return null;
    return {
      kind,
      description: description.slice(0, 300),
      slip:
        kind === "payment_slip" && parsed.slip && typeof parsed.slip === "object"
          ? parsed.slip
          : null,
    };
  } catch (e) {
    console.error("[whatsapp] image analysis failed:", e);
    return null;
  }
}

/**
 * Read an inbound PDF (0086): extract its text with unpdf and have the AI
 * classify + summarize it, so the agent knows what a brand guide, product
 * catalog or payment confirmation actually SAYS. Null on any failure —
 * scanned/image-only PDFs yield no text and degrade to the filename body.
 * Must never throw: the webhook has to 200.
 */
async function analyzeInboundPdf(
  data: Buffer,
  filename: string,
): Promise<PdfAnalysis | null> {
  try {
    const { isOpenAIConfigured, openaiChatJSON } = await import("@/lib/ai/openai");
    if (!isOpenAIConfigured()) return null;

    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    if (pdf.numPages > 40) return null; // a 100-page catalog isn't summarizable here
    const { text } = await extractText(pdf, { mergePages: true });
    const excerpt = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 8000);
    if (excerpt.length < 40) return null; // scanned or empty

    const raw = await openaiChatJSON(
      [
        {
          role: "system",
          content:
            'A customer sent a PDF to a web agency on WhatsApp. From its extracted text, reply ONLY with JSON: {"doc_kind":"payment_slip"|"brand_asset"|"content_doc"|"company_profile"|"other","summary":"1-2 short sentences saying what the document is and the key facts in it (business names, what it contains, totals)"}. "payment_slip" = a bank transfer/payment confirmation. "brand_asset" = brand guidelines, logo specs, colour/font definitions. "content_doc" = website/marketing content: services, product catalogs, price lists, menus, testimonials. "company_profile" = an about-the-company document.',
        },
        {
          role: "user",
          content: `Filename: ${filename}\n\nExtracted text:\n${excerpt}`,
        },
      ],
      { timeoutMs: 25_000, temperature: 0 },
    );
    const parsed = JSON.parse(raw) as Partial<PdfAnalysis>;
    const docKind = (
      ["payment_slip", "brand_asset", "content_doc", "company_profile", "other"] as const
    ).includes(parsed.doc_kind as PdfAnalysis["doc_kind"])
      ? (parsed.doc_kind as PdfAnalysis["doc_kind"])
      : "other";
    const summary = String(parsed.summary ?? "").trim();
    if (!summary) return null;
    return { doc_kind: docKind, summary: summary.slice(0, 300) };
  } catch (e) {
    console.error("[whatsapp] pdf analysis failed:", e);
    return null;
  }
}

/** Download + Whisper-transcribe a voice note (with its detected language,
 * when the transcribe model reports one). Null on any failure. */
async function transcribeVoiceNote(
  mediaId: string,
  languageHint?: string,
): Promise<{ text: string; language: "en" | "si" | "ta" | null } | null> {
  try {
    const { downloadWaMedia } = await import("@/lib/whatsapp");
    const media = await downloadWaMedia(mediaId);
    if (!media.ok) return null;
    const { isOpenAIConfigured, openaiTranscribeVerbose } = await import("@/lib/ai/openai");
    if (!isOpenAIConfigured()) return null;
    const ext = media.mimeType.includes("mpeg") ? "mp3" : "ogg";
    const result = await openaiTranscribeVerbose(
      new Blob([new Uint8Array(media.data)], { type: media.mimeType }),
      `voice.${ext}`,
      { languageHint },
    );
    const text = result.text.trim();
    if (!text) return null;
    return { text, language: whisperLanguageToCode(result.language) };
  } catch (e) {
    console.error("[whatsapp] voice transcription failed:", e);
    return null;
  }
}

function extractBody(message: WaWebhookMessage): string {
  if (message.type === "text") return (message.text?.body ?? "").trim();
  if (message.type === "button") return (message.button?.text ?? "").trim();
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      ""
    ).trim();
  }
  // The emoji IS the message — without this a reaction fell through to the
  // placeholder below and the inbox showed "[reaction message]".
  if (message.type === "reaction") return (message.reaction?.emoji ?? "").trim();
  return `[${message.type ?? "unsupported"} message]`;
}
