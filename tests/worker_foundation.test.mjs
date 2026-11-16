import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

test("health endpoint reports backend foundation without claiming AI is active", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/health", {
    headers: { Origin: "https://civil-ai.pages.dev" }
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://civil-ai.pages.dev");
  const body = await response.json();
  assert.equal(body.service, "CIVIL AI Backend");
  assert.equal(body.status, "online");
  assert.equal(body.ai_enabled, false);
});

test("unknown API routes are not silently accepted", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/unknown"));
  assert.equal(response.status, 501);
});

test("untrusted browser origins do not receive CORS permission", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/health", {
    headers: { Origin: "https://attacker.example" }
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("untrusted preflight requests are rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/health", {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example" }
  }));
  assert.equal(response.status, 403);
});
