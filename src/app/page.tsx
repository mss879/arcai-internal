import { redirect } from "next/navigation";

import { getProfile, isSupabaseConfigured } from "@/lib/auth";

export default async function Home() {
  if (!isSupabaseConfigured()) redirect("/login");
  const profile = await getProfile();
  redirect(profile ? "/dashboard" : "/login");
}
