import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendPushToUser } from "@/lib/push";
import { BUSINESS_TIERS, PROPOSAL_COMPANY, money } from "@/lib/proposal";
import type { ShowcasePayload } from "@/lib/wa-showcase";
import type { WaShowcase } from "@/lib/types";

export const metadata = {
  title: "Your Website Showcase — ARC AI",
  robots: { index: false, follow: false },
};

/**
 * Public showcase page (share link). No auth — access is the unguessable
 * token. ONE place for everything the WhatsApp agent promised: the audit
 * scores, what's holding the site back, and the before/after redesign.
 */
export default async function ShowcasePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: showcase } = await supabase
    .from("wa_showcases")
    .select("*")
    .eq("token", token)
    .in("status", ["ready", "sent"])
    .maybeSingle();
  if (!showcase) notFound();
  const row = showcase as WaShowcase;

  if (!row.viewed_at) {
    await supabase
      .from("wa_showcases")
      .update({ viewed_at: new Date().toISOString() })
      .eq("id", row.id);
    // The hottest buying signal there is — tell the team the moment it happens.
    const business =
      ((row.payload ?? {}) as Partial<ShowcasePayload>).business ?? "A prospect";
    const { data: profiles } = await supabase.from("profiles").select("id");
    for (const p of profiles ?? []) {
      await supabase.from("notifications").insert({
        user_id: p.id,
        type: "system",
        title: "Showcase opened 👀",
        body: `${business} is looking at their showcase RIGHT NOW — perfect moment to follow up.`,
        link: "/whatsapp",
      });
      await sendPushToUser({
        userId: p.id,
        title: "Showcase opened 👀",
        body: `${business} is viewing their redesign right now.`,
        link: "/whatsapp",
      });
    }
  }

  const payload = (row.payload ?? {}) as Partial<ShowcasePayload>;
  const business = payload.business || "your business";
  const scores: { label: string; value: number }[] = [
    { label: "Speed", value: payload.scores?.performance ?? -1 },
    { label: "SEO", value: payload.scores?.seo ?? -1 },
    { label: "Accessibility", value: payload.scores?.accessibility ?? -1 },
    { label: "Best practices", value: payload.scores?.best_practices ?? -1 },
  ].filter((s) => s.value >= 0);
  if (scores.length === 0 && payload.scores?.quick_score != null) {
    scores.push({ label: "Site health", value: payload.scores.quick_score });
  }
  const issues = payload.issues ?? [];
  const waLink = payload.whatsapp_number
    ? `https://wa.me/${payload.whatsapp_number}?text=${encodeURIComponent("Hi! I just saw my website showcase — let's talk.")}`
    : null;
  const tiers = [
    BUSINESS_TIERS.smart_site,
    BUSINESS_TIERS.smart_business,
    BUSINESS_TIERS.smart_system,
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-5">
          <div className="text-lg font-bold tracking-tight">
            ARC <span className="text-orange-500">AI</span>
          </div>
          <span className="text-xs uppercase tracking-widest text-slate-400">
            Website Showcase
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 pb-20">
        {/* Hero */}
        <section className="pt-12 text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-orange-400">
            Prepared exclusively for
          </p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-5xl">
            {business}
          </h1>
          {payload.url && (
            <p className="mt-2 text-sm text-slate-400">{payload.url}</p>
          )}
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-slate-300">
            We took a proper look at your website — how fast it really is, how
            Google sees it, and what it <em>could</em> look like.
          </p>
        </section>

        {/* Scores */}
        {scores.length > 0 && (
          <section className="mt-12">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {scores.map((s) => (
                <ScoreRing key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
            <p className="mt-3 text-center text-xs text-slate-500">
              Measured with Google Lighthouse (mobile) — the same test Google
              uses to rank sites.
            </p>
          </section>
        )}

        {/* Before / after */}
        {row.mockup_image_url && (
          <section className="mt-14">
            <h2 className="text-center text-2xl font-bold">
              What your site <span className="text-orange-400">could</span> look like
            </h2>
            <div
              className={`mt-6 grid gap-5 ${row.before_image_url ? "sm:grid-cols-2" : ""}`}
            >
              {row.before_image_url && (
                <figure className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={row.before_image_url}
                    alt={`${business} — current website`}
                    className="w-full"
                  />
                  <figcaption className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Today
                  </figcaption>
                </figure>
              )}
              <figure className="overflow-hidden rounded-2xl border border-orange-500/40 bg-white/5 ring-1 ring-orange-500/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={row.mockup_image_url}
                  alt={`${business} — redesign concept by ARC AI`}
                  className="w-full"
                />
                <figcaption className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-widest text-orange-400">
                  The ARC AI concept
                </figcaption>
              </figure>
            </div>
            <p className="mt-3 text-center text-xs text-slate-500">
              Design concept generated for {business}. Your real build is
              hand-crafted — this is the direction, not the ceiling.
            </p>
          </section>
        )}

        {/* Issues */}
        {issues.length > 0 && (
          <section className="mt-14">
            <h2 className="text-2xl font-bold">What&apos;s holding it back</h2>
            <ul className="mt-5 space-y-3">
              {issues.map((issue) => (
                <li
                  key={issue}
                  className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-200"
                >
                  <span aria-hidden className="mt-0.5 text-orange-400">
                    ▲
                  </span>
                  {issue}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              Every one of these is fixable — most within days.
            </p>
          </section>
        )}

        {/* Business understanding */}
        {payload.summary && (
          <section className="mt-14 rounded-2xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-bold">What we understood about {business}</h2>
            <p className="mt-3 text-sm leading-7 text-slate-300">{payload.summary}</p>
          </section>
        )}

        {/* CTA */}
        <section className="mt-14 rounded-3xl bg-gradient-to-br from-orange-500 to-orange-700 p-8 text-center sm:p-12">
          <h2 className="text-2xl font-extrabold text-white sm:text-3xl">
            Ready to make it real?
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-orange-100">
            Reply on WhatsApp and we&apos;ll walk you through exactly what we&apos;d
            build, or grab a free call — no pressure, no jargon.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {waLink && (
              <a
                href={waLink}
                className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-orange-700 shadow-lg transition hover:bg-orange-50"
              >
                💬 Continue on WhatsApp
              </a>
            )}
            {payload.booking_url && (
              <a
                href={payload.booking_url}
                className="rounded-xl border border-white/60 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                📅 Book a free call
              </a>
            )}
            {row.report_pdf_url && (
              <a
                href={row.report_pdf_url}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-white/60 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                📄 Full audit report (PDF)
              </a>
            )}
          </div>
        </section>

        {/* Packages */}
        <section className="mt-14">
          <h2 className="text-center text-2xl font-bold">Where most businesses start</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {tiers.map((tier, i) => (
              <div
                key={tier.key}
                className={`rounded-2xl border p-6 ${
                  i === 1
                    ? "border-orange-500/50 bg-orange-500/10"
                    : "border-white/10 bg-white/5"
                }`}
              >
                {i === 1 && (
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-orange-400">
                    Most popular
                  </p>
                )}
                <h3 className="text-lg font-bold">{tier.name}</h3>
                <p className="text-xs text-slate-400">{tier.tagline}</p>
                <p className="mt-3 text-2xl font-extrabold">{money(tier.price)}</p>
                <ul className="mt-4 space-y-2 text-xs leading-5 text-slate-300">
                  {tier.features.slice(0, 4).map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-orange-400">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-center text-xs text-slate-500">
            E-commerce stores, AI agents and custom builds quoted separately —
            just ask.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/10 py-8 text-center text-xs text-slate-500">
        {PROPOSAL_COMPANY.name} · {PROPOSAL_COMPANY.website} · {PROPOSAL_COMPANY.email}
      </footer>
    </div>
  );
}

function ScoreRing({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 80 ? "text-emerald-400" : value >= 50 ? "text-amber-400" : "text-rose-400";
  const track = 2 * Math.PI * 26;
  const filled = (Math.max(0, Math.min(100, value)) / 100) * track;
  return (
    <div className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="relative h-20 w-20">
        <svg viewBox="0 0 64 64" className="h-20 w-20 -rotate-90">
          <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="6" className="text-white/10" />
          <circle
            cx="32"
            cy="32"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${track}`}
            className={tone}
          />
        </svg>
        <p
          className={`absolute inset-0 grid place-items-center text-lg font-extrabold ${tone}`}
        >
          {value}
        </p>
      </div>
      <p className="mt-2 text-xs font-medium text-slate-300">{label}</p>
    </div>
  );
}
