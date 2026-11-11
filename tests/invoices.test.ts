import { describe, expect, test } from "bun:test";
import { invoicesFor, roundHalfUp } from "../src/invoices";
import { parseDate } from "../src/dates";
import { type Agreement, type Plan } from "../src/models";
import { client, expectError, fixture } from "./helpers";

describe("plans and invoice schedules", () => {
  test("Saudi worked example and stable numbering in filtered ranges", async () => {
    const { request, agreement, plan } = await fixture();
    expect(plan).toEqual({ id: "anytime", country: "SA", currency: "SAR", monthly: 29900, joining_fee: 0 });
    const response = await request(`/agreements/${agreement.id}/invoices?from=2026-09-01&to=2026-12-31`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { invoice_no: 1, due_date: "2026-09-20", kind: "FIRST", proration: { days: 11, cycle_days: 30 }, net: 10963, vat: 1644, total: 12607, currency: "SAR" },
      ...["2026-10-01", "2026-11-01", "2026-12-01"].map((due_date, i) => ({ invoice_no: i + 2, due_date, kind: "MONTHLY", proration: null, net: 29900, vat: 4485, total: 34385, currency: "SAR" })),
    ]);
    expect((await request(`/agreements/${agreement.id}/invoices?from=2026-11-01&to=2026-11-01`)).body).toEqual([response.body[2]]);
    expect((await request(`/agreements/${agreement.id}/invoices?from=2025-01-01&to=2025-02-01`)).body).toEqual([]);
  });

  test("UAE worked example includes joining fee in VAT and two September invoices", async () => {
    const { request, agreement } = await fixture({ country: "AE", monthly: 24900, joining_fee: 9900, start_date: "2026-09-05", due_day: 20 });
    const { body } = await request(`/agreements/${agreement.id}/invoices?from=2026-09-01&to=2026-09-30`);
    expect(body).toEqual([
      { invoice_no: 1, due_date: "2026-09-05", kind: "FIRST", proration: { days: 15, cycle_days: 31 }, net: 21948, vat: 1097, total: 23045, currency: "AED" },
      { invoice_no: 2, due_date: "2026-09-20", kind: "MONTHLY", proration: null, net: 24900, vat: 1245, total: 26145, currency: "AED" },
    ]);
  });

  test.each([
    ["2024-01-31", "2024-04-30", ["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"], 29],
    ["2025-02-28", "2025-04-30", ["2025-02-28", "2025-03-31", "2025-04-30"], 31],
    ["2026-04-30", "2026-06-30", ["2026-04-30", "2026-05-31", "2026-06-30"], 31],
    ["2026-12-31", "2027-03-31", ["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"], 31],
  ] as const)("keeps day 31 anchored from %s", async (start_date, to, dates, cycle_days) => {
    const { request, agreement } = await fixture({ start_date, due_day: 31 });
    const { body } = await request(`/agreements/${agreement.id}/invoices?from=${start_date}&to=${to}`);
    expect(body.map((invoice: any) => invoice.due_date)).toEqual([...dates]);
    expect(body[0]).toMatchObject({ proration: { days: cycle_days, cycle_days }, net: 29900 });
  });

  test("half-up proration and VAT are rounded separately", async () => {
    const { request, agreement } = await fixture({ country: "BH", monthly: 1, joining_fee: 4, start_date: "2026-04-16", due_day: 1 });
    const { body } = await request(`/agreements/${agreement.id}/invoices?from=2026-04-16&to=2026-04-16`);
    expect(body[0]).toMatchObject({ proration: { days: 15, cycle_days: 30 }, net: 5, vat: 1, total: 6, currency: "BHD" });
    expect(roundHalfUp(1n, 2n)).toBe(1n);
    expect(roundHalfUp(49n, 100n)).toBe(0n);
  });

  test("BHD VAT retains fils precision", async () => {
    const { request, agreement } = await fixture({ country: "BH", monthly: 5790, start_date: "2026-10-01" });
    const { body } = await request(`/agreements/${agreement.id}/invoices?from=2026-10-01&to=2026-10-31`);
    expect(body[0]).toMatchObject({ net: 5790, vat: 579, total: 6369, currency: "BHD" });
  });

  test.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-01", "2026-1-01", "2026-01-01T00:00:00Z"])("rejects impossible or non-date-only input %s", async (start_date) => {
    const { request, member, plan, agreement } = await fixture();
    expectError(await request("/agreements", { member_id: member.id, plan_id: plan.id, start_date, due_day: 1 }), 422, "VALIDATION");
    expectError(await request(`/agreements/${agreement.id}/invoices?from=${start_date}&to=2026-12-31`), 422, "VALIDATION");
  });

  test("range boundaries and missing query fields", async () => {
    const { request, agreement } = await fixture();
    const path = `/agreements/${agreement.id}/invoices`;
    expect((await request(`${path}?from=2026-01-01&to=2027-01-02`)).status).toBe(200);
    for (const query of ["from=2026-01-01&to=2027-01-03", "from=2026-10-01&to=2026-09-30"]) {
      expectError(await request(`${path}?${query}`), 422, "INVALID_RANGE");
    }
    for (const query of ["", "?from=2026-01-01", "?to=2026-01-01"]) expectError(await request(path + query), 422, "VALIDATION");
    expectError(await request("/agreements/missing/invoices?from=2026-01-01&to=2026-02-01"), 404, "NOT_FOUND");
  });

  test.each([0, -1, 1.5, "29900", null, true, Number.MAX_SAFE_INTEGER + 1])("rejects invalid monthly %s", async (monthly) => {
    expectError(await client().request("/plans", { id: "p", country: "SA", monthly, joining_fee: 0 }), 422, "VALIDATION");
  });
  test.each([-1, 1.5, "0", null, true])("rejects invalid joining fee %s", async (joining_fee) => {
    expectError(await client().request("/plans", { id: "p", country: "SA", monthly: 10, joining_fee }), 422, "VALIDATION");
  });
  test.each([0, 32, 1.5, "1", null])("rejects invalid due day %s", async (due_day) => {
    expectError(await client().request("/agreements", { member_id: "m", plan_id: "p", start_date: "2026-01-01", due_day }), 422, "VALIDATION");
  });

  test("foreign plans and unknown references have dedicated errors; multiple agreements are allowed", async () => {
    const { request, member, plan } = await fixture();
    const body = { member_id: member.id, plan_id: plan.id, start_date: "2026-01-01", due_day: 1 };
    expectError(await request("/agreements", { ...body, member_id: "missing" }), 422, "UNKNOWN_MEMBER");
    expectError(await request("/agreements", { ...body, plan_id: "missing" }), 422, "UNKNOWN_PLAN");
    await request("/plans", { id: "foreign", country: "AE", monthly: 10, joining_fee: 0 });
    expectError(await request("/agreements", { ...body, plan_id: "foreign" }), 422, "PLAN_COUNTRY_MISMATCH");
    const first = await request("/agreements", body);
    const second = await request("/agreements", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
  });

  test("concurrent plan creation has exactly one winner", async () => {
    const { request } = client();
    const results = await Promise.all(Array.from({ length: 20 }, () => request("/plans", { id: "p", country: "SA", monthly: 29900, joining_fee: 0 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const result of results.filter((r) => r.status !== 201)) expectError(result, 409, "PLAN_EXISTS");
  });

  test("large integer products remain exact and overflowing totals are rejected", async () => {
    const { request, agreement } = await fixture({ country: "BH", monthly: 7_000_000_000_000_001, start_date: "2026-04-16" });
    const { body } = await request(`/agreements/${agreement.id}/invoices?from=2026-04-16&to=2026-04-16`);
    expect(body[0]).toMatchObject({ net: 3_500_000_000_000_001, vat: 350_000_000_000_000, total: 3_850_000_000_000_001 });
    expectError(await request("/plans", { id: "overflow", country: "SA", monthly: Number.MAX_SAFE_INTEGER, joining_fee: 0 }), 422, "VALIDATION");
  });

  test("all due-day anchors across leap and non-leap years keep ordered schedules and stable windows", () => {
    const plan: Plan = { id: "p", country: "SA", currency: "SAR", monthly: 29900, joining_fee: 100 };
    for (const year of [2023, 2024, 2100, 2400]) {
      for (let due_day = 1; due_day <= 31; due_day++) {
        const agreement: Agreement = { id: "a", member_id: "m", plan_id: "p", start_date: `${year}-01-17`, due_day };
        const invoices = invoicesFor(agreement, plan, `${year}-01-01`, `${year}-12-31`);
        expect(invoices[0].invoice_no).toBe(1);
        for (let i = 1; i < invoices.length; i++) {
          expect(invoices[i].invoice_no).toBe(i + 1);
          expect(parseDate(invoices[i].due_date)).toBeGreaterThan(parseDate(invoices[i - 1].due_date));
          expect(invoices[i].net).toBe(plan.monthly);
        }
        expect(invoicesFor(agreement, plan, `${year}-06-01`, `${year}-09-30`)).toEqual(invoices.filter((invoice) => invoice.due_date >= `${year}-06-01` && invoice.due_date <= `${year}-09-30`));
      }
    }
  });

  test("supports early and far future dates without scanning historical invoices", () => {
    const plan: Plan = { id: "p", country: "AE", currency: "AED", monthly: 100, joining_fee: 0 };
    const agreement: Agreement = { id: "a", member_id: "m", plan_id: "p", start_date: "0001-01-01", due_day: 31 };
    expect(invoicesFor(agreement, plan, "0001-01-01", "0001-01-31")).toHaveLength(2);
    expect(invoicesFor(agreement, plan, "9999-12-01", "9999-12-31")[0].invoice_no).toBe(119989);
    expect(invoicesFor({ ...agreement, start_date: "9999-12-31" }, plan, "9999-12-31", "9999-12-31")[0].net).toBe(100);
  });
});
