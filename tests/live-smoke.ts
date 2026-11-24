// Printed interview examples against an EMPTY running server. This closes months globally.
// Run: bun run tests/live-smoke.ts http://127.0.0.1:8080
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
async function request(path: string, body?: unknown, expected = body === undefined ? 200 : 201) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
await request("/health");
for (const [id, monthly, joining_fee] of [["basic", 19995, 0], ["any", 24900, 9900], ["plus", 30000, 10000]]) {
  await request("/plans", { id, country: "AE", monthly, joining_fee });
}
const member = await request("/members", { name: "Live examples", country: "AE", phone: "0551234567" });
async function agreement(plan_id: string, start_date = "2027-01-15", due_day = 15): Promise<string> {
  return (await request("/agreements", { member_id: member.id, plan_id, start_date, due_day })).id;
}
async function check(id: string, from: string, to: string, expected: [string, number][]) {
  const invoices = await request(`/agreements/${id}/invoices?from=${from}&to=${to}`);
  assert.deepEqual(invoices.map((i: { due_date: string; net: number }) => [i.due_date, i.net]), expected);
}
const first = await agreement("any");
await request(`/agreements/${first}/changes`, { id: "f1", type: "FREEZE", from: "2027-03-01", to: "2027-03-16" });
await check(first, "2027-03-01", "2027-05-31", [["2027-03-31", 24900], ["2027-04-30", 24900], ["2027-05-31", 24900]]);
await request(`/agreements/${first}/changes`, { id: "f2", type: "FREEZE", from: "2027-05-20", to: "2027-05-29" });
await check(first, "2027-03-01", "2027-07-31", [["2027-03-31", 24900], ["2027-04-30", 24900], ["2027-06-10", 27400], ["2027-07-10", 24900]]);
const third = await agreement("basic", "2027-03-05", 20);
await request(`/agreements/${third}/changes`, { id: "p1", type: "PLAN", plan_id: "plus", on: "2027-04-05" });
await request(`/agreements/${third}/changes`, { id: "f1", type: "FREEZE", from: "2027-04-15", to: "2027-04-28" });
await check(third, "2027-03-01", "2027-06-30", [["2027-03-05", 10712], ["2027-03-20", 19995], ["2027-05-04", 34841], ["2027-06-04", 30000]]);
for (const day of [8, 9]) {
  const id = await agreement("plus");
  await request(`/agreements/${id}/changes`, { id: "p1", type: "PLAN", plan_id: "basic", on: `2027-03-0${day}` });
  await check(id, "2027-02-01", "2027-04-30", [["2027-02-15", 30000], ["2027-03-15", day === 8 ? 19995 : 30000], ["2027-04-15", 19995]]);
}
const sixth = await agreement("plus");
const closedBefore = await request(`/agreements/${sixth}/invoices?from=2027-01-01&to=2027-03-31`);
await request("/months/close", { month: "2027-03" }, 200);
await request(`/agreements/${sixth}/changes`, { id: "p1", type: "PLAN", plan_id: "basic", on: "2027-01-20" });
assert.deepEqual(await request(`/agreements/${sixth}/invoices?from=2027-01-01&to=2027-03-31`), closedBefore);
await check(sixth, "2027-04-01", "2027-06-30", [["2027-04-15", 0], ["2027-05-15", 19980], ["2027-06-15", 19995]]);
const run = await request("/reconciliation/runs", { month: "2027-04", rows: [] });
assert.equal(run.unmatched_invoices.some((invoice: { agreement_id: string }) => invoice.agreement_id === sixth), false);
await request(`/agreements/${first}/changes`, { id: "f1", type: "FREEZE", from: "2027-03-01", to: "2027-03-16" }, 200);
assert.equal((await request("/months/close", { month: "2027-03" }, 409)).error.code, "MONTH_CLOSED");
console.log("All six printed interview examples passed against the production HTTP API.");
