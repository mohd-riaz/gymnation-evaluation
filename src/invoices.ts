import { dueDate, monthIndex, parseDate, validateRange } from "./dates";
import { invalid } from "./errors";
import { countries, type Agreement, type Invoice, type Plan } from "./models";

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function amounts(net: bigint, plan: Plan) {
  const vat = roundHalfUp(net * BigInt(countries[plan.country].vat), 100n);
  const total = net + vat;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid("Invoice amounts must fit safe integer minor units.");
  return { net: Number(net), vat: Number(vat), total: Number(total), currency: plan.currency };
}

export function validatePlanAmounts(plan: Plan): void {
  amounts(BigInt(plan.monthly) + BigInt(plan.joining_fee), plan);
}

export function invoicesFor(agreement: Agreement, plan: Plan, from: string, to: string): Invoice[] {
  const { fromDay, toDay } = validateRange(from, to);
  const start = parseDate(agreement.start_date);
  const startMonth = monthIndex(agreement.start_date);
  const nextMonth = startMonth + (dueDate(startMonth, agreement.due_day).day <= start ? 1 : 0);
  const next = dueDate(nextMonth, agreement.due_day).day;
  const previous = dueDate(nextMonth - 1, agreement.due_day).day;
  const invoices: Invoice[] = [];
  if (start >= fromDay && start <= toDay) {
    const days = next - start;
    const cycle_days = next - previous;
    const net = roundHalfUp(BigInt(plan.monthly) * BigInt(days), BigInt(cycle_days)) + BigInt(plan.joining_fee);
    invoices.push({ invoice_no: 1, due_date: agreement.start_date, kind: "FIRST", proration: { days, cycle_days }, ...amounts(net, plan) });
  }
  // Jump to the requested month instead of scanning the agreement's entire history.
  for (let index = Math.max(nextMonth, monthIndex(from)); index <= monthIndex(to); index++) {
    const due = dueDate(index, agreement.due_day);
    if (due.day >= fromDay && due.day <= toDay) {
      invoices.push({ invoice_no: index - nextMonth + 2, due_date: due.text, kind: "MONTHLY", proration: null, ...amounts(BigInt(plan.monthly), plan) });
    }
  }
  return invoices;
}
