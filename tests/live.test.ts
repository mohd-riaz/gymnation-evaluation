import { describe, expect, test } from "bun:test";
import { client, expectError, fixture } from "./helpers";
import type { AgreementChange, Invoice } from "../src/models";

async function liveFixture(original: "basic" | "any" | "plus" = "plus", start_date = "2027-01-15", due_day = 15) {
  const prices = { basic: [19995, 0], any: [24900, 9900], plus: [30000, 10000] };
  const [monthly, joining_fee] = prices[original];
  const api = await fixture({ country: "AE", monthly, joining_fee, start_date, due_day });
  for (const [id, [monthly, joining_fee]] of Object.entries(prices)) {
    expect((await api.request("/plans", { id, country: "AE", monthly, joining_fee })).status).toBe(201);
  }
  const path = `/agreements/${api.agreement.id}/changes`;
  async function change(body: AgreementChange, status = 201) {
    const response = await api.request(path, body);
    expect(response).toEqual({ status, body });
  }
  async function invoices(from = "2027-01-01", to = "2027-12-31"): Promise<Invoice[]> {
    const response = await api.request(`/agreements/${api.agreement.id}/invoices?from=${from}&to=${to}`);
    expect(response.status).toBe(200);
    return response.body;
  }
  async function close(month: string) {
    expect(await api.request("/months/close", { month })).toEqual({ status: 200, body: { month } });
  }
  return { ...api, path, change, invoices, close };
}

const freeze = (id: string, from: string, to: string): AgreementChange => ({ id, type: "FREEZE", from, to });
const plan = (id: string, plan_id: string, on: string): AgreementChange => ({ id, type: "PLAN", plan_id, on });
const pairs = (invoices: Invoice[]) => invoices.map(({ due_date, net }) => [due_date, net]);

describe("live worked examples", () => {
  test("1: first freeze shifts to day 31 and preserves the new anchor through April", async () => {
    const api = await liveFixture("any");
    await api.change(freeze("f1", "2027-03-01", "2027-03-16"));
    expect(pairs(await api.invoices("2027-03-01", "2027-05-31"))).toEqual([
      ["2027-03-31", 24900], ["2027-04-30", 24900], ["2027-05-31", 24900],
    ]);
  });
  test("2: second freeze resets anchor and adds a fee once", async () => {
    const api = await liveFixture("any");
    await api.change(freeze("f1", "2027-03-01", "2027-03-16"));
    await api.change(freeze("f2", "2027-05-20", "2027-05-29"));
    const invoices = await api.invoices("2027-03-01", "2027-07-31");
    expect(pairs(invoices)).toEqual([
      ["2027-03-31", 24900], ["2027-04-30", 24900], ["2027-06-10", 27400], ["2027-07-10", 24900],
    ]);
    expect(invoices.map((i) => i.invoice_no)).toEqual([3, 4, 5, 6]);
    expect(invoices[2].vat).toBe(1370);
  });
  test("3: upgrade excludes frozen days from both proration intervals", async () => {
    const api = await liveFixture("basic", "2027-03-05", 20);
    await api.change(plan("p1", "plus", "2027-04-05"));
    await api.change(freeze("f1", "2027-04-15", "2027-04-28"));
    expect(pairs(await api.invoices("2027-03-01", "2027-06-30"))).toEqual([
      ["2027-03-05", 10712], ["2027-03-20", 19995], ["2027-05-04", 34841], ["2027-06-04", 30000],
    ]);
  });
  test.each([8, 9])("4/5: lower price requested March %i respects seven-day notice", async (day) => {
    const api = await liveFixture();
    await api.change(plan("p1", "basic", `2027-03-0${day}`));
    expect(pairs(await api.invoices("2027-02-01", "2027-04-30"))).toEqual([
      ["2027-02-15", 30000], ["2027-03-15", day === 8 ? 19995 : 30000], ["2027-04-15", 19995],
    ]);
  });
  test("6: backdated credit preserves closed invoices and carries over a zero invoice", async () => {
    const api = await liveFixture();
    const before = await api.invoices("2027-01-01", "2027-03-31");
    await api.close("2027-03");
    await api.change(plan("p1", "basic", "2027-01-20"));
    expect(await api.invoices("2027-01-01", "2027-03-31")).toEqual(before);
    expect(pairs(await api.invoices("2027-04-01", "2027-06-30"))).toEqual([
      ["2027-04-15", 0], ["2027-05-15", 19980], ["2027-06-15", 19995],
    ]);
    expect(pairs(await api.invoices("2027-05-01", "2027-05-31"))).toEqual([["2027-05-15", 19980]]);
    await api.close("2027-04");
    expect(pairs(await api.invoices("2027-05-01", "2027-06-30"))).toEqual([["2027-05-15", 19980], ["2027-06-15", 19995]]);
    await api.close("2027-05");
    expect(pairs(await api.invoices("2027-06-01", "2027-06-30"))).toEqual([["2027-06-15", 19995]]);
  });
});

