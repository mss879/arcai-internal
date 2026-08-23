import { createClient } from "@/lib/supabase/server";
import type {
  Cheque,
  Client,
  Expense,
  Payment,
  PaymentInstallment,
  PaymentPlan,
} from "@/lib/types";

import { FinanceView } from "./finance-view";

export const metadata = { title: "Money & Finance" };

export default async function FinancePage() {
  const supabase = await createClient();

  const [
    plansRes,
    installmentsRes,
    chequesRes,
    expensesRes,
    paymentsRes,
    clientsRes,
    projectsRes,
    recurringRes,
  ] = await Promise.all([
      supabase.from("payment_plans").select("*").order("created_at", { ascending: false }),
      supabase.from("payment_installments").select("*").order("due_date"),
      supabase.from("cheques").select("*").order("due_date"),
      supabase.from("expenses").select("*").order("expense_date", { ascending: false }),
      supabase
        .from("payments")
        .select("*")
        .eq("status", "paid")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.from("clients").select("id, name, company").order("name"),
      // 0100 — a cost or an arrangement can name the project it belongs to.
      supabase
        .from("projects")
        .select("id, name, client:clients(name)")
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      // 0100 — the arrangements, each with the months it has generated.
      supabase
        .from("recurring_income")
        .select("*, entries:recurring_income_entries(*)")
        .order("is_active", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);

  const projects = (projectsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientName: (p as any).client?.name ?? null,
  }));

  return (
    <FinanceView
      plans={(plansRes.data ?? []) as PaymentPlan[]}
      installments={(installmentsRes.data ?? []) as PaymentInstallment[]}
      cheques={(chequesRes.data ?? []) as Cheque[]}
      expenses={(expensesRes.data ?? []) as Expense[]}
      paidPayments={(paymentsRes.data ?? []) as Payment[]}
      clients={(clientsRes.data ?? []) as Pick<Client, "id" | "name" | "company">[]}
      projects={projects}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recurring={(recurringRes.data ?? []) as any}
    />
  );
}
