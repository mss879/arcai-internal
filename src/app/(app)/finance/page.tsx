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

  const [plansRes, installmentsRes, chequesRes, expensesRes, paymentsRes, clientsRes] =
    await Promise.all([
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
    ]);

  return (
    <FinanceView
      plans={(plansRes.data ?? []) as PaymentPlan[]}
      installments={(installmentsRes.data ?? []) as PaymentInstallment[]}
      cheques={(chequesRes.data ?? []) as Cheque[]}
      expenses={(expensesRes.data ?? []) as Expense[]}
      paidPayments={(paymentsRes.data ?? []) as Payment[]}
      clients={(clientsRes.data ?? []) as Pick<Client, "id" | "name" | "company">[]}
    />
  );
}