describe("live change validation and concurrency", () => {
  test("unknown agreement precedes schema validation and malformed JSON", async () => {
    const { request, app } = client();
    expectError(await request("/agreements/missing/changes", {}), 404, "NOT_FOUND");
    const response = await app.handle(new Request("http://localhost/agreements/missing/changes", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expectError({ status: response.status, body: await response.json() }, 404, "NOT_FOUND");
  });
  test.each([
    {}, { id: "c", type: "OTHER" }, { id: "c", type: "PLAN", plan_id: "plus", on: "2027-02-29" },
    { id: "c", type: "FREEZE", from: "2027-02-01", to: "2027-02-30" },
    { id: "c", type: "PLAN", plan_id: 5, on: "2027-02-01" },
    { id: "c", type: "PLAN", plan_id: "plus", on: "2027-02-01", extra: true },
  ])("malformed change %#", async (body) => {
    const api = await liveFixture();
    expectError(await api.request(api.path, body), 422, "VALIDATION");
  });
  test("idempotency ignores property order and precedes closure/conflict checks", async () => {
    const api = await liveFixture();
    const body = freeze("f", "2027-02-01", "2027-02-07");
    await api.change(body);
    await api.close("2027-03");
    expect(await api.request(api.path, { to: "2027-02-07", from: "2027-02-01", type: "FREEZE", id: "f" })).toEqual({ status: 200, body });
    expectError(await api.request(api.path, freeze("f", "2027-02-01", "2027-02-08")), 409, "CHANGE_EXISTS");
    expectError(await api.request(api.path, plan("f", "missing", "2027-01-01")), 409, "CHANGE_EXISTS");
    expectError(await api.request(api.path, freeze("f", "2027-02-01", "invalid")), 422, "VALIDATION");
  });
  test.each([
    ["2027-01-15", "2027-01-21"], ["2027-01-16", "2027-01-21"],
    ["2027-04-01", "2027-03-31"], ["2027-01-16", "2027-04-16"],
  ])("invalid inclusive freeze range %s to %s", async (from, to) => {
    const api = await liveFixture();
    expectError(await api.request(api.path, freeze("f", from, to)), 422, "INVALID_FREEZE");
  });
  test("freeze accepts both seven and ninety days", async () => {
    const api = await liveFixture();
    await api.change(freeze("a", "2027-01-16", "2027-01-22"));
    await api.change(freeze("b", "2027-05-01", "2027-07-29"));
  });
  test("business errors follow specified priority", async () => {
    const api = await liveFixture();
    await api.change(freeze("f", "2027-02-01", "2027-02-14"));
    await api.close("2027-03");
    expectError(await api.request(api.path, freeze("a", "2027-02-01", "2027-02-02")), 422, "INVALID_FREEZE");
    expectError(await api.request(api.path, freeze("b", "2027-02-01", "2027-02-14")), 409, "MONTH_CLOSED");
    expectError(await api.request(api.path, plan("a", "missing", "2027-01-01")), 422, "UNKNOWN_PLAN");
    await api.request("/plans", { id: "foreign", country: "SA", monthly: 100, joining_fee: 0 });
    expectError(await api.request(api.path, plan("a", "foreign", "2027-01-01")), 422, "PLAN_COUNTRY_MISMATCH");
    expectError(await api.request(api.path, plan("a", "basic", "2027-01-15")), 422, "INVALID_PLAN_CHANGE");
    await api.change(plan("valid", "basic", "2027-01-16"));
    expectError(await api.request(api.path, plan("conflict", "plus", "2027-01-16")), 409, "CHANGE_CONFLICT");
  });
  test("overlap includes endpoints, but adjacent freezes are permitted", async () => {
    const api = await liveFixture();
    await api.change(freeze("a", "2027-02-01", "2027-02-07"));
    expectError(await api.request(api.path, freeze("b", "2027-02-07", "2027-02-13")), 409, "CHANGE_CONFLICT");
    await api.change(freeze("c", "2027-02-08", "2027-02-14"));
  });
  test("concurrent identical requests apply once and conflicting requests have one winner", async () => {
    const api = await liveFixture();
    const body = freeze("a", "2027-02-01", "2027-02-07");
    const responses = await Promise.all(Array.from({ length: 20 }, () => api.request(api.path, body)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    const conflicts = await Promise.all(Array.from({ length: 20 }, (_, i) => api.request(api.path, plan(`p${i}`, "basic", "2027-04-01"))));
    expect(conflicts.filter((r) => r.status === 201)).toHaveLength(1);
    for (const response of conflicts.filter((r) => r.status !== 201)) expectError(response, 409, "CHANGE_CONFLICT");
  });
});

describe("live schedule and accounting edge cases", () => {
  test("a freeze beginning on a due date moves that invoice and keeps prior invoices unchanged", async () => {
    const api = await liveFixture("basic");
    const before = await api.invoices("2027-01-01", "2027-02-28");
    await api.change(freeze("f", "2027-03-15", "2027-03-21"));
    expect(await api.invoices("2027-01-01", "2027-02-28")).toEqual(before);
    expect(pairs(await api.invoices("2027-03-01", "2027-04-30"))).toEqual([["2027-03-22", 19995], ["2027-04-22", 19995]]);
  });
  test("ninety-day freeze crosses months without leaving duplicate or skipped invoice numbers", async () => {
    const api = await liveFixture("basic");
    await api.change(freeze("f", "2027-01-16", "2027-04-15"));
    const invoices = await api.invoices("2027-01-01", "2027-07-31");
    expect(pairs(invoices)).toEqual([["2027-01-15", 19995], ["2027-05-16", 19995], ["2027-06-16", 19995], ["2027-07-16", 19995]]);
    expect(invoices.map((invoice) => invoice.invoice_no)).toEqual([1, 2, 3, 4]);
  });
  test("a shifted due date controls the downgrade notice deadline", async () => {
    const api = await liveFixture();
    await api.change(plan("p", "basic", "2027-03-09"));
    await api.change(freeze("f", "2027-03-01", "2027-03-07"));
    expect(pairs(await api.invoices("2027-03-01", "2027-04-30"))).toEqual([["2027-03-22", 19995], ["2027-04-22", 19995]]);
  });
  test("multiple upgrades accumulate independently rounded differences", async () => {
    const api = await liveFixture("basic");
    await api.change(plan("a", "any", "2027-02-20"));
    await api.change(plan("b", "plus", "2027-03-01"));
    // Feb 15–Mar 15: 28 days. First adjustment: 20454 - 16424 = 4030.
    // Second adjustment: 15000 - 12450 = 2550. Joining fees are not repeated.
    expect(pairs(await api.invoices("2027-03-01", "2027-04-30"))).toEqual([["2027-03-15", 36580], ["2027-04-15", 30000]]);
  });
  test("changes dated during a freeze exclude the frozen part of remaining days", async () => {
    const api = await liveFixture("basic");
    await api.change(freeze("f", "2027-02-20", "2027-02-26"));
    await api.change(plan("p", "plus", "2027-02-23"));
    // Feb 15–Mar 22 = 35 calendar days, 28 active. Feb 23–Mar 22 = 27 - 4 = 23 active.
    expect(pairs(await api.invoices("2027-03-01", "2027-03-31"))).toEqual([["2027-03-22", 38219]]);
  });
  test("accepted changes are independent of arrival order", async () => {
    const changes = [freeze("a", "2027-03-01", "2027-03-16"), freeze("b", "2027-05-20", "2027-05-29"),
      plan("c", "plus", "2027-02-01"), plan("d", "basic", "2027-04-20"), plan("e", "any", "2027-06-15")];
    const forward = await liveFixture("basic");
    const reversed = await liveFixture("basic");
    for (const change of changes) await forward.change(change);
    for (const change of [...changes].reverse()) await reversed.change(change);
    expect(await forward.invoices()).toEqual(await reversed.invoices());
  });
  test("pending downgrades are not the current price and latest on wins", async () => {
    const api = await liveFixture();
    await api.change(plan("a", "basic", "2027-03-09"));
    await api.change(plan("b", "any", "2027-03-10"));
    expect(pairs(await api.invoices("2027-03-01", "2027-05-31"))).toEqual([
      ["2027-03-15", 30000], ["2027-04-15", 24900], ["2027-05-15", 24900],
    ]);
    // The later request was a downgrade against 30000, not an upgrade against pending 19995.
  });
  test("an immediate later change supersedes an older pending downgrade", async () => {
    const api = await liveFixture();
    await api.change(plan("a", "basic", "2027-03-09"));
    await api.change(plan("b", "plus", "2027-03-10"));
    expect(pairs(await api.invoices("2027-03-01", "2027-05-31"))).toEqual([
      ["2027-03-15", 30000], ["2027-04-15", 30000], ["2027-05-15", 30000],
    ]);
  });
  test("upgrade exactly on due day has no catch-up charge or joining fee", async () => {
    const api = await liveFixture("basic");
    await api.change(plan("a", "plus", "2027-02-15"));
    expect(pairs(await api.invoices("2027-02-01", "2027-03-31"))).toEqual([["2027-02-15", 30000], ["2027-03-15", 30000]]);
  });
  test("first-cycle upgrade uses unchanged first invoice cycle_days", async () => {
    const api = await liveFixture("basic", "2027-03-05", 20);
    const first = (await api.invoices())[0];
    await api.change(plan("p", "plus", "2027-03-10"));
    await api.change(freeze("f", "2027-03-12", "2027-03-18"));
    const invoices = await api.invoices("2027-03-01", "2027-04-30");
    expect(invoices[0]).toEqual(first);
    expect(pairs(invoices)).toEqual([["2027-03-05", 10712], ["2027-03-27", 33573], ["2027-04-27", 30000]]);
  });
  test("several freezes can move the same invoice and accumulate fees", async () => {
    const api = await liveFixture("basic");
    await api.change(freeze("a", "2027-01-16", "2027-01-22"));
    await api.change(freeze("b", "2027-01-23", "2027-01-29"));
    await api.change(freeze("c", "2027-02-01", "2027-02-07"));
    expect(pairs(await api.invoices("2027-02-01", "2027-04-30"))).toEqual([["2027-03-08", 24995], ["2027-04-08", 19995]]);
  });
  test("each year's earliest freeze is free, using from even across New Year", async () => {
    const api = await liveFixture("basic", "2026-12-01", 15);
    await api.change(freeze("a", "2026-12-28", "2027-01-03"));
    await api.change(freeze("b", "2027-01-04", "2027-01-10"));
    await api.change(freeze("c", "2027-02-01", "2027-02-07"));
    expect(pairs(await api.invoices("2027-01-01", "2027-03-31"))).toEqual([
      ["2027-01-29", 19995], ["2027-03-07", 22495],
    ]);
  });
  test("Bahrain subsequent freeze fee is 2000 fils with VAT", async () => {
    const api = await fixture({ country: "BH", monthly: 5000, start_date: "2027-01-01", due_day: 15 });
    const path = `/agreements/${api.agreement.id}/changes`;
    await api.request(path, freeze("a", "2027-01-02", "2027-01-08"));
    await api.request(path, freeze("b", "2027-02-01", "2027-02-07"));
    const response = await api.request(`/agreements/${api.agreement.id}/invoices?from=2027-03-01&to=2027-03-31`);
    expect(response.body[0]).toMatchObject({ due_date: "2027-03-01", net: 7000, vat: 700, total: 7700, currency: "BHD" });
  });
  test("closing is global and creation preserves existing error precedence", async () => {
    const api = await liveFixture();
    await api.close("2027-03");
    expectError(await api.request("/months/close", { month: "2027-02" }), 409, "MONTH_CLOSED");
    expectError(await api.request("/months/close", { month: "2027-03" }), 409, "MONTH_CLOSED");
    const body = { member_id: api.member.id, plan_id: api.plan.id, start_date: "2027-03-31", due_day: 1 };
    expectError(await api.request("/agreements", body), 409, "MONTH_CLOSED");
    expectError(await api.request("/agreements", { ...body, member_id: "missing" }), 422, "UNKNOWN_MEMBER");
    expectError(await api.request("/agreements", { ...body, plan_id: "missing" }), 422, "UNKNOWN_PLAN");
    expect((await api.request("/agreements", { ...body, start_date: "2027-04-01" })).status).toBe(201);
  });
  test.each([{}, { month: "2027-13" }, { month: "0000-01" }, { month: 202703 }, { month: "2027-3" }])("validates close input %#", async (body) => {
    expectError(await client().request("/months/close", body), 422, "VALIDATION");
  });
  test("closed corrections are settled once and later backdates recalculate against actuals", async () => {
    const api = await liveFixture("basic");
    const closed = await api.invoices("2027-01-01", "2027-03-31");
    await api.close("2027-03");
    await api.change(plan("a", "plus", "2027-02-15"));
    expect(await api.invoices("2027-01-01", "2027-03-31")).toEqual(closed);
    expect(pairs(await api.invoices("2027-04-01", "2027-05-31"))).toEqual([["2027-04-15", 50010], ["2027-05-15", 30000]]);
    await api.close("2027-04");
    await api.change(plan("b", "basic", "2027-03-01"));
    expect(pairs(await api.invoices("2027-05-01", "2027-06-30"))).toEqual([["2027-05-15", 0], ["2027-06-15", 19980]]);
  });
  test("reconciliation uses shifted dates and adjusted totals; old runs remain snapshots", async () => {
    const api = await liveFixture("any");
    const before = await api.request("/reconciliation/runs", { month: "2027-03", rows: [] });
    await api.change(freeze("a", "2027-03-01", "2027-03-16"));
    const result = await api.request("/reconciliation/runs", { month: "2027-03", rows: [{
      gateway_txn_id: "t", agreement_id: api.agreement.id, amount: 26145, currency: "AED", status: "SETTLED", attempted_on: "2027-03-31",
    }] });
    expect(result.body.summary.MATCHED).toBe(1);
    expect(result.body.unmatched_invoices).toEqual([]);
    expect((await api.request(`/reconciliation/runs/${before.body.id}`)).body).toEqual(before.body);
  });
  test("zero invoices remain in schedules but never enter reconciliation candidates", async () => {
    const api = await liveFixture();
    await api.close("2027-03");
    await api.change(plan("a", "basic", "2027-01-20"));
    const invoice = (await api.invoices("2027-04-01", "2027-04-30"))[0];
    expect(invoice).toMatchObject({ net: 0, vat: 0, total: 0 });
    const run = await api.request("/reconciliation/runs", { month: "2027-04", rows: [{
      gateway_txn_id: "t", agreement_id: api.agreement.id, amount: 1, currency: "AED", status: "SETTLED", attempted_on: "2027-04-15",
    }] });
    expect(run.body.summary.MISSING_FROM_LEDGER).toBe(1);
    expect(run.body.unmatched_invoices).toEqual([]);
  });
  test("real HTTP requests serialize overlap conflicts and month-close races", async () => {
    const api = await liveFixture("basic");
    api.app.listen({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${api.app.server!.port}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    try {
      const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => post(api.path, freeze(`f${i}`, "2027-04-01", "2027-04-07"))));
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      for (const response of responses.filter((r) => r.status !== 201)) expectError(response, 409, "CHANGE_CONFLICT");
      const [closing, changing] = await Promise.all([
        post("/months/close", { month: "2027-03" }),
        post(api.path, freeze("race", "2027-03-01", "2027-03-07")),
      ]);
      expect(closing.status).toBe(200);
      expect([201, 409]).toContain(changing.status);
      if (changing.status === 409) expectError(changing, 409, "MONTH_CLOSED");
      const march = await api.invoices("2027-03-01", "2027-03-31");
      expect(march[0].due_date).toBe(changing.status === 201 ? "2027-03-22" : "2027-03-15");
      const repeated = await Promise.all([post("/months/close", { month: "2027-05" }), post("/months/close", { month: "2027-05" })]);
      expect(repeated.map((r) => r.status).sort()).toEqual([200, 409]);
    } finally { await api.app.stop(true); }
  });
});
