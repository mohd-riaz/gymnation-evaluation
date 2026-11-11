import { describe, expect, test } from "bun:test";
import { client, expectError } from "./helpers";

describe("members and phones", () => {
  test.each([
    ["AE", "05(5) 123-4567", "+971551234567"],
    ["SA", "055 123 4567", "+966551234567"],
    ["BH", "3(123) 4567", "+97331234567"],
    ["AE", "+966551234567", "+966551234567"],
    ["SA", "97331234567", "+97331234567"],
    ["BH", "971551234567", "+971551234567"],
  ])("normalizes %s %s", async (country, phone, normalized) => {
    const { request } = client();
    const created = await request("/members", { name: " Noura ", country, phone });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: "Noura", country, phone: normalized });
    for (const spelling of [normalized, normalized.slice(1)]) {
      expect((await request(`/members/lookup?phone=${encodeURIComponent(spelling)}`)).body).toEqual(created.body);
      const duplicate = await request("/members", { name: "Someone else", country: "AE", phone: spelling });
      expectError(duplicate, 409, "PHONE_TAKEN");
      expect(duplicate.body.error.existing_member_id).toBe(created.body.id);
    }
  });

  test("national lookups need their own country; international lookup checks SIM country", async () => {
    const { request } = client();
    const member = (await request("/members", { name: "Foreign SIM", country: "AE", phone: "+966551234567" })).body;
    expect((await request("/members/lookup?phone=055%20123%204567&country=SA")).body).toEqual(member);
    expect((await request("/members/lookup?phone=%2B966551234567&country=SA")).body).toEqual(member);
    expectError(await request("/members/lookup?phone=966551234567&country=AE"), 422, "PHONE_COUNTRY_MISMATCH");
    expectError(await request("/members/lookup?phone=0551234567&country=BH"), 422, "INVALID_PHONE");
    expectError(await request("/members/lookup?phone=0551234567&country=AE"), 404, "NOT_FOUND");
    for (const phone of ["0551234567", "31234567"]) {
      expectError(await request(`/members/lookup?phone=${phone}`), 422, "PHONE_NEEDS_COUNTRY");
    }
  });

  test.each(["", "00966551234567", "+00966551234567", "++966551234567", "966+551234567", "+9660551234567", "0451234567", "+97321234567", "031234567", "551234567", "055123456", "05512345678", "055.123.4567", "055abc4567", "+965551234567", "٠٥٥١٢٣٤٥٦٧", "055\t1234567"])("rejects invalid phone %s", async (phone) => {
    const { request } = client();
    expectError(await request("/members", { name: "Noura", country: "SA", phone }), 422, "INVALID_PHONE");
    expectError(await request(`/members/lookup?phone=${encodeURIComponent(phone)}`), 422, "INVALID_PHONE");
  });

  test.each([
    {}, { name: "Noura", country: "SA" }, { name: "Noura", country: "SA", phone: 551234567 },
    { name: null, country: "SA", phone: "0551234567" }, { name: " ", country: "SA", phone: "0551234567" },
    { name: "x".repeat(121), country: "SA", phone: "0551234567" },
    { name: "Noura", country: "sa", phone: "0551234567" },
  ])("validates member body %#", async (body) => {
    expectError(await client().request("/members", body), 422, "VALIDATION");
  });

  test("trims before checking the name length", async () => {
    const response = await client().request("/members", { name: `  ${"x".repeat(120)}  `, country: "SA", phone: "0551234567" });
    expect(response.status).toBe(201);
    expect(response.body.name).toHaveLength(120);
  });

  test("concurrent HTTP writes reserve each phone exactly once", async () => {
    const { app } = client();
    app.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const responses = await Promise.all(Array.from({ length: 24 }, (_, i) => fetch(`http://127.0.0.1:${app.server!.port}/members`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Member ${i}`, country: "SA", phone: ["0551234567", "+966551234567", "966551234567"][i % 3] }),
      })));
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(23);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      const member = bodies.find((body) => body.id);
      for (const body of bodies.filter((body) => body.error)) {
        expect(body.error).toMatchObject({ code: "PHONE_TAKEN", existing_member_id: member.id });
      }
    } finally { await app.stop(true); }
  });
});
