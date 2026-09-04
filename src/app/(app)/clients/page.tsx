import { createClient } from "@/lib/supabase/server";

import { ClientsView } from "./clients-view";

export const metadata = { title: "Clients" };

const PAGE_SIZE = 100;

/**
 * The client directory, a page at a time (0114).
 *
 * The list used to load every client and search them in the browser; the
 * search box now drives `?q=` and the server filters with the same columns,
 * so the page grows with the agency without the download growing with it.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  // Commas and brackets are PostgREST filter syntax; a search term never needs them.
  const term = (params.q ?? "").replace(/[,()]/g, " ").trim();

  let query = supabase
    .from("clients")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (term) {
    const like = `%${term}%`;
    query = query.or(
      `name.ilike.${like},company.ilike.${like},email.ilike.${like},city.ilike.${like}`,
    );
  }
  const { data, count } = await query;

  return (
    <ClientsView
      clients={data ?? []}
      initialQuery={term}
      page={page}
      pageSize={PAGE_SIZE}
      total={count ?? 0}
    />
  );
}
