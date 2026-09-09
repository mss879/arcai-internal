import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { firecrawlScrape, isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import type { ResponsesFunctionTool } from "@/lib/ai/responses";
import { businessConfig } from "@/lib/business-config";
import type { CarouselSlide, Database } from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";
import { listActiveSocialAccounts, queueSocialPost } from "@/lib/social/queue";

import { emitOfficeEvent } from "./events";
import { OPTION_COUNT, validateCopyDraft } from "./office-core";
import type { OfficeAgentView, OfficeMissionRow, OfficeTaskRow } from "./office-types";
import { renderBrandProfile } from "./prompts";
import { OFFICE_TOOL_NAMES, type OfficeToolName } from "./tool-names";

type DB = SupabaseClient<Database>;

/**
 * What an office agent can actually do (0130).
 *
 * Every tool reads or writes THIS app's own tables and nothing else — there
 * is no URL fetch, no email, no send. The two that write are narrow:
 * `create_carousel_draft` inserts a post in exactly the shape the existing
 * renderer (`processPendingCarousels`) picks up, and `queue_post` goes
 * through `queueSocialPost`, the one writer of the publish queue, and is
 * only offered at all when an admin turned auto-publish on for the mission.
 *
 * Every call is one `office_events` row, which is what the hover card shows.
 */

export type OfficeToolContext = {
  db: DB;
  mission: OfficeMissionRow;
  task: OfficeTaskRow;
  agent: OfficeAgentView;
};

export type OfficeToolOutcome = { ok: boolean; content: unknown; summary: string };

/** Cap on what goes back to the model. */
const RESULT_MAX_CHARS = 6_000;

const noParams = { type: "object", properties: {}, additionalProperties: false, required: [] as string[] };

const S = { type: "string" } as const;

export const OFFICE_TOOL_SCHEMAS: Record<OfficeToolName, ResponsesFunctionTool> = {
  get_brand_profile: {
    type: "function",
    name: "get_brand_profile",
    description: "The brand voice, pillars, audience and banned words this content must follow.",
    parameters: noParams,
    strict: true,
  },
  get_brand_references: {
    type: "function",
    name: "get_brand_references",
    description: "The reference library: names and descriptions of the brand images the renderer paints from.",
    parameters: noParams,
    strict: true,
  },
  list_recent_posts: {
    type: "function",
    name: "list_recent_posts",
    description: "Posts drafted or published recently, so nothing repeats.",
    parameters: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days back, 1–90." } },
      additionalProperties: false,
      required: ["days"],
    },
    strict: true,
  },
  get_content_calendar: {
    type: "object" as unknown as "function",
    name: "get_content_calendar",
    description: "What is planned or queued between two dates (YYYY-MM-DD).",
    parameters: {
      type: "object",
      properties: { from: S, to: S },
      additionalProperties: false,
      required: ["from", "to"],
    },
    strict: true,
  },
  list_social_accounts: {
    type: "function",
    name: "list_social_accounts",
    description: "The connected Instagram / Facebook accounts posts can be scheduled to.",
    parameters: noParams,
    strict: true,
  },
  get_carousel_draft: {
    type: "function",
    name: "get_carousel_draft",
    description: "One drafted carousel from this mission: caption, hashtags, both concepts with slide copy, how many slides have rendered.",
    parameters: {
      type: "object",
      properties: { post_id: S },
      additionalProperties: false,
      required: ["post_id"],
    },
    strict: true,
  },
  create_carousel_draft: {
    type: "function",
    name: "create_carousel_draft",
    description:
      "Hand finished copy plus art direction to the render queue as a new carousel post. Call exactly once per post. Returns the post_id.",
    parameters: {
      type: "object",
      properties: {
        topic: S,
        scheduled_for: { type: "string", description: "YYYY-MM-DD" },
        notes: S,
        caption: S,
        hashtags: { type: "array", items: S },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              concept: { type: "string", description: "Visual direction: style, palette, layout system, typography, imagery." },
              slides: {
                type: "array",
                items: {
                  type: "object",
                  properties: { headline: S, body: S },
                  additionalProperties: false,
                  required: ["headline", "body"],
                },
              },
            },
            additionalProperties: false,
            required: ["concept", "slides"],
          },
        },
      },
      additionalProperties: false,
      required: ["topic", "scheduled_for", "notes", "caption", "hashtags", "options"],
    },
    strict: true,
  },
  fetch_website: {
    type: "function",
    name: "fetch_website",
    description:
      "Read one web page: its text as markdown, the links on it, and a brand profile (logo, colours, fonts) when the site exposes one. Use it to pull a company's look and voice from its website.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "A full http(s) URL." } },
      additionalProperties: false,
      required: ["url"],
    },
    strict: true,
  },
  lookup_client: {
    type: "function",
    name: "lookup_client",
    description: "Find a client in the CRM by name, company, email or phone. Returns ids and which channels (email, SMS, WhatsApp) they can be reached on.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Part of a name, company, email or phone number." } },
      additionalProperties: false,
      required: ["query"],
    },
    strict: true,
  },
  prepare_message: {
    type: "function",
    name: "prepare_message",
    description:
      "Draft an email, SMS or WhatsApp message to a CRM client and park it in the owner's approvals tray. Nothing is sent until a person taps Send. Use lookup_client first to get the client_id and see which channels work.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["email", "sms", "whatsapp"] },
        client_id: S,
        subject: { type: "string", description: "Email subject; empty for SMS and WhatsApp." },
        message: { type: "string", description: "The full message, exactly as it should be sent." },
      },
      additionalProperties: false,
      required: ["channel", "client_id", "subject", "message"],
    },
    strict: true,
  },
  queue_post: {
    type: "function",
    name: "queue_post",
    description: "Put a rendered, chosen carousel on the publish queue for the given accounts at the given time (ISO timestamp).",
    parameters: {
      type: "object",
      properties: {
        carousel_post_id: S,
        account_ids: { type: "array", items: S },
        scheduled_for: S,
      },
      additionalProperties: false,
      required: ["carousel_post_id", "account_ids", "scheduled_for"],
    },
    strict: true,
  },
};
// `get_content_calendar` above must be a function tool like the rest.
OFFICE_TOOL_SCHEMAS.get_content_calendar.type = "function";

