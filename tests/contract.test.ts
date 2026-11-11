import { expect, test } from "bun:test";
import { client, expectError } from "./helpers";

test("health and missing routes return JSON", async () => {
  const { request } = client();
  expect(await request("/health")).toEqual({ status: 200, body: { status: "ok" } });
  expectError(await request("/unknown"), 404, "NOT_FOUND");
  expectError(await request("/members/lookup"), 422, "VALIDATION");
  expectError(await request("/members/lookup?phone=0551234567&country=US"), 422, "VALIDATION");
});

test.each(["/members", "/plans", "/agreements", "/reconciliation/runs"])("%s rejects malformed JSON, missing bodies, and wrong body types", async (path) => {
  const { app, request } = client();
  for (const raw of ["{", "", "{\"name\":"] ) {
    const response = await app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw }));
    expectError({ status: response.status, body: await response.json() }, 422, "VALIDATION");
  }
  for (const body of [{}, null, [], "string", 1]) expectError(await request(path, body), 422, "VALIDATION");
});

test("unexpected fields cannot override generated identifiers", async () => {
  const { request } = client();
  expectError(await request("/members", { id: "injected", name: "Noura", country: "SA", phone: "0551234567" }), 422, "VALIDATION");
});

test("new application instances always start empty", async () => {
  const first = client();
  await first.request("/members", { name: "Noura", country: "SA", phone: "0551234567" });
  expectError(await client().request("/members/lookup?phone=966551234567"), 404, "NOT_FOUND");
});
