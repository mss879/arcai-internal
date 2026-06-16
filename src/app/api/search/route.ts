import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const profile = await getProfile();
    if (!profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") || "";

    if (!q.trim()) {
      return NextResponse.json({ results: [] });
    }

    const supabase = await createClient();
    const term = `%${q.trim()}%`;

    // Query tables in parallel
    const [
      { data: clients, error: clientsErr },
      { data: todos, error: todosErr },
      { data: projects, error: projectsErr },
      { data: leads, error: leadsErr },
      { data: meetings, error: meetingsErr },
      { data: resources, error: resourcesErr },
    ] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, company, email, city")
        .or(`name.ilike.${term},company.ilike.${term},email.ilike.${term},city.ilike.${term}`)
        .limit(5),
      supabase
        .from("todos")
        .select("id, title, description, status")
        .or(`title.ilike.${term},description.ilike.${term}`)
        .limit(5),
      supabase
        .from("projects")
        .select("id, name, description, status")
        .or(`name.ilike.${term},description.ilike.${term}`)
        .limit(5),
      supabase
        .from("leads")
        .select("id, title, company, contact_name, notes")
        .or(`title.ilike.${term},company.ilike.${term},contact_name.ilike.${term},notes.ilike.${term}`)
        .limit(5),
      supabase
        .from("meeting_bookings")
        .select("id, client_name, notes, booking_date")
        .or(`client_name.ilike.${term},notes.ilike.${term}`)
        .limit(5),
      supabase
        .from("resources")
        .select("id, name, description, kind, link_url")
        .or(`name.ilike.${term},description.ilike.${term}`)
        .limit(5),
    ]);

    // Log errors if any, but don't fail the whole search if one table fails
    if (clientsErr) console.error("Search clients error:", clientsErr);
    if (todosErr) console.error("Search todos error:", todosErr);
    if (projectsErr) console.error("Search projects error:", projectsErr);
    if (leadsErr) console.error("Search leads error:", leadsErr);
    if (meetingsErr) console.error("Search meetings error:", meetingsErr);
    if (resourcesErr) console.error("Search resources error:", resourcesErr);

    const results = [
      ...(clients || []).map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: c.company || c.email || c.city || "Client",
        category: "Clients",
        href: `/clients`,
      })),
      ...(todos || []).map((t) => ({
        id: t.id,
        title: t.title,
        subtitle: t.description || `Todo (${t.status})`,
        category: "To-Dos",
        href: `/todos`,
      })),
      ...(projects || []).map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: p.description || `Project (${p.status})`,
        category: "Projects",
        href: `/projects/${p.id}`,
      })),
      ...(leads || []).map((l) => ({
        id: l.id,
        title: l.title,
        subtitle: l.company || l.contact_name || "CRM Lead",
        category: "CRM Pipeline",
        href: `/crm?p=${l.id}`,
      })),
      ...(meetings || []).map((m) => ({
        id: m.id,
        title: m.client_name,
        subtitle: `${m.booking_date}${m.notes ? ` - ${m.notes}` : ""}`,
        category: "Meetings",
        href: `/meetings`,
      })),
      ...(resources || []).map((r) => ({
        id: r.id,
        title: r.name,
        subtitle: r.description || `${r.kind === "link" ? r.link_url : "Resource file"}`,
        category: "Resources",
        href: `/resources`,
      })),
    ];

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Global search API error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