/** The schemas for the tools an agent carries (unknown names are dropped). */
export function toolSchemasFor(names: readonly string[]): ResponsesFunctionTool[] {
  return names
    .filter((n): n is OfficeToolName => (OFFICE_TOOL_NAMES as readonly string[]).includes(n))
    .map((n) => OFFICE_TOOL_SCHEMAS[n]);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function clip(content: unknown): string {
  const text = JSON.stringify(content);
  return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS - 20)}…(truncated)` : text;
}

/** Load the mission's brand profile row (or the house default). */
export async function loadBrandProfile(db: DB, brandProfileId: string | null) {
  try {
    if (brandProfileId) {
      const { data } = await db.from("office_brand_profiles").select("*").eq("id", brandProfileId).maybeSingle();
      if (data) return data;
    }
    const { data } = await db
      .from("office_brand_profiles")
      .select("*")
      .is("client_id", null)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

/** The brand profile as prompt text, with the business descriptor. */
export async function brandProfileText(db: DB, brandProfileId: string | null): Promise<string | null> {
  const row = await loadBrandProfile(db, brandProfileId);
  let descriptor: string | null = null;
  try {
    descriptor = (await businessConfig()).voice.descriptor || null;
  } catch {
    descriptor = null;
  }
  return renderBrandProfile(
    row
      ? {
          name: row.name,
          voice: row.voice,
          pillars: row.pillars,
          audience: row.audience,
          banned_words: row.banned_words,
          hashtag_sets: row.hashtag_sets,
          notes: row.notes,
        }
      : null,
    descriptor,
  );
}

async function run(ctx: OfficeToolContext, name: OfficeToolName, args: Rec): Promise<OfficeToolOutcome> {
  const { db, mission, task } = ctx;
  switch (name) {
    case "get_brand_profile": {
      const text = await brandProfileText(db, mission.brand_profile_id);
      return { ok: true, content: { profile: text ?? "No brand profile is configured yet." }, summary: "read the brand profile" };
    }
    case "get_brand_references": {
      const { data } = await db
        .from("content_references")
        .select("name, description")
        .order("created_at", { ascending: false })
        .limit(6);
      const refs = (data ?? []).map((r) => ({ name: r.name, description: r.description }));
      return { ok: true, content: { references: refs }, summary: `read ${refs.length} brand references` };
    }
    case "list_recent_posts": {
      const days = Math.max(1, Math.min(90, Math.floor(Number(args.days)) || 30));
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const [posts, social] = await Promise.all([
        db
          .from("carousel_posts")
          .select("id, topic, caption, scheduled_for, status, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(40),
        db
          .from("social_posts")
          .select("platform, scheduled_for, status, caption")
          .gte("scheduled_for", since)
          .order("scheduled_for", { ascending: false })
          .limit(40)
          .then((r) => r, () => ({ data: null })),
      ]);
      return {
        ok: true,
        content: {
          drafts: (posts.data ?? []).map((p) => ({
            id: p.id,
            topic: p.topic,
            caption: p.caption.slice(0, 200),
            scheduled_for: p.scheduled_for,
            status: p.status,
          })),
          published_or_queued: (social.data ?? []).map((s) => ({
            platform: s.platform,
            scheduled_for: s.scheduled_for,
            status: s.status,
            caption: s.caption.slice(0, 120),
          })),
        },
        summary: `listed ${posts.data?.length ?? 0} recent posts`,
      };
    }
    case "get_content_calendar": {
      const from = str(args.from, 10);
      const to = str(args.to, 10);
      if (!isDay(from) || !isDay(to)) return { ok: false, content: { error: "from and to must be YYYY-MM-DD." }, summary: "calendar: bad dates" };
      const [posts, social] = await Promise.all([
        db
          .from("carousel_posts")
          .select("id, topic, scheduled_for, status")
          .gte("scheduled_for", from)
          .lte("scheduled_for", to)
          .order("scheduled_for", { ascending: true })
          .limit(60),
        db
          .from("social_posts")
          .select("platform, scheduled_for, status")
          .gte("scheduled_for", `${from}T00:00:00Z`)
          .lte("scheduled_for", `${to}T23:59:59Z`)
          .order("scheduled_for", { ascending: true })
          .limit(60)
          .then((r) => r, () => ({ data: null })),
      ]);
      return {
        ok: true,
        content: { planned: posts.data ?? [], queued: social.data ?? [] },
        summary: `read the calendar ${from} → ${to}`,
      };
    }
    case "list_social_accounts": {
      const accounts = await listActiveSocialAccounts(db);
      return {
        ok: true,
        content: {
          accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, client_id: a.clientId })),
          note: accounts.length ? undefined : "No accounts are connected. Propose times anyway; a person will connect an account and schedule.",
        },
        summary: `listed ${accounts.length} connected accounts`,
      };
    }
    case "get_carousel_draft": {
      const postId = str(args.post_id, 60);
      const { data: post } = await db
        .from("carousel_posts")
        .select("id, topic, caption, hashtags, scheduled_for, status, mission_id, chosen_option_id")
        .eq("id", postId)
        .maybeSingle();
      if (!post || post.mission_id !== mission.id) {
        return { ok: false, content: { error: "No such draft in this mission." }, summary: "draft not found" };
      }
      const { data: options } = await db
        .from("carousel_options")
        .select("id, variant, concept, slides")
        .eq("post_id", postId)
        .order("variant");
      const opts = (options ?? []).map((o) => {
        const slides = (o.slides ?? []) as CarouselSlide[];
        return {
          id: o.id,
          variant: o.variant,
          concept: o.concept,
          slides: slides.map((s) => ({ index: s.index, headline: s.headline, body: s.body, rendered: Boolean(s.image_url) })),
          rendered: slides.filter((s) => s.image_url).length,
          total: slides.length,
        };
      });
      return {
        ok: true,
        content: { post: { ...post, hashtags: post.hashtags }, options: opts },
        summary: `read draft “${post.topic}”`,
      };
    }
    case "create_carousel_draft": {
      // Idempotent per task: a retried round must not draft the post twice.
      const { data: existing } = await db
        .from("carousel_posts")
        .select("id, topic")
        .eq("office_task_id", task.id)
        .maybeSingle();
      if (existing) {
        return {
          ok: true,
          content: { post_id: existing.id, note: "This task already created its draft; reusing it." },
          summary: `reused draft “${existing.topic}”`,
        };
      }
      const checked = validateCopyDraft(args);
      if (!checked.ok) return { ok: false, content: { error: checked.error }, summary: `draft rejected: ${checked.error}` };
      const draft = checked.value;
      const scheduledFor = draft.scheduled_for || mission.options.dateFrom || new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

      const { data: post, error } = await db
        .from("carousel_posts")
        .insert({
          topic: draft.topic,
          notes: draft.notes,
          scheduled_for: scheduledFor,
          // Straight to rendering: the copy is already written. This is the
          // exact state writeCarouselCopy leaves a post in, so the existing
          // carousels tick pass renders it and the review modal opens it.
          status: "rendering",
          caption: draft.caption,
          hashtags: draft.hashtags,
          analysis: { runStartedAt: Date.now() },
          locked_at: null,
          claims: 0,
          client_id: mission.client_id,
          created_by: mission.created_by,
          mission_id: mission.id,
          office_task_id: task.id,
        })
        .select("id")
        .single();
      if (error || !post) return { ok: false, content: { error: error?.message ?? "insert failed" }, summary: "draft insert failed" };

      for (let i = 0; i < OPTION_COUNT; i++) {
        const option = draft.options[i];
        const slides: CarouselSlide[] = option.slides.map((s, idx) => ({
          index: idx,
          headline: s.headline,
          body: s.body,
          image_url: null,
          image_path: null,
        }));
        const { error: optErr } = await db
          .from("carousel_options")
          .upsert({ post_id: post.id, variant: i + 1, concept: option.concept, slides }, { onConflict: "post_id,variant" });
        if (optErr) return { ok: false, content: { error: optErr.message }, summary: "option insert failed" };
      }
      await emitOfficeEvent(db, {
        missionId: mission.id,
        taskId: task.id,
        agentKey: ctx.agent.key,
        kind: "handoff",
        message: `${ctx.agent.name} sent “${draft.topic}” to the render queue`,
        meta: { post_id: post.id, slides: draft.options.map((o) => o.slides.length) },
      });
      return {
        ok: true,
        content: { post_id: post.id, scheduled_for: scheduledFor, note: "Rendering has started; slides paint one at a time." },
        summary: `drafted “${draft.topic}”`,
      };
    }
    case "fetch_website": {
      const url = str(args.url, 500);
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, content: { error: "Give a full http(s) URL." }, summary: "fetch_website: bad URL" };
      if (!isFirecrawlConfigured()) {
        return { ok: false, content: { error: "Website reading is not configured on this server (FIRECRAWL_API_KEY). Use web_search instead." }, summary: "fetch_website unavailable" };
      }
      const page = await firecrawlScrape(url, { brand: true });
      if (!page) return { ok: false, content: { error: "That page could not be read." }, summary: `could not read ${url}` };
      return {
        ok: true,
        content: {
          url: page.url,
          title: page.title,
          description: page.description,
          branding: page.branding ? JSON.parse(clip(page.branding).replace(/…\(truncated\)$/, "") || "null") : null,
          links: page.links.slice(0, 25),
          content: page.markdown.slice(0, 6_000),
        },
        summary: `read ${page.title || url}`,
      };
    }
    case "lookup_client": {
      const q = str(args.query, 80).replace(/[^\w\s@.+-]/g, "").trim();
      if (q.length < 2) return { ok: false, content: { error: "Give at least two characters." }, summary: "lookup_client: query too short" };
      const like = `%${q}%`;
      const { data: clients } = await db
        .from("clients")
        .select("id, name, company, email, phone, phone_norm, status")
        .or(`name.ilike.${like},company.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
        .order("name")
        .limit(6);
      const rows = clients ?? [];
      const norms = rows.map((c) => c.phone_norm).filter((n): n is string => Boolean(n));
      const ids = rows.map((c) => c.id);
      const { data: wa } = norms.length || ids.length
        ? await db
            .from("wa_contacts")
            .select("wa_id, client_id, last_inbound_at")
            .or([norms.length ? `wa_id.in.(${norms.join(",")})` : null, ids.length ? `client_id.in.(${ids.join(",")})` : null].filter(Boolean).join(","))
        : { data: [] as { wa_id: string; client_id: string | null; last_inbound_at: string | null }[] };
      const dayAgo = Date.now() - 24 * 60 * 60_000;
      return {
        ok: true,
        content: {
          clients: rows.map((c) => {
            const contact = (wa ?? []).find((w) => w.client_id === c.id || (c.phone_norm && w.wa_id === c.phone_norm));
            return {
              id: c.id,
              name: c.name,
              company: c.company,
              status: c.status,
              email: c.email,
              phone: c.phone,
              channels: {
                email: Boolean(c.email),
                sms: Boolean(c.phone_norm),
                whatsapp: Boolean(contact),
                whatsapp_window_open: Boolean(contact?.last_inbound_at && Date.parse(contact.last_inbound_at) > dayAgo),
              },
            };
          }),
          note: rows.length ? undefined : "No client matched. Try part of the name or company.",
        },
        summary: `looked up “${q}” (${rows.length} match${rows.length === 1 ? "" : "es"})`,
      };
    }
    case "prepare_message": {
      const channel = str(args.channel, 10);
      const clientId = str(args.client_id, 60);
      const message = str(args.message, 4_000);
      const subject = str(args.subject, 200);
      if (!["email", "sms", "whatsapp"].includes(channel)) return { ok: false, content: { error: "channel must be email, sms or whatsapp." }, summary: "prepare_message: bad channel" };
      if (message.length < 4) return { ok: false, content: { error: "Write the message first." }, summary: "prepare_message: empty" };
      if (!mission.created_by) return { ok: false, content: { error: "This mission has no owner to approve a message." }, summary: "prepare_message: no approver" };
      const { data: client } = await db.from("clients").select("id, name, company, email, phone, phone_norm").eq("id", clientId).maybeSingle();
      if (!client) return { ok: false, content: { error: "No such client. Use lookup_client first." }, summary: "prepare_message: no client" };

      let kind: "email" | "sms" | "whatsapp";
      let card: Record<string, unknown>;
      if (channel === "email") {
        if (!client.email) return { ok: false, content: { error: `${client.name} has no email on file. Try sms or whatsapp.` }, summary: "prepare_message: no email" };
        if (!subject) return { ok: false, content: { error: "An email needs a subject." }, summary: "prepare_message: no subject" };
        kind = "email";
        card = {
          type: "confirm_send_email",
          email: { to: [client.email], subject, body: message, client_id: client.id, lead_id: null, project_id: null, client_name: client.name, cta: null },
        };
      } else if (channel === "sms") {
        if (!client.phone_norm) return { ok: false, content: { error: `${client.name} has no usable phone number. Try email.` }, summary: "prepare_message: no phone" };
        if (message.length > 480) return { ok: false, content: { error: "An SMS must be under 480 characters." }, summary: "prepare_message: sms too long" };
        kind = "sms";
        card = {
          type: "confirm_send_sms",
          sms: {
            to_number: client.phone_norm,
            to_display: client.phone ?? client.phone_norm,
            client_id: client.id,
            lead_id: null,
            client_name: client.name,
            message,
            kind: "custom",
            invoice_id: null,
            invoice_number: null,
          },
        };
      } else {
        const { data: contact } = await db
          .from("wa_contacts")
          .select("id, wa_id, last_inbound_at")
          .or([`client_id.eq.${client.id}`, client.phone_norm ? `wa_id.eq.${client.phone_norm}` : null].filter(Boolean).join(","))
          .order("last_inbound_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (!contact) return { ok: false, content: { error: `There is no WhatsApp thread with ${client.name} yet. Try sms or email.` }, summary: "prepare_message: no WhatsApp thread" };
        kind = "whatsapp";
        card = {
          type: "confirm_send_whatsapp",
          whatsapp: {
            contact_id: contact.id,
            wa_id: contact.wa_id,
            to_display: client.phone ?? contact.wa_id,
            client_name: client.name,
            message,
            within_window: Boolean(contact.last_inbound_at && Date.parse(contact.last_inbound_at) > Date.now() - 24 * 60 * 60_000),
          },
        };
      }

      const { data: approval, error } = await db
        .from("assistant_approvals")
        .insert({ user_id: mission.created_by, kind, card })
        .select("id")
        .single();
      if (error || !approval) return { ok: false, content: { error: error?.message ?? "Could not park the message." }, summary: "prepare_message failed" };

      await emitOfficeEvent(db, {
        missionId: mission.id,
        taskId: task.id,
        agentKey: ctx.agent.key,
        kind: "note",
        message: `${ctx.agent.name} drafted a ${channel === "sms" ? "text" : channel} to ${client.name} — waiting for your approval`,
        meta: { approval_id: approval.id, channel, client_id: client.id },
      });
      await notifyUsers(db, {
        userIds: [mission.created_by],
        type: "approval",
        title: `${ctx.agent.name} drafted a ${channel === "sms" ? "text" : channel} to ${client.name}`,
        body: message.slice(0, 140),
        link: "/dashboard",
      });
      return {
        ok: true,
        content: {
          approval_id: approval.id,
          status: "waiting for approval",
          note: "Parked in the owner's approvals tray (Dashboard). Nothing is sent until a person taps Send — describe it as prepared, not sent.",
        },
        summary: `prepared a ${channel} to ${client.name}`,
      };
    }
    case "queue_post": {
      if (!mission.options.autoPublish) {
        return { ok: false, content: { error: "Auto-publish is off for this mission. Propose only." }, summary: "queue refused (auto-publish off)" };
      }
      const postId = str(args.carousel_post_id, 60);
      const { data: post } = await db.from("carousel_posts").select("id, mission_id").eq("id", postId).maybeSingle();
      if (!post || post.mission_id !== mission.id) {
        return { ok: false, content: { error: "That post is not part of this mission." }, summary: "queue refused (wrong mission)" };
      }
      const accountIds = Array.isArray(args.account_ids) ? args.account_ids.map((a) => str(a, 60)).filter(Boolean) : [];
      const res = await queueSocialPost(db, {
        postId,
        accountIds,
        scheduledFor: str(args.scheduled_for, 40),
        createdBy: mission.created_by,
      });
      return {
        ok: res.ok,
        content: res,
        summary: res.ok ? `queued ${res.queued} post(s) — “${res.topic}”` : `queue refused: ${res.error}`,
      };
    }
  }
}

