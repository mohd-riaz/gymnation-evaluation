import { expect } from "bun:test";
import { createApp } from "../src/app";
import type { Agreement, Country, Member, Plan } from "../src/models";

export function client() {
  const app = createApp();
  async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }));
    expect(response.headers.get("content-type")).toContain("application/json");
    return { status: response.status, body: await response.json() };
  }
  return { app, request };
}

export async function fixture(options: { country?: Country; monthly?: number; joining_fee?: number; start_date?: string; due_day?: number } = {}) {
  const api = client();
  const country = options.country ?? "SA";
  const memberResponse = await api.request("/members", { name: " Noura Al Harbi ", country, phone: country === "BH" ? "31234567" : "0551234567" });
  expect(memberResponse.status).toBe(201);
  const member: Member = memberResponse.body;
  const planResponse = await api.request("/plans", { id: "anytime", country, monthly: options.monthly ?? 29900, joining_fee: options.joining_fee ?? 0 });
  expect(planResponse.status).toBe(201);
  const plan: Plan = planResponse.body;
  const agreementResponse = await api.request("/agreements", { member_id: member.id, plan_id: plan.id, start_date: options.start_date ?? "2026-09-20", due_day: options.due_day ?? 1 });
  expect(agreementResponse.status).toBe(201);
  const agreement: Agreement = agreementResponse.body;
  return { ...api, member, plan, agreement };
}

export function expectError(response: { status: number; body: any }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  expect(typeof response.body.error.message).toBe("string");
  expect(Object.keys(response.body)).toEqual(["error"]);
}
