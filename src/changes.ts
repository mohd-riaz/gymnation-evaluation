import { parseDate } from "./dates";
import { ApiError } from "./errors";
import type { Agreement, AgreementChange, Store } from "./models";

export function agreementById(store: Store, id: string): Agreement {
  const agreement = store.agreements.get(id);
  if (!agreement) throw new ApiError(404, "NOT_FOUND", "Agreement not found.");
  return agreement;
}

function sameChange(a: AgreementChange, b: AgreementChange): boolean {
  if (a.type === "FREEZE" && b.type === "FREEZE") return a.from === b.from && a.to === b.to;
  if (a.type === "PLAN" && b.type === "PLAN") return a.on === b.on && a.plan_id === b.plan_id;
  return false;
}

export function recordChange(store: Store, agreement: Agreement, change: AgreementChange): 200 | 201 {
  // Calendar validation precedes idempotency; business validation follows it.
  if (change.type === "FREEZE") { parseDate(change.from); parseDate(change.to); }
  else parseDate(change.on);
  const changes = store.changes.get(agreement.id) ?? new Map<string, AgreementChange>();
  const existing = changes.get(change.id);
  if (existing) {
    if (sameChange(existing, change)) return 200;
    throw new ApiError(409, "CHANGE_EXISTS", "Change id already has a different body.");
  }
  if (change.type === "FREEZE") {
    const duration = parseDate(change.to) - parseDate(change.from) + 1;
    if (duration < 7 || duration > 90 || change.from <= agreement.start_date) {
      throw new ApiError(422, "INVALID_FREEZE", "Freeze must start after the agreement and last 7–90 inclusive days.");
    }
    if (change.from.slice(0, 7) <= store.closedThrough) {
      throw new ApiError(409, "MONTH_CLOSED", "Freeze starts in a closed month.");
    }
    if ([...changes.values()].some((other) => other.type === "FREEZE" && change.from <= other.to && change.to >= other.from)) {
      throw new ApiError(409, "CHANGE_CONFLICT", "Freeze overlaps an existing freeze.");
    }
  } else {
    const plan = store.plans.get(change.plan_id);
    if (!plan) throw new ApiError(422, "UNKNOWN_PLAN", "Plan does not exist.");
    if (plan.country !== store.plans.get(agreement.plan_id)!.country) {
      throw new ApiError(422, "PLAN_COUNTRY_MISMATCH", "Plan and agreement countries must match.");
    }
    if (change.on <= agreement.start_date) {
      throw new ApiError(422, "INVALID_PLAN_CHANGE", "Plan change must be after the agreement start.");
    }
    if ([...changes.values()].some((other) => other.type === "PLAN" && other.on === change.on)) {
      throw new ApiError(409, "CHANGE_CONFLICT", "A plan change already exists on this date.");
    }
  }
  // Synchronous validation + insertion prevents concurrent duplicate/conflicting writes.
  changes.set(change.id, { ...change });
  store.changes.set(agreement.id, changes);
  return 201;
}
