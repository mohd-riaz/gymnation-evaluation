// Exercise the running production server: bun run tests/smoke.ts [base-url]
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
async function request(path: string, body?: unknown, expected = body === undefined ? 200 : 201) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

assert.deepEqual(await request("/health"), { status: "ok" });
const suffix = crypto.randomUUID();
const phone = `055${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
const member = await request("/members", { name: " Smoke Test ", country: "SA", phone });
assert.equal(member.name, "Smoke Test");
assert.deepEqual(await request(`/members/lookup?phone=${encodeURIComponent(member.phone)}`), member);
const plan = await request("/plans", { id: `smoke-${suffix}`, country: "SA", monthly: 29900, joining_fee: 0 });
const agreement = await request("/agreements", { member_id: member.id, plan_id: plan.id, start_date: "2026-09-20", due_day: 1 });
const invoices = await request(`/agreements/${agreement.id}/invoices?from=2026-09-01&to=2026-10-31`);
assert.equal(invoices[0].total, 12607);
assert.equal(invoices[1].total, 34385);
const run = await request("/reconciliation/runs", { month: "2026-10", rows: [
  { gateway_txn_id: suffix, agreement_id: agreement.id, amount: 34385, currency: "SAR", status: "SETTLED", attempted_on: "2026-10-01" },
] });
assert.equal(run.summary.MATCHED, 1);
assert.deepEqual(await request(`/reconciliation/runs/${run.id}`), run);
const duplicate = await request("/members", { name: "Duplicate", country: "SA", phone: member.phone }, 409);
assert.equal(duplicate.error.existing_member_id, member.id);
const invalid = await request("/plans", { id: "bad", country: "SA", monthly: "29900", joining_fee: 0 }, 422);
assert.equal(invalid.error.code, "VALIDATION");
console.log("Production HTTP smoke test passed: health, members, plans, agreements, invoices, reconciliation, and errors.");
