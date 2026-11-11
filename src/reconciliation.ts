import { monthRange, parseDate } from "./dates";
import { ApiError } from "./errors";
import { invoicesFor } from "./invoices";
import { type ExpectedInvoice, type GatewayRow, type Run, type Store, type Verdict } from "./models";

export function reconcile(store: Store, month: string, rows: GatewayRow[]): Run {
  const { from, to } = monthRange(month);
  const counts = new Map<string, number>();
  for (const row of rows) {
    parseDate(row.attempted_on);
    counts.set(row.gateway_txn_id, (counts.get(row.gateway_txn_id) ?? 0) + 1);
  }
  const errors: { gateway_txn_id: string; code: string }[] = [];
  for (const row of rows) {
    const add = (code: string) => errors.push({ gateway_txn_id: row.gateway_txn_id, code });
    if (counts.get(row.gateway_txn_id)! > 1) add("DUPLICATE_TXN");
    if (row.attempted_on.slice(0, 7) !== month) add("ROW_OUTSIDE_MONTH");
    const agreement = store.agreements.get(row.agreement_id);
    if (agreement && store.plans.get(agreement.plan_id)!.currency !== row.currency) add("CURRENCY_MISMATCH");
  }
  if (errors.length) throw new ApiError(422, "INVALID_ROWS", "Gateway rows failed validation.", { errors });

  const expected: ExpectedInvoice[] = [];
  const byAgreement = new Map<string, ExpectedInvoice[]>();
  for (const agreement of store.agreements.values()) {
    const invoices = invoicesFor(agreement, store.plans.get(agreement.plan_id)!, from, to).map((invoice) => ({
      agreement_id: agreement.id, invoice_no: invoice.invoice_no, due_date: invoice.due_date,
      total: invoice.total, currency: invoice.currency,
    }));
    byAgreement.set(agreement.id, invoices);
    expected.push(...invoices);
  }
  // Link independently, then count links: input order cannot influence a verdict.
  const links = rows.map((row) => row.status === "DECLINED" ? undefined :
    byAgreement.get(row.agreement_id)?.find((invoice) => Math.abs(invoice.total - row.amount) <= 1));
  const linkedCounts = new Map<ExpectedInvoice, number>();
  for (const invoice of links) if (invoice) linkedCounts.set(invoice, (linkedCounts.get(invoice) ?? 0) + 1);
  const summary: Run["summary"] = { MATCHED: 0, DUE_DAY_DRIFT: 0, DOUBLE_CHARGE_RISK: 0, MISSING_FROM_LEDGER: 0, DECLINED: 0 };
  const results = rows.map((row, index) => {
    const invoice = links[index];
    const verdict: Verdict = row.status === "DECLINED" ? "DECLINED"
      : !invoice ? "MISSING_FROM_LEDGER"
      : linkedCounts.get(invoice)! > 1 ? "DOUBLE_CHARGE_RISK"
      : row.attempted_on === invoice.due_date ? "MATCHED" : "DUE_DAY_DRIFT";
    summary[verdict]++;
    return { gateway_txn_id: row.gateway_txn_id, verdict,
      invoice: invoice ? { agreement_id: invoice.agreement_id, invoice_no: invoice.invoice_no } : null };
  });
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return {
    id: crypto.randomUUID(), month, summary, rows: results,
    unmatched_invoices: expected.filter((invoice) => !linkedCounts.has(invoice)).sort((a, b) =>
      compare(a.due_date, b.due_date) || compare(a.agreement_id, b.agreement_id) || a.invoice_no - b.invoice_no),
  };
}
