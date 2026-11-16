import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const origin = "https://civil-ai.pages.dev";
const ai = {
  run: async (model, input) => {
    assert.equal(model, "@cf/google/gemma-4-26b-a4b-it");
    assert.equal(input.messages.at(-1).role, "user");
    return { response: "Check dimensions and consult a qualified engineer." };
  }
};

test("health reports AI binding state without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/health", {
    headers: { Origin: origin }
  }), { AI: ai });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ai_enabled, true);
  assert.equal(body.model, "@cf/google/gemma-4-26b-a4b-it");
});

test("valid assistant question invokes Workers AI", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "How do I estimate concrete volume?" })
  }), { AI: ai });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.answer, /qualified engineer/);
  assert.ok(body.disclaimer);
});

test("missing AI binding returns service unavailable", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Explain concrete." })
  }), {});
  assert.equal(response.status, 503);
});

test("empty question is rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "   " })
  }), { AI: ai });
  assert.equal(response.status, 400);
});

test("oversized question is rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "x".repeat(4001) })
  }), { AI: ai });
  assert.equal(response.status, 413);
});

test("invalid JSON is rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{bad"
  }), { AI: ai });
  assert.equal(response.status, 400);
});

test("wrong content type is rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "text/plain" },
    body: "hello"
  }), { AI: ai });
  assert.equal(response.status, 415);
});

test("untrusted origin is rejected", async () => {
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Hello" })
  }), { AI: ai });
  assert.equal(response.status, 403);
});

test("AI runtime errors return a safe service error", async () => {
  const failingAI = { run: async () => { throw new Error("private provider detail"); } };
  const response = await worker.fetch(new Request("https://backend.example/api/ai/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Explain rebar." })
  }), { AI: failingAI });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private provider detail/);
});
