/**
 * Asset-checklist templates for Client Delivery onboarding.
 *
 * One template per service_type; kicking off onboarding seeds these as
 * project_document_requests rows (only when the project has none, so a
 * hand-built checklist is never clobbered). Client-safe plain data —
 * the DB seeding lives in wa-onboarding.ts.
 */

import type { AssetCategory } from "@/lib/database.types";

export type ChecklistTemplateItem = {
  title: string;
  description: string;
  category: AssetCategory;
  required: boolean;
};

export const CHECKLIST_TEMPLATES: Record<string, ChecklistTemplateItem[]> = {
  business_website: [
    {
      title: "Logo",
      description: "Vector (AI/SVG) or high-res PNG on a transparent background.",
      category: "brand",
      required: true,
    },
    {
      title: "Brand colours & fonts",
      description: "Brand guide PDF if you have one, or just the colours you use.",
      category: "brand",
      required: false,
    },
    {
      title: "Business & team photos",
      description: "Photos of the shop/office, the team and your work.",
      category: "photos",
      required: true,
    },
    {
      title: "About-us text",
      description: "A short paragraph about the business — or a company profile PDF.",
      category: "content",
      required: true,
    },
    {
      title: "Services list",
      description: "Every service you offer, with a line or two describing each.",
      category: "content",
      required: true,
    },
    {
      title: "Contact details & opening hours",
      description: "Phone numbers, email, locations and business hours.",
      category: "content",
      required: true,
    },
    {
      title: "Customer testimonials",
      description: "2-3 good reviews or customer quotes we can feature.",
      category: "content",
      required: false,
    },
    {
      title: "Domain & hosting access",
      description: "Registrar login or delegation — or tell us to register a new one.",
      category: "access",
      required: true,
    },
    {
      title: "Social media links",
      description: "Facebook, Instagram, TikTok — whatever should be linked.",
      category: "content",
      required: false,
    },
    {
      title: "Google Business Profile access",
      description: "So the site and the map listing stay in sync.",
      category: "access",
      required: false,
    },
  ],
  ecommerce_website: [
    {
      title: "Logo",
      description: "Vector (AI/SVG) or high-res PNG on a transparent background.",
      category: "brand",
      required: true,
    },
    {
      title: "Brand colours & fonts",
      description: "Brand guide PDF if you have one, or just the colours you use.",
      category: "brand",
      required: false,
    },
    {
      title: "Product catalog",
      description: "Names, prices and descriptions — a sheet, PDF or plain list.",
      category: "content",
      required: true,
    },
    {
      title: "Product photos",
      description: "Clear photos of every product going on the store.",
      category: "photos",
      required: true,
    },
    {
      title: "Delivery areas & rates",
      description: "Where you deliver and what it costs per area.",
      category: "content",
      required: true,
    },
    {
      title: "Payment collection details",
      description: "Bank transfer, cash on delivery, or a payment gateway account.",
      category: "access",
      required: true,
    },
    {
      title: "Return & refund policy",
      description: "How returns work — or we'll draft a standard one for you.",
      category: "content",
      required: false,
    },
    {
      title: "About-us & contact details",
      description: "A short paragraph about the business plus phone/email/locations.",
      category: "content",
      required: true,
    },
    {
      title: "Domain & hosting access",
      description: "Registrar login or delegation — or tell us to register a new one.",
      category: "access",
      required: true,
    },
  ],
  social_media_marketing: [
    {
      title: "Logo & brand guide",
      description: "Logo files plus any brand colours/fonts we should follow.",
      category: "brand",
      required: true,
    },
    {
      title: "Facebook & Instagram admin access",
      description: "Accept our admin invite to the Page and IG account.",
      category: "access",
      required: true,
    },
    {
      title: "This month's topics & offers",
      description: "Promotions, new arrivals, events — what should we post about?",
      category: "content",
      required: true,
    },
    {
      title: "Photo & video library",
      description: "Photos/videos of products, premises and the team to post from.",
      category: "photos",
      required: true,
    },
    {
      title: "Audience & goals brief",
      description: "Who are we targeting and what does success look like?",
      category: "content",
      required: true,
    },
    {
      title: "Ad account access / boost budget",
      description: "Ad account access or a confirmed monthly boost budget.",
      category: "access",
      required: false,
    },
    {
      title: "WhatsApp number & call-to-action",
      description: "The number and CTA every post should point to.",
      category: "content",
      required: true,
    },
  ],
};

/** Rows ready to insert for a project (position = template order). */
export function seedChecklistItems(
  serviceType: string | null | undefined,
): (ChecklistTemplateItem & { position: number })[] {
  const template =
    CHECKLIST_TEMPLATES[serviceType ?? ""] ??
    CHECKLIST_TEMPLATES.business_website;
  return template.map((item, i) => ({ ...item, position: i }));
}
