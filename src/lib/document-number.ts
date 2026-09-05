import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

export type DocumentKind = "invoice" | "quote" | "notice";

/**
 * The next number in a document series (0120).
 *
 * Five writers used to count in five different ways — highest-plus-one,
 * row-count-plus-one, count-plus-201 — and none held a lock, which is how
 * two invoices came to share a number. next_document_number() allocates
 * under a row lock; this is the one place the app calls it.
 *
 * `fallback` is what the caller would have done before 0120. It runs when
 * the function is not there yet (migration not applied), so the app keeps
 * working; it is never used to skip the counter when the counter exists.
 * nextDocumentNumber() in src/lib/invoice.ts stays as the form PREVIEW —
 * what the number will probably be — and this is what it actually is.
 */
export async function allocateDocumentNumber(
  db: DB,
  kind: DocumentKind,
  fallback: () => Promise<string> | string,
): Promise<string> {
  try {
    const { data, error } = await db.rpc("next_document_number", { p_kind: kind });
    if (!error && typeof data === "string" && data.trim()) return data;
    if (error) {
      console.error(`[document-number] ${kind}: ${error.message} — using the legacy rule`);
    }
  } catch (e) {
    console.error(`[document-number] ${kind}:`, e);
  }
  return fallback();
}
