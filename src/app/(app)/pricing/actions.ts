"use server";

import { revalidatePath } from "next/cache";

import { getProfile } from "@/lib/auth";
import { sendPricingEmail } from "@/lib/email";
import type { PricingOverrides } from "@/lib/pricing-catalog";
import { createClient } from "@/lib/supabase/server";

type Result = { ok: true } | { ok: false; error: string };

/** Keep only finite numeric entries — never trust the client payload blindly. */
function cleanOverrides(input: unknown): PricingOverrides {
  const out: PricingOverrides = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
    }
  }
  return out;
}

/** Persist the edited prices (override map) to the singleton pricing_config row. */
export async function savePricing(overrides: PricingOverrides): Promise<Result> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const clean = cleanOverrides(overrides);
  const supabase = await createClient();
  const { error } = await supabase
    .from("pricing_config")
    .upsert({ id: 1, overrides: clean }, { onConflict: "id" });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/pricing");
  return { ok: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email the current pricing as a branded PDF to a recipient. */
export async function sendPricing(input: {
  to: string;
  overrides: PricingOverrides;
  message?: string;
}): Promise<Result> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const to = input.to.trim();
  if (!EMAIL_RE.test(to)) return { ok: false, error: "Enter a valid email address." };

  const res = await sendPricingEmail({
    to,
    overrides: cleanOverrides(input.overrides),
    message: input.message?.trim() || undefined,
  });

  if (!res.sent) return { ok: false, error: res.error || "Could not send the email." };
  return { ok: true };
}
