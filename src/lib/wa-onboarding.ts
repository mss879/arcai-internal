import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import { fireAutomationTrigger } from "@/lib/automation";
import type { Database } from "@/lib/database.types";
import {
  getDeliverySettings,
  logDeliveryEvent,
  logOutboundWa,
  renderDeliveryMessage,
  setProjectDeliveryStage,
  withinWaWindow,
} from "@/lib/delivery";
import { seedChecklistItems } from "@/lib/delivery-checklists";
import {
  cancelPendingWaPromises,
  notifyEveryone,
  sendAndLogWa,
} from "@/lib/wa-agent";
import { normalizeWaPhone, sendWhatsAppCtaUrl, sendWhatsAppTemplate } from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type WaContact = Database["public"]["Tables"]["wa_contacts"]["Row"];
type AssetRequest =
  Database["public"]["Tables"]["project_document_requests"]["Row"];
type ToolOutcome = { ok: boolean; result: string };

// ---------------------------------------------------------------------------
// Checklist seeding + completion
// ---------------------------------------------------------------------------

/** Seed the service-type template — only when the project has NO checklist
 * yet, so a hand-built one is never clobbered. */
export async function seedProjectChecklist(
  supabase: DB,
  projectId: string,
  serviceType?: string | null,
): Promise<number> {
  const { count } = await supabase
    .from("project_document_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if ((count ?? 0) > 0) return 0;

  let type = serviceType;
  if (type === undefined) {
    const { data } = await supabase
      .from("projects")
      .select("service_type")
      .eq("id", projectId)
      .maybeSingle();
    type = data?.service_type;
  }
  const items = seedChecklistItems(type);
  const { error } = await supabase.from("project_document_requests").insert(
    items.map((item) => ({
      project_id: projectId,
      title: item.title,
      description: item.description,
      category: item.category,
      required: item.required,
      position: item.position,
      source: "team" as const,
    })),
  );
  return error ? 0 : items.length;
}

/**
 * When the LAST required item leaves `pending`, fire assets_complete (once
 * per project — the triggerKey dedupes) and log the event.
 */
export async function checkAssetsComplete(
  supabase: DB,
  projectId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("project_document_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "pending")
    .eq("required", true);
  if ((count ?? 0) > 0) return false;

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_id, share_token")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return false;

  // The event row doubles as the "already celebrated" stamp.
  const { data: already } = await supabase
    .from("delivery_events")
    .select("id")
    .eq("project_id", projectId)
    .eq("kind", "assets_complete")
    .limit(1);
  if (already?.length) return true;

  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, phone, email")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;
  await logDeliveryEvent(
    supabase,
    projectId,
    "assets_complete",
    "Every required asset is in",
    "automation",
  );
  await fireAutomationTrigger(supabase, {
    trigger: "assets_complete",
    client: client ?? null,
    project: { id: project.id, name: project.name },
    payload: {
      name: client?.name ?? "",
      phone: client?.phone ?? null,
      ...(project.share_token
        ? { portal_link: appLink(`/public/project/${project.share_token}`) }
        : {}),
    },
    triggerKey: `${projectId}:assets_complete`,
  });
  return true;
}

/** Shared by the WhatsApp tool and the portal upload: mark one request
 * submitted, fire asset_submitted, and run the completion check. */
export async function fireAssetSubmitted(
  supabase: DB,
  request: Pick<AssetRequest, "id" | "project_id" | "title">,
  source: "portal" | "whatsapp",
): Promise<void> {
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_id")
    .eq("id", request.project_id)
    .maybeSingle();
  if (!project) return;
  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, phone, email")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;
  await fireAutomationTrigger(supabase, {
    trigger: "asset_submitted",
    client: client ?? null,
    project: { id: project.id, name: project.name },
    payload: {
      item_title: request.title,
      name: client?.name ?? "",
      phone: client?.phone ?? null,
      source,
    },
    triggerKey: `asset:${request.id}:submitted`,
  });
  await checkAssetsComplete(supabase, request.project_id);
}

// ---------------------------------------------------------------------------
// Kickoff — payment/button → the agent starts collecting
// ---------------------------------------------------------------------------

/**
 * Flip the client's WhatsApp thread into onboarding mode and send the
 * kickoff. One kickoff per project EVER — projects.onboarding_started_at is
 * the claim. The message goes out directly (window-open free text, else the
 * approved template, else a human task); it must NEVER ride the agent drain,
 * which only wakes for a fresh INBOUND — the agent takes over naturally on
 * the client's first reply because the contact's mode is already flipped.
 */
export async function startWaOnboarding(
  supabase: DB,
  projectId: string,
): Promise<{ ok: boolean; detail: string }> {
  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, client_id, share_token, service_type, delivery_stage, onboarding_started_at",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, detail: "Project not found." };
  if (project.onboarding_started_at)
    return { ok: true, detail: "Onboarding already started — skipped." };
  if (!project.client_id)
    return { ok: false, detail: "The project has no client attached." };

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, phone")
    .eq("id", project.client_id)
    .maybeSingle();
  if (!client) return { ok: false, detail: "Client not found." };

  // Resolve the WhatsApp thread BEFORE claiming, so a phone-less client can
  // be fixed and retried. Prefer an existing thread; else create one from
  // the client's phone.
  let { data: contact } = await supabase
    .from("wa_contacts")
    .select("id, wa_id, last_inbound_at, do_not_contact")
    .eq("client_id", client.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!contact) {
    const phone = normalizeWaPhone(client.phone ?? "");
    if (!phone.ok) {
      await supabase.from("crm_tasks").insert({
        lead_id: null,
        title: `Start onboarding manually — ${client.name} (${project.name})`,
        notes: `Onboarding can't start on WhatsApp: the client has no usable phone number (${client.phone || "empty"}). Add one to the client record and press Start onboarding again.`,
        due_at: new Date().toISOString(),
        created_by: null,
      });
      return {
        ok: false,
        detail: `No usable phone for ${client.name} — task created for the team.`,
      };
    }
    const { data: created } = await supabase
      .from("wa_contacts")
      .upsert(
        {
          wa_id: phone.value,
          display_name: client.name,
          client_id: client.id,
        },
        { onConflict: "wa_id" },
      )
      .select("id, wa_id, last_inbound_at, do_not_contact")
      .single();
    contact = created;
  }
  if (!contact) return { ok: false, detail: "Couldn't create the WhatsApp contact." };
  if (contact.do_not_contact)
    return { ok: false, detail: `${client.name} has opted out of WhatsApp messages.` };

  // The claim: exactly one kickoff per project, even if the automation and
  // the button race. Losing the CAS = someone else just did this.
  const { data: claim } = await supabase
    .from("projects")
    .update({ onboarding_started_at: new Date().toISOString() })
    .eq("id", project.id)
    .is("onboarding_started_at", null)
    .select("id");
  if (!claim?.length)
    return { ok: true, detail: "Onboarding already started — skipped." };

  // Flip the thread's brain, kill the sales cadence, and make sure the
  // agent is on — starting onboarding IS the ask for it to run this chat.
  await supabase
    .from("wa_contacts")
    .update({
      mode: "onboarding",
      onboarding_project_id: project.id,
      agent_enabled: true,
      followup_stage: 0,
      next_followup_at: null,
    })
    .eq("id", contact.id);
  await cancelPendingWaPromises(supabase, contact.id, "contact moved to onboarding");

  await seedProjectChecklist(supabase, project.id, project.service_type);
  if (!project.delivery_stage) {
    // The kickoff message IS this hop's client communication.
    await setProjectDeliveryStage(supabase, project.id, "onboarding", {
      actor: "automation",
      suppressMilestone: true,
    });
  }

  const settings = await getDeliverySettings(supabase);
  const firstName = client.name.trim().split(/\s+/)[0] || "there";
  const portalLink = project.share_token
    ? appLink(`/public/project/${project.share_token}`)
    : null;
  const { data: firstItem } = await supabase
    .from("project_document_requests")
    .select("title")
    .eq("project_id", project.id)
    .eq("status", "pending")
    .eq("required", true)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  const body = renderDeliveryMessage(settings.welcome_message, {
    name: firstName,
    project_name: project.name,
    portal_link: portalLink,
    first_item: firstItem?.title ?? "your logo",
  });

  let sendDetail: string;
  if (withinWaWindow(contact.last_inbound_at)) {
    const sent = await sendAndLogWa(supabase, {
      contact,
      body,
      sentBy: "automation",
    });
    sendDetail = sent.ok
      ? "kickoff sent (window open)"
      : `kickoff send failed: ${sent.error}`;
  } else if (settings.onboarding_template_name?.trim()) {
    const template = settings.onboarding_template_name.trim();
    const sent = await sendWhatsAppTemplate({
      to: contact.wa_id,
      template,
      language: settings.onboarding_template_lang || "en",
      bodyParams: [firstName],
    });
    await logOutboundWa(
      supabase,
      contact.id,
      `[template: ${template}]`,
      sent.ok ? sent.waMessageId : null,
      sent.ok,
      sent.ok ? undefined : sent.error,
    );
    sendDetail = sent.ok
      ? `kickoff template "${template}" sent`
      : `template send failed: ${sent.error}`;
  } else {
    // Window closed and no approved template — a human opens the door.
    // The mode is already flipped, so the moment the client writes
    // ANYTHING the agent runs the onboarding brain.
    await supabase.from("crm_tasks").insert({
      lead_id: null,
      title: `Open the onboarding chat — ${client.name} (${project.name})`,
      notes: `Their 24h WhatsApp window is closed and no onboarding template is configured (Client Delivery → Settings). Send them any first message — the agent takes over from their reply.`,
      due_at: new Date().toISOString(),
      created_by: null,
    });
    await notifyEveryone(supabase, {
      title: `Onboarding needs a human opener — ${client.name}`,
      body: `${project.name}: the WhatsApp window is closed and no template is set. Send the first message from the inbox.`,
      link: "/whatsapp",
    });
    sendDetail = "window closed + no template — handed to the team";
  }

  await logDeliveryEvent(
    supabase,
    project.id,
    "kickoff",
    `WhatsApp onboarding started (${sendDetail})`,
    "automation",
  );
  return { ok: true, detail: `Onboarding started for ${client.name} — ${sendDetail}.` };
}

// ---------------------------------------------------------------------------
// Agent tools (dispatched from wa-agent.ts executeWaTool)
// ---------------------------------------------------------------------------

async function onboardingProject(
  supabase: DB,
  contact: WaContact,
): Promise<{ id: string; name: string; share_token: string | null } | null> {
  if (!contact.onboarding_project_id) return null;
  const { data } = await supabase
    .from("projects")
    .select("id, name, share_token")
    .eq("id", contact.onboarding_project_id)
    .maybeSingle();
  return data ?? null;
}

async function loadChecklist(
  supabase: DB,
  projectId: string,
): Promise<AssetRequest[]> {
  const { data } = await supabase
    .from("project_document_requests")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  return (data ?? []) as AssetRequest[];
}

function describeItem(item: AssetRequest): string {
  const state =
    item.status === "submitted" ? "✓ received" : item.status === "na" ? "— n/a" : "PENDING";
  return `[${item.id}] ${item.title}${item.required ? "" : " (optional)"} — ${state}`;
}

export async function toolGetAssetChecklist(
  supabase: DB,
  contact: WaContact,
): Promise<ToolOutcome> {
  const project = await onboardingProject(supabase, contact);
  if (!project)
    return { ok: false, result: "This chat has no onboarding project attached." };
  const items = await loadChecklist(supabase, project.id);
  if (!items.length)
    return { ok: false, result: "The project has no checklist yet — tell the team." };
  const pending = items.filter((i) => i.status === "pending" && i.required).length;
  return {
    ok: true,
    result:
      `Checklist for "${project.name}" (${pending} required item(s) still pending):\n` +
      items.map(describeItem).join("\n"),
  };
}

/** Attach the newest not-yet-filed inbound photo/document to a checklist
 * item and mark it received. */
export async function toolFileAsset(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const project = await onboardingProject(supabase, contact);
  if (!project)
    return { ok: false, result: "This chat has no onboarding project attached." };
  const items = await loadChecklist(supabase, project.id);

  const itemId = String(args.item_id ?? "").trim();
  const itemTitle = String(args.item_title ?? "").trim().toLowerCase();
  const item =
    items.find((i) => i.id === itemId) ??
    (itemTitle
      ? items.find((i) => i.title.toLowerCase().includes(itemTitle))
      : undefined);
  if (!item)
    return {
      ok: false,
      result:
        "No matching checklist item. Pick one of:\n" +
        items.map(describeItem).join("\n"),
    };

  // The newest inbound media that isn't already filed anywhere.
  const { data: mediaMsgs } = await supabase
    .from("wa_messages")
    .select("id, message_type, body, meta, created_at")
    .eq("contact_id", contact.id)
    .eq("direction", "in")
    .in("message_type", ["image", "document"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (!mediaMsgs?.length)
    return {
      ok: false,
      result: "They haven't sent any photo or document yet — ask them to send it first.",
    };
  const { data: linked } = await supabase
    .from("project_document_requests")
    .select("wa_message_id")
    .in("wa_message_id", mediaMsgs.map((m) => m.id));
  const linkedIds = new Set((linked ?? []).map((l) => l.wa_message_id));
  const media = mediaMsgs.find((m) => !linkedIds.has(m.id));
  if (!media)
    return {
      ok: false,
      result:
        "Every file they've sent is already filed. Ask them to send the new one first.",
    };

  const meta = (media.meta ?? {}) as Record<string, unknown>;
  const fileUrl = String(meta.image_url ?? meta.document_url ?? "");
  if (!fileUrl)
    return {
      ok: false,
      result: "The last file couldn't be stored (too large or download failed) — ask them to resend it.",
    };
  const fileName =
    String(meta.filename ?? "").trim() ||
    `${media.message_type}-${new Date(media.created_at).toISOString().slice(0, 10)}`;
  const note = String(args.note ?? "").trim();

  const { error } = await supabase
    .from("project_document_requests")
    .update({
      status: "submitted",
      file_url: fileUrl,
      file_name: fileName,
      file_size: typeof meta.size === "number" ? meta.size : null,
      file_type: String(meta.mime ?? "").trim() || null,
      wa_message_id: media.id,
      source: "whatsapp",
      submitted_at: new Date().toISOString(),
      ...(note ? { description: note } : {}),
    })
    .eq("id", item.id);
  if (error) return { ok: false, result: error.message };

  await logDeliveryEvent(
    supabase,
    project.id,
    "asset_filed",
    `"${item.title}" received on WhatsApp (${fileName})`,
    "agent",
    { request_id: item.id, wa_message_id: media.id },
  );
  await fireAssetSubmitted(
    supabase,
    { id: item.id, project_id: project.id, title: item.title },
    "whatsapp",
  );

  const remaining = items.filter(
    (i) => i.id !== item.id && i.status === "pending" && i.required,
  );
  return {
    ok: true,
    result:
      `Filed "${item.title}" ✓. ` +
      (remaining.length
        ? `Still needed: ${remaining.map((i) => i.title).join(", ")}. Ask for the next one naturally.`
        : "That was the LAST required item — everything is collected! Thank them warmly and call finish_onboarding."),
  };
}

/** The client doesn't have this one — mark it n/a so it stops blocking. */
export async function toolSkipAsset(
  supabase: DB,
  contact: WaContact,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const project = await onboardingProject(supabase, contact);
  if (!project)
    return { ok: false, result: "This chat has no onboarding project attached." };
  const items = await loadChecklist(supabase, project.id);
  const itemId = String(args.item_id ?? "").trim();
  const itemTitle = String(args.item_title ?? "").trim().toLowerCase();
  const item =
    items.find((i) => i.id === itemId) ??
    (itemTitle
      ? items.find((i) => i.title.toLowerCase().includes(itemTitle))
      : undefined);
  if (!item)
    return {
      ok: false,
      result:
        "No matching checklist item. Pick one of:\n" + items.map(describeItem).join("\n"),
    };
  const reason = String(args.reason ?? "").trim() || "Client doesn't have it";

  const { error } = await supabase
    .from("project_document_requests")
    .update({
      status: "na",
      description: [item.description, `N/A: ${reason}`].filter(Boolean).join(" · "),
    })
    .eq("id", item.id);
  if (error) return { ok: false, result: error.message };

  await logDeliveryEvent(
    supabase,
    project.id,
    "asset_na",
    `"${item.title}" marked n/a — ${reason}`,
    "agent",
    { request_id: item.id },
  );
  await checkAssetsComplete(supabase, project.id);
  return {
    ok: true,
    result: `"${item.title}" marked not applicable (${reason}). Move on to the next pending item.`,
  };
}

/** Drop the project portal link in the chat as a tappable button — for
 * clients who'd rather upload everything at once from a computer. */
export async function toolSendPortalLink(
  supabase: DB,
  contact: WaContact,
): Promise<ToolOutcome> {
  const project = await onboardingProject(supabase, contact);
  if (!project)
    return { ok: false, result: "This chat has no onboarding project attached." };
  if (!project.share_token)
    return { ok: false, result: "The project has no share link — tell the team." };
  const url = appLink(`/public/project/${project.share_token}`);
  if (!url)
    return {
      ok: false,
      result:
        "No public app URL is configured, so there's no portal link — ask them to send the files right here in the chat instead.",
    };
  const body = `Here's your upload page for ${project.name} — everything in one place, straight from your computer 👇`;
  const sent = await sendWhatsAppCtaUrl({
    to: contact.wa_id,
    bodyText: body,
    buttonText: "Open upload page",
    url,
  });
  await logOutboundWa(
    supabase,
    contact.id,
    body,
    sent.ok ? sent.waMessageId : null,
    sent.ok,
    sent.ok ? undefined : sent.error,
  );
  return sent.ok
    ? {
        ok: true,
        result:
          "Portal link sent as a button — don't repeat the URL, just tell them it's above.",
      }
    : { ok: false, result: `Couldn't send the link: ${sent.error}` };
}

/** Everything required is in → hand the project to the build team and put
 * the thread back on the normal brain. */
export async function toolFinishOnboarding(
  supabase: DB,
  contact: WaContact,
): Promise<ToolOutcome> {
  const project = await onboardingProject(supabase, contact);
  if (!project)
    return { ok: false, result: "This chat has no onboarding project attached." };
  const items = await loadChecklist(supabase, project.id);
  const missing = items.filter((i) => i.status === "pending" && i.required);
  if (missing.length)
    return {
      ok: false,
      result: `Not yet — still pending: ${missing.map((i) => i.title).join(", ")}. Collect or skip_asset those first.`,
    };

  await setProjectDeliveryStage(supabase, project.id, "build", { actor: "agent" });
  // onboarding_project_id stays as history; the mode flip is what matters.
  await supabase
    .from("wa_contacts")
    .update({ mode: "sales" })
    .eq("id", contact.id);
  contact.mode = "sales";
  await notifyEveryone(supabase, {
    title: `Onboarding complete — ${project.name}`,
    body: "Every required asset is collected. The project moved to In build.",
    link: "/delivery",
  });
  return {
    ok: true,
    result:
      "Onboarding closed: project moved to In build, team notified. Thank them and tell them the build is starting — do NOT pitch anything.",
  };
}
