import { redirect } from "next/navigation";

// Quotes now live inside the Invoices page (Quotes tab).
export default function QuotesPage() {
  redirect("/invoices?tab=quotes");
}
