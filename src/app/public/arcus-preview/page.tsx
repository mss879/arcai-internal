import { notFound } from "next/navigation";

import { PreviewClient } from "./preview-client";

/**
 * DEV-ONLY visual harness for the Command View.
 *
 * The stage lives behind auth and a login nobody can automate, which makes
 * "does it actually look right" unanswerable during development. This route
 * renders the real components with a mock engine — no Supabase, no model,
 * no microphone — plus controls to force each status and a synthetic voice
 * signal, so every state can be seen and screenshotted at will.
 *
 * It sits under /public purely because the middleware already lets that
 * prefix through; the production build answers 404 before rendering anything.
 */
export default function ArcusPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PreviewClient />;
}
