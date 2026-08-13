-- ============================================================
-- 0068_wa_campaign_focus.sql
-- Campaign FOCUS mode for the WhatsApp agent.
--
-- 0065 gave the agent the campaign as one extra knowledge block,
-- stacked at the end of a prompt whose entire body is the generic
-- website-sales playbook. Real chats showed what that produces: a
-- campaign lead taps the ad and still gets "what kind of website
-- or service are you looking for?" — generic discovery and a menu
-- of other services instead of the offer they just tapped.
--
-- The prompt fix ships in code (wa-agent.ts): while a campaign is
-- live, campaign leads now get a prompt REBUILT around selling and
-- closing that one campaign — the website flows, package pricing
-- and generic discovery are swapped out entirely. Everyone else
-- (campaign mode off, or contacts already mid-deal) is untouched.
--
-- This migration adds the one structured field that playbook
-- needs, and re-seeds the live campaign's copy so the fix works
-- the moment it deploys:
--
--   pricing_note  Exactly what the agent may say when the price
--     comes up. Campaign offers are custom-quoted (no package
--     list), so without its own field the agent falls back to the
--     website packages in the knowledge base — the one number it
--     must never quote at a campaign lead.
-- ============================================================

alter table public.wa_campaigns
  add column if not exists pricing_note text not null default '';

-- ---- Seed the live campaign ------------------------------------
-- The currently-active campaign (the smart CRM / workflow
-- automation ad) gets the full agent-ready copy: offer brief,
-- pricing line and an instant reply that introduces the agent as
-- ARC's AI agent instead of pretending to "connect you with
-- someone". Name and ad image are left exactly as the team set
-- them, and everything below stays editable in the Campaign tab.
-- If nothing is active right now, the same copy lands as a draft
-- campaign ready to activate.
do $$
declare
  active_id uuid;
  seed_details text := $details$
THE OFFER — a done-for-you Smart Business System: a smart CRM + AI agents + workflow automation, custom-built around how their business already works.

What they get (this mirrors the ad they tapped, step by step):
1. Every inquiry from WhatsApp, Instagram and their website lands in one smart CRM — nothing lost in chat history.
2. An AI agent replies instantly, 24/7, in the customer's language — answers questions, qualifies leads and sells, exactly like this conversation.
3. A customer profile is created automatically from the chat — name, business, needs — zero data entry.
4. Smart CRM pipeline with lead scoring — the owner opens one board and sees exactly who's hot and what's next.
5. Follow-ups go out automatically — no lead is ever forgotten, even weeks later.
6. Business documents are generated automatically — invoices, proposals, itineraries — delivered and e-signed right on the customer's phone.

WHO IT'S FOR: any business losing sales to slow replies and manual follow-up — service businesses, agencies, tour operators, clinics, retailers — anyone handling a stream of WhatsApp inquiries by hand.

PRICING MODEL (lead with this framing — it's the hook): a ONE-TIME setup fee and NO monthly fee, ever. After setup the only running cost is their own API usage, paid directly by them (small, scales with their volume). They OWN the system — it's not a subscription they rent forever.

WHY IT WINS: it replaces the hours (or the salary) spent answering the same questions, chasing leads and typing invoices — and it never sleeps, never forgets a follow-up, never loses a customer's details.

THE GOAL OF EVERY CONVERSATION: get them on a quick call — that's where the team scopes their exact setup and gives them a real number.
$details$;
  seed_pricing text := $pricing$
Every system is custom-built, so there is no fixed price list — pricing STARTS FROM Rs 150,000 as a one-time setup fee, and the exact figure depends on what their business needs. NO monthly fee, ever: after setup they only pay their own API usage cost directly. When price comes up, give "starts from Rs 150,000, one-time, no monthly fees" straight away — never dodge the question, and never quote any figure beyond that starting point. The exact price comes from the team after a quick call where they scope the setup.
$pricing$;
  seed_first_reply text :=
    'Hey! I''m Arc, ARC AI''s AI agent 🙂 You''ve reached us about our smart CRM & automation system — give me one moment and I''ll get you all the details.';
begin
  select id into active_id
    from public.wa_campaigns
    where status = 'active'
    limit 1;

  if active_id is not null then
    update public.wa_campaigns
      set details      = btrim(seed_details, E' \n'),
          pricing_note = btrim(seed_pricing, E' \n'),
          first_reply  = seed_first_reply
      where id = active_id;
  else
    insert into public.wa_campaigns (name, status, details, pricing_note, first_reply)
    values (
      'Smart CRM & Workflow Automation',
      'draft',
      btrim(seed_details, E' \n'),
      btrim(seed_pricing, E' \n'),
      seed_first_reply
    );
  end if;
end $$;
