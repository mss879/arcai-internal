import { AuditForm } from "./audit-form";

export const metadata = {
  title: "Free website audit — ARC AI",
  description:
    "A real audit of your website: speed, mobile, SEO essentials and what is costing you visitors. Measured, not guessed.",
};

/**
 * The free-audit lead magnet (0117).
 *
 * Public and deliberately plain: one field for the address, one for the email,
 * and an honest promise about what arrives and when. The report is genuinely
 * the same audit the agency runs on a prospect during outreach — giving away
 * something real is the only version of this that works.
 */
export default function AuditPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-12 text-white sm:py-20">
      <div className="mx-auto max-w-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-400">
          ARC AI
        </p>
        <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">
          What is your website actually costing you?
        </h1>
        <p className="mt-4 text-base leading-relaxed text-slate-300">
          We&apos;ll run the same audit we run for our own clients — speed on a
          phone, the SEO essentials Google looks for, and the things quietly
          losing you visitors — and email you the report as a PDF.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Free, no call required, and it takes us a few minutes to run properly.
        </p>

        <div className="mt-8">
          <AuditForm />
        </div>

        <ul className="mt-10 space-y-2 text-sm text-slate-400">
          <li>· Measured with Google&apos;s own Lighthouse, not a checklist.</li>
          <li>· Nine on-page checks, each explained in plain English.</li>
          <li>· One email. We don&apos;t sell your address to anyone.</li>
        </ul>
      </div>
    </div>
  );
}
