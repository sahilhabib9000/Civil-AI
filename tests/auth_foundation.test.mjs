import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { handleAuthRequest, getSessionUser, requirePremium } from "../worker/auth.js";

const origin = "https://civil-ai.pages.dev";
const limiter = { limit: async () => ({ success: true }) };

test("auth registration fails closed until D1 storage is configured", async () => {
  const request = new Request("https://backend.example/api/auth/register", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "engineer@example.com", password: "a-strong-password-123" })
  });
  const response = await handleAuthRequest(request, { AUTH_REGISTER_LIMITER: limiter }, origin);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /storage is not configured/);
});

test("auth registration fails closed when rate limiting is missing", async () => {
  const request = new Request("https://backend.example/api/auth/register", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "engineer@example.com", password: "a-strong-password-123" })
  });
  const response = await handleAuthRequest(request, {}, origin);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /protection is not configured/);
});

test("unknown auth routes are not silently accepted", async () => {
  const request = new Request("https://backend.example/api/auth/reset", {
    method: "POST", headers: { Origin: origin }
  });
  const response = await handleAuthRequest(request, {}, origin);
  assert.equal(response.status, 405);
});

test("session and Premium checks report unavailable storage without a configured database", async () => {
  const request = new Request("https://backend.example/api/auth/me");
  assert.equal(await getSessionUser(request, {}), null);
  const entitlement = await requirePremium(request, {});
  assert.equal(entitlement.allowed, false);
  assert.equal(entitlement.status, 503);
  assert.equal(entitlement.user, null);
});

test("migration includes unique users, hashed sessions and entitlement records", () => {
  const sql = readFileSync("migrations/0001_auth_entitlements.sql", "utf8");
  assert.match(sql, /email TEXT NOT NULL UNIQUE/);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.match(sql, /premium_entitlements/);
  assert.match(sql, /webhook_events/);
});
