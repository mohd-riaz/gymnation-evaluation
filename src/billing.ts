import { dueDate, monthIndex, monthRange, parseDate, validateRange } from "./dates";
import { ApiError } from "./errors";
import { amounts, invoicesFor, roundHalfUp } from "./invoices";
import type { Agreement, FreezeChange, Invoice, Plan, PlanChange, Store } from "./models";

interface ScheduleEntry { day: number; invoice: Invoice; freezeFee: bigint }
interface EffectiveChange { on: number; effective: number; plan: Plan; old: Plan; immediate: boolean }

function freezesFor(store: Store, agreement: Agreement): FreezeChange[] {
  return [...(store.changes.get(agreement.id)?.values() ?? [])]
    .filter((change): change is FreezeChange => change.type === "FREEZE")
    .sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
}

function frozenDays(freezes: FreezeChange[], from: number, until: number): number {
  return freezes.reduce((days, freeze) => days + Math.max(0,
    Math.min(until, parseDate(freeze.to) + 1) - Math.max(from, parseDate(freeze.from))), 0);
}

function calendarDay(day: number) {
  const date = new Date(day * 86_400_000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const anchor = date.getUTCDate();
  return { index: year * 12 + month - 1, anchor,
    text: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(anchor).padStart(2, "0")}` };
}

function schedule(store: Store, agreement: Agreement, through: number): ScheduleEntry[] {
  const plan = store.plans.get(agreement.plan_id)!;
  const start = parseDate(agreement.start_date);
  const startMonth = monthIndex(agreement.start_date);
  const nextMonth = startMonth + (dueDate(startMonth, agreement.due_day).day <= start ? 1 : 0);
  const first = invoicesFor(agreement, plan, agreement.start_date, agreement.start_date)[0];
  const freezes = freezesFor(store, agreement);
  for (const freeze of freezes) through = Math.max(through, parseDate(freeze.from));
  const entries: ScheduleEntry[] = [{ day: start, invoice: first, freezeFee: 0n }];
  for (let index = nextMonth; ; index++) {
    const due = dueDate(index, agreement.due_day);
    entries.push({ day: due.day, freezeFee: 0n, invoice: {
      invoice_no: entries.length + 1, due_date: due.text, kind: "MONTHLY", proration: null,
      ...amounts(BigInt(plan.monthly), plan),
    } });
    if (due.day > through) break;
  }
  const usedYears = new Set<string>();
  for (const freeze of freezes) {
    const from = parseDate(freeze.from);
    const duration = parseDate(freeze.to) - from + 1;
    const target = entries.findIndex((entry) => entry.day >= from);
    const moved = entries[target];
    moved.day += duration;
    const landed = calendarDay(moved.day);
    moved.invoice.due_date = landed.text;
    const year = freeze.from.slice(0, 4);
    if (usedYears.has(year)) moved.freezeFee += plan.country === "BH" ? 2000n : 2500n;
    usedYears.add(year);
    // Rebuild subsequent dates from the landing month's anchor, never from a clamped date.
    for (let i = target + 1; i < entries.length; i++) {
      const due = dueDate(landed.index + i - target, landed.anchor);
      entries[i].day = due.day;
      entries[i].invoice.due_date = due.text;
    }
  }
  return entries;
}

function planAt(original: Plan, timeline: EffectiveChange[], day: number): Plan {
  // Timeline is ordered by request date, so the latest on among effective changes wins.
  let plan = original;
  for (const change of timeline) if (change.effective <= day) plan = change.plan;
  return plan;
}

function rawInvoices(store: Store, agreement: Agreement, through: number): ScheduleEntry[] {
  const original = store.plans.get(agreement.plan_id)!;
  const changes = [...(store.changes.get(agreement.id)?.values() ?? [])]
    .filter((change): change is PlanChange => change.type === "PLAN")
    .sort((a, b) => a.on < b.on ? -1 : a.on > b.on ? 1 : 0);
  const horizon = Math.max(through, ...changes.map((change) => parseDate(change.on) + 7));
  const entries = schedule(store, agreement, horizon);
  const freezes = freezesFor(store, agreement);
  const timeline: EffectiveChange[] = [];
  for (const change of changes) {
    const on = parseDate(change.on);
    const old = planAt(original, timeline, on - 1);
    const plan = store.plans.get(change.plan_id)!;
    const immediate = plan.monthly >= old.monthly;
    const effective = immediate ? on : entries.find((entry) => entry.day >= on + 7)!.day;
    timeline.push({ on, effective, old, plan, immediate });
  }
  return entries.map((entry, index) => {
    if (index === 0) return entry;
    const previous = entries[index - 1];
    const plan = planAt(original, timeline, entry.day);
    let net = BigInt(plan.monthly) + entry.freezeFee;
    for (const change of timeline) {
      if (!change.immediate || change.on <= previous.day || change.on >= entry.day) continue;
      const remaining = entry.day - change.on - frozenDays(freezes, change.on, entry.day);
      const cycle = index === 1 ? entries[0].invoice.proration!.cycle_days
        : entry.day - previous.day - frozenDays(freezes, previous.day, entry.day);
      net += roundHalfUp(BigInt(change.plan.monthly) * BigInt(remaining), BigInt(cycle))
        - roundHalfUp(BigInt(change.old.monthly) * BigInt(remaining), BigInt(cycle));
    }
    return { ...entry, invoice: { ...entry.invoice, ...amounts(net, original) } };
  });
}

function ledgerThrough(store: Store, agreement: Agreement, through: number): Invoice[] {
  const original = store.plans.get(agreement.plan_id)!;
  const closed = store.closedInvoices.get(agreement.id) ?? new Map<number, Invoice>();
  const closedDay = store.closedThrough ? parseDate(monthRange(store.closedThrough).to) : -Infinity;
  const raw = rawInvoices(store, agreement, Math.max(through, closedDay));
  // Recalculate the complete closed ledger before corrections, then subtract actual charges.
  // Closed corrections are included in actuals, preventing the same credit/debit being applied twice.
  let balance = 0n;
  for (const { invoice } of raw) {
    const snapshot = closed.get(invoice.invoice_no);
    if (snapshot) balance += BigInt(invoice.net) - BigInt(snapshot.net);
  }
  const result: Invoice[] = [];
  for (const { day, invoice } of raw) {
    const snapshot = closed.get(invoice.invoice_no);
    if (snapshot) { result.push(snapshot); continue; }
    if (day > through) break;
    const adjusted = BigInt(invoice.net) + balance;
    const net = adjusted < 0n ? 0n : adjusted;
    balance = adjusted < 0n ? adjusted : 0n;
    result.push({ ...invoice, ...amounts(net, original) });
  }
  return result;
}

export function agreementInvoices(store: Store, agreement: Agreement, from: string, to: string): Invoice[] {
  const { toDay } = validateRange(from, to);
  // Keep the original direct month lookup for agreements unaffected by the extension.
  if (!store.changes.get(agreement.id)?.size && !store.closedInvoices.get(agreement.id)?.size) {
    return invoicesFor(agreement, store.plans.get(agreement.plan_id)!, from, to);
  }
  return ledgerThrough(store, agreement, toDay).filter((invoice) => invoice.due_date >= from && invoice.due_date <= to);
}

export function closeMonth(store: Store, month: string): void {
  const { to } = monthRange(month);
  if (month <= store.closedThrough) throw new ApiError(409, "MONTH_CLOSED", "Month is already closed.");
  const through = parseDate(to);
  // Stage every snapshot before committing the global watermark, with no awaits.
  const snapshots = new Map<string, Map<number, Invoice>>();
  for (const agreement of store.agreements.values()) {
    snapshots.set(agreement.id, new Map(ledgerThrough(store, agreement, through)
      .filter((invoice) => invoice.due_date <= to)
      .map((invoice) => [invoice.invoice_no, { ...invoice }])));
  }
  store.closedInvoices = snapshots;
  store.closedThrough = month;
}
