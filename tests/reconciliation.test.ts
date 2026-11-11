import { describe, expect, test } from "bun:test";
import type { GatewayRow, Run } from "../src/models";
import { client, expectError, fixture } from "./helpers";

const row = (agreement_id: string, overrides: Partial<GatewayRow> = {}): GatewayRow => ({
  gateway_txn_id: "txn", agreement_id, amount: 34385, currency: "SAR", status: "SETTLED", attempted_on: "2026-10-01", ...overrides,
});

describe("gateway reconciliation", () => {
  test.each([-1, 0, 1])("matches total within %s minor units", async (delta) => {
    const { request, agreement } = await fixture();
    const response = await request("/reconciliation/runs", { month: "2026-10", rows: [row(agreement.id, { amount: 34385 + delta })] });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String), month: "2026-10",
      summary: { MATCHED: 1, DUE_DAY_DRIFT: 0, DOUBLE_CHARGE_RISK: 0, MISSING_FROM_LEDGER: 0, DECLINED: 0 },
      rows: [{ gateway_txn_id: "txn", verdict: "MATCHED", invoice: { agreement_id: agreement.id, invoice_no: 2 } }],
      unmatched_invoices: [],
    });
    expect((await request(`/reconciliation/runs/${response.body.id}`)).body).toEqual(response.body);
  });

  test("drift, unmatched amounts, unknown agreements, and declined rows", async () => {
    const { request, agreement } = await fixture();
    const response = await request("/reconciliation/runs", { month: "2026-10", rows: [
      row(agreement.id, { gateway_txn_id: "drift", attempted_on: "2026-10-02" }),
      row(agreement.id, { gateway_txn_id: "over", amount: 34387 }),
      row(agreement.id, { gateway_txn_id: "under", amount: 34383 }),
      row("unknown", { gateway_txn_id: "unknown", currency: "BHD" }),
      row(agreement.id, { gateway_txn_id: "declined", status: "DECLINED" }),
      row("unknown", { gateway_txn_id: "unknown-declined", status: "DECLINED" }),
    ] });
    expect(response.status).toBe(201);
    expect(response.body.summary).toEqual({ MATCHED: 0, DUE_DAY_DRIFT: 1, DOUBLE_CHARGE_RISK: 0, MISSING_FROM_LEDGER: 3, DECLINED: 2 });
    expect(response.body.rows.map((r: any) => r.verdict)).toEqual(["DUE_DAY_DRIFT", "MISSING_FROM_LEDGER", "MISSING_FROM_LEDGER", "MISSING_FROM_LEDGER", "DECLINED", "DECLINED"]);
    expect(response.body.rows.slice(1).every((r: any) => r.invoice === null)).toBe(true);
    expect(response.body.unmatched_invoices).toEqual([]);
  });

  test("all linked settled rows get double-charge risk regardless of order or due date", async () => {
    const { request, agreement } = await fixture();
    const rows = [
      row(agreement.id, { gateway_txn_id: "a", amount: 34384 }),
      row(agreement.id, { gateway_txn_id: "b", amount: 34386, attempted_on: "2026-10-03" }),
      row(agreement.id, { gateway_txn_id: "c" }),
      row(agreement.id, { gateway_txn_id: "d", status: "DECLINED" }),
    ];
    const forward: Run = (await request("/reconciliation/runs", { month: "2026-10", rows })).body;
    const backward: Run = (await request("/reconciliation/runs", { month: "2026-10", rows: [...rows].reverse() })).body;
    expect(forward.summary).toEqual({ MATCHED: 0, DUE_DAY_DRIFT: 0, DOUBLE_CHARGE_RISK: 3, MISSING_FROM_LEDGER: 0, DECLINED: 1 });
    expect(forward.rows).toEqual([...backward.rows].reverse());
    expect(forward.summary).toEqual(backward.summary);
    expect(forward.unmatched_invoices).toEqual(backward.unmatched_invoices);
    expect(forward.id).not.toBe(backward.id);
  });

  test("candidate selection chooses earliest even when a later invoice matches exactly", async () => {
    const { request, agreement } = await fixture({ country: "BH", monthly: 30, start_date: "2026-09-02", due_day: 1 });
    // A second agreement contributes two September invoices to the ledger.
    const { body: second } = await request("/agreements", { member_id: agreement.member_id, plan_id: agreement.plan_id, start_date: "2026-09-02", due_day: 3 });
    // The fee gives the first invoice total 32; the later invoice is exactly 33.
    await request("/plans", { id: "equal", country: "BH", monthly: 30, joining_fee: 28 });
    const { body: equal } = await request("/agreements", { member_id: agreement.member_id, plan_id: "equal", start_date: "2026-09-02", due_day: 3 });
    const response = await request("/reconciliation/runs", { month: "2026-09", rows: [
      row(equal.id, { gateway_txn_id: "first", amount: 33, currency: "BHD", attempted_on: "2026-09-03" }),
      row(equal.id, { gateway_txn_id: "second", amount: 32, currency: "BHD", attempted_on: "2026-09-02" }),
    ] });
    expect(response.status).toBe(201);
    expect(response.body.rows).toEqual([
      { gateway_txn_id: "first", verdict: "DOUBLE_CHARGE_RISK", invoice: { agreement_id: equal.id, invoice_no: 1 } },
      { gateway_txn_id: "second", verdict: "DOUBLE_CHARGE_RISK", invoice: { agreement_id: equal.id, invoice_no: 1 } },
    ]);
    expect(response.body.unmatched_invoices).toContainEqual({ agreement_id: equal.id, invoice_no: 2, due_date: "2026-09-03", total: 33, currency: "BHD" });
    expect(response.body.unmatched_invoices.some((invoice: any) => invoice.agreement_id === second.id)).toBe(true);
  });

  test("declined-only and empty runs leave expected invoices unmatched and sorted", async () => {
    const { request, agreement } = await fixture();
    for (const due_day of [2, 1, 15]) {
      await request("/agreements", { member_id: agreement.member_id, plan_id: agreement.plan_id, start_date: "2026-09-01", due_day });
    }
    // Future agreements must not appear in this month's expected ledger.
    await request("/agreements", { member_id: agreement.member_id, plan_id: agreement.plan_id, start_date: "2027-01-01", due_day: 1 });
    const before = (await request(`/agreements/${agreement.id}/invoices?from=2026-10-01&to=2026-10-31`)).body;
    const response = await request("/reconciliation/runs", { month: "2026-10", rows: [row(agreement.id, { status: "DECLINED" })] });
    expect(response.body.unmatched_invoices).toHaveLength(4);
    expect(response.body.rows[0]).toEqual({ gateway_txn_id: "txn", verdict: "DECLINED", invoice: null });
    const keys = response.body.unmatched_invoices.map((i: any) => `${i.due_date}/${i.agreement_id}/${i.invoice_no}`);
    expect(keys).toEqual([...keys].sort());
    const empty = await request("/reconciliation/runs", { month: "2026-10", rows: [] });
    expect(empty.body.unmatched_invoices).toEqual(response.body.unmatched_invoices);
    expect(Object.values(empty.body.summary)).toEqual([0, 0, 0, 0, 0]);
    expect((await request(`/agreements/${agreement.id}/invoices?from=2026-10-01&to=2026-10-31`)).body).toEqual(before);
    await request("/agreements", { member_id: agreement.member_id, plan_id: agreement.plan_id, start_date: "2026-10-05", due_day: 1 });
    expect((await request(`/reconciliation/runs/${empty.body.id}`)).body).toEqual(empty.body);
  });

  test("reports every offending row/code including duplicates and declined currency mismatches", async () => {
    const { request, agreement } = await fixture();
    const response = await request("/reconciliation/runs", { month: "2026-10", rows: [
      row(agreement.id, { currency: "BHD", attempted_on: "2026-09-30" }),
      row(agreement.id, { status: "DECLINED", currency: "AED", attempted_on: "2026-11-01" }),
      row("unknown", { gateway_txn_id: "unknown", currency: "BHD" }),
    ] });
    expectError(response, 422, "INVALID_ROWS");
    expect(response.body.error.errors).toHaveLength(6);
    for (const code of ["DUPLICATE_TXN", "ROW_OUTSIDE_MONTH", "CURRENCY_MISMATCH"]) {
      expect(response.body.error.errors.filter((error: any) => error.code === code)).toEqual([
        { gateway_txn_id: "txn", code }, { gateway_txn_id: "txn", code },
      ]);
    }
  });

  test.each([
    { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: "34385" }, { currency: "USD" },
    { status: "PENDING" }, { gateway_txn_id: "" }, { agreement_id: "" }, { attempted_on: "2026-02-30" },
    { attempted_on: "2026-10-01T00:00:00Z" }, { amount: null },
  ])("validates gateway row schema %#", async (override) => {
    const { request } = client();
    expectError(await request("/reconciliation/runs", { month: "2026-10", rows: [{ ...row("unknown"), ...override }] }), 422, "VALIDATION");
  });

  test.each(["2026-00", "2026-13", "2026-1", "0000-10", "2026-10-01", "not-a-month"])("validates month %s", async (month) => {
    expectError(await client().request("/reconciliation/runs", { month, rows: [] }), 422, "VALIDATION");
  });

  test("empty store and unknown run", async () => {
    const { request } = client();
    expect((await request("/reconciliation/runs", { month: "2024-02", rows: [] })).body.unmatched_invoices).toEqual([]);
    expectError(await request("/reconciliation/runs/unknown"), 404, "NOT_FOUND");
  });
});
