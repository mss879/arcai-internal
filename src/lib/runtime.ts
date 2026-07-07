import "server-only";

/**
 * True when running in the deployed, time-capped serverless environment
 * (Netlify Functions), where a long inline job — a multi-minute OpenAI synthesis
 * or a ~45s PageSpeed pass — would be killed by the ~26s function budget and so
 * must be offloaded (to a Background Function) or bounded.
 *
 * IMPORTANT: do NOT use `process.env.NETLIFY` for this. Netlify sets it at BUILD
 * time but NOT reliably in the function RUNTIME, so at runtime it reads as
 * undefined and the code wrongly takes the "local, run inline" path in
 * production — which is exactly why CRM prospect-research synthesis hung on the
 * hosted site (the inline OpenAI call was killed mid-request) while working
 * locally. `NODE_ENV` IS reliable at runtime: Next.js sets it to "production" in
 * the deployed build and "development" under `next dev`, cleanly separating
 * local dev (uncapped → inline) from the deployed app (capped → offload). We
 * still honor an explicit `NETLIFY` flag if one happens to be present.
 */
export const IS_SERVERLESS =
  process.env.NODE_ENV === "production" || Boolean(process.env.NETLIFY);