/**
 * Execute one function call from the model and record it. Unknown names and
 * names the agent does not carry are refused (the model is told why).
 */
export async function executeOfficeTool(
  ctx: OfficeToolContext,
  name: string,
  argsJson: string,
  allowed: readonly string[],
): Promise<{ output: string; ok: boolean; summary: string }> {
  let args: Rec = {};
  try {
    args = rec(JSON.parse(argsJson || "{}"));
  } catch {
    args = {};
  }

  let outcome: OfficeToolOutcome;
  if (!(OFFICE_TOOL_NAMES as readonly string[]).includes(name) || !allowed.includes(name)) {
    outcome = { ok: false, content: { error: `Tool ${name} is not available to you.` }, summary: `refused tool ${name}` };
  } else {
    try {
      outcome = await run(ctx, name as OfficeToolName, args);
    } catch (e) {
      outcome = { ok: false, content: { error: (e as Error).message.slice(0, 300) }, summary: `${name} failed` };
    }
  }

  await emitOfficeEvent(ctx.db, {
    missionId: ctx.mission.id,
    taskId: ctx.task.id,
    agentKey: ctx.agent.key,
    kind: "tool",
    message: `${ctx.agent.name} ${outcome.summary}`,
    meta: { tool: name, ok: outcome.ok, args: name === "create_carousel_draft" ? { topic: args.topic } : args },
  });

  return { output: clip(outcome.content), ok: outcome.ok, summary: outcome.summary };
}
