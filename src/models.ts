export const countries = {
  AE: { dial: "971", currency: "AED", vat: 5, national: /^05\d{8}$/, mobile: /^5\d{8}$/ },
  SA: { dial: "966", currency: "SAR", vat: 15, national: /^05\d{8}$/, mobile: /^5\d{8}$/ },
  BH: { dial: "973", currency: "BHD", vat: 10, national: /^3\d{7}$/, mobile: /^3\d{7}$/ },
} as const;

export type Country = keyof typeof countries;
export type Currency = (typeof countries)[Country]["currency"];
export interface Member { id: string; name: string; country: Country; phone: string }
export interface Plan { id: string; country: Country; currency: Currency; monthly: number; joining_fee: number }
export interface Agreement { id: string; member_id: string; plan_id: string; start_date: string; due_day: number }
export interface Invoice {
  invoice_no: number;
  due_date: string;
  kind: "FIRST" | "MONTHLY";
  proration: { days: number; cycle_days: number } | null;
  net: number;
  vat: number;
  total: number;
  currency: Currency;
}
export interface GatewayRow {
  gateway_txn_id: string;
  agreement_id: string;
  amount: number;
  currency: Currency;
  status: "SETTLED" | "DECLINED";
  attempted_on: string;
}
export type Verdict = "MATCHED" | "DUE_DAY_DRIFT" | "DOUBLE_CHARGE_RISK" | "MISSING_FROM_LEDGER" | "DECLINED";
export interface ExpectedInvoice { agreement_id: string; invoice_no: number; due_date: string; total: number; currency: Currency }
export interface Run {
  id: string;
  month: string;
  summary: Record<Verdict, number>;
  rows: { gateway_txn_id: string; verdict: Verdict; invoice: { agreement_id: string; invoice_no: number } | null }[];
  unmatched_invoices: ExpectedInvoice[];
}

export function createStore() {
  return {
    members: new Map<string, Member>(),
    membersByPhone: new Map<string, Member>(),
    plans: new Map<string, Plan>(),
    agreements: new Map<string, Agreement>(),
    runs: new Map<string, Run>(),
  };
}
export type Store = ReturnType<typeof createStore>;
