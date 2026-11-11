import { Elysia, t } from "elysia";
import { parseDate } from "./dates";
import { ApiError, invalid } from "./errors";
import { invoicesFor, validatePlanAmounts } from "./invoices";
import { countries, createStore, type Plan } from "./models";
import { normalizePhone } from "./phones";
import { reconcile } from "./reconciliation";

const country = t.Union([t.Literal("AE"), t.Literal("SA"), t.Literal("BH")]);
const currency = t.Union([t.Literal("AED"), t.Literal("SAR"), t.Literal("BHD")]);
const id = t.String({ minLength: 1 });
const date = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
// Elysia's t.Integer coerces numeric strings; this contract requires JSON numbers.
const integer = (minimum: number, maximum: number) => t.Number({ minimum, maximum, multipleOf: 1 });
const money = (minimum: number) => integer(minimum, Number.MAX_SAFE_INTEGER);
const params = t.Object({ id });

export function createApp() {
  const store = createStore();
  return new Elysia({ normalize: false })
    .onError(({ code, error, set }) => {
      if (error instanceof ApiError) {
        set.status = error.status;
        return { error: { code: error.code, message: error.message, ...error.details } };
      }
      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 422;
        return { error: { code: "VALIDATION", message: "Request fields must match the route schema and contain valid JSON." } };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: "Route not found." } };
      }
      console.error(error);
      set.status = 500;
      return { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
    })
    .get("/health", () => ({ status: "ok" }))
    .post("/members", ({ body, set }) => {
      const name = body.name.trim();
      if (name.length < 1 || name.length > 120) invalid("Name must contain 1–120 characters after trimming.");
      const phone = normalizePhone(body.phone, body.country);
      // No await between checking and inserting: atomic in this single-process server.
      const existing = store.membersByPhone.get(phone);
      if (existing) throw new ApiError(409, "PHONE_TAKEN", "Phone already belongs to a member.", { existing_member_id: existing.id });
      const member = { id: crypto.randomUUID(), name, country: body.country, phone };
      store.members.set(member.id, member);
      store.membersByPhone.set(phone, member);
      set.status = 201;
      return member;
    }, { body: t.Object({ name: t.String(), country, phone: t.String() }) })
    .get("/members/lookup", ({ query }) => {
      const phone = normalizePhone(query.phone, query.country, true);
      const member = store.membersByPhone.get(phone);
      if (!member) throw new ApiError(404, "NOT_FOUND", "Member not found.");
      return member;
    }, { query: t.Object({ phone: t.String(), country: t.Optional(country) }) })
    .post("/plans", ({ body, set }) => {
      const plan: Plan = { ...body, currency: countries[body.country].currency };
      validatePlanAmounts(plan);
      if (store.plans.has(body.id)) throw new ApiError(409, "PLAN_EXISTS", "Plan id already exists.");
      store.plans.set(plan.id, plan);
      set.status = 201;
      return plan;
    }, { body: t.Object({ id, country, monthly: money(1), joining_fee: money(0) }) })
    .post("/agreements", ({ body, set }) => {
      parseDate(body.start_date);
      const member = store.members.get(body.member_id);
      const plan = store.plans.get(body.plan_id);
      if (!member) throw new ApiError(422, "UNKNOWN_MEMBER", "Member does not exist.");
      if (!plan) throw new ApiError(422, "UNKNOWN_PLAN", "Plan does not exist.");
      if (member.country !== plan.country) throw new ApiError(422, "PLAN_COUNTRY_MISMATCH", "Plan and member countries must match.");
      const agreement = { id: crypto.randomUUID(), ...body };
      store.agreements.set(agreement.id, agreement);
      set.status = 201;
      return agreement;
    }, { body: t.Object({ member_id: id, plan_id: id, start_date: date, due_day: integer(1, 31) }) })
    .get("/agreements/:id/invoices", ({ params, query }) => {
      const agreement = store.agreements.get(params.id);
      if (!agreement) throw new ApiError(404, "NOT_FOUND", "Agreement not found.");
      return invoicesFor(agreement, store.plans.get(agreement.plan_id)!, query.from, query.to);
    }, { params, query: t.Object({ from: date, to: date }) })
    .post("/reconciliation/runs", ({ body, set }) => {
      const run = reconcile(store, body.month, body.rows);
      store.runs.set(run.id, run);
      set.status = 201;
      return run;
    }, { body: t.Object({ month: t.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" }), rows: t.Array(t.Object({
      gateway_txn_id: id, agreement_id: id, amount: money(1), currency,
      status: t.Union([t.Literal("SETTLED"), t.Literal("DECLINED")]), attempted_on: date,
    })) }) })
    .get("/reconciliation/runs/:id", ({ params }) => {
      const run = store.runs.get(params.id);
      if (!run) throw new ApiError(404, "NOT_FOUND", "Reconciliation run not found.");
      return run;
    }, { params });
}
