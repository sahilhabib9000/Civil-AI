/**
 * CIVIL AI backend.
 * AI answers are informational only; never a substitute for engineering review.
 */
import { handleAuthRequest, getSessionUser } from "./auth.js";

const ALLOWED_ORIGIN = "https://civil-ai.pages.dev";
const AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUESTION_CHARS = 4000;

function corsHeaders(origin) {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function jsonResponse(payload, status, origin) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(payload), { status, headers });
}

function getAnswer(result) {
  if (typeof result?.response === "string") return result.response.trim();
  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice.trim();
  return "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Origin not allowed." }, 403, "");
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname.startsWith("/api/auth/")) {
      return await handleAuthRequest(request, env, origin);
    }

    if (url.pathname === "/api/admin/overview") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed." }, 405, origin);
      }
      const allowedAdmins = String(env?.ADMIN_EMAILS || "")
        .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!allowedAdmins.length) {
        return jsonResponse({ error: "Admin access is not configured." }, 503, origin);
      }
      const admin = await getSessionUser(request, env);
      if (!admin || Number(admin.email_verified) !== 1 ||
          !allowedAdmins.includes(String(admin.email || "").toLowerCase())) {
        return jsonResponse({ error: "Admin access denied." }, 403, origin);
      }
      try {
        const [totals, verified, premium, recent] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'active'").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'active' AND email_verified = 1").first(),
          env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS total FROM premium_entitlements WHERE status = 'active' AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)").bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).first(),
          env.DB.prepare("SELECT id, email, email_verified, status, created_at FROM users ORDER BY created_at DESC LIMIT 50").all()
        ]);
        return jsonResponse({
          admin: { email: admin.email },
          stats: {
            total_customers: Number(totals?.total || 0),
            verified_customers: Number(verified?.total || 0),
            active_premium_customers: Number(premium?.total || 0)
          },
          customers: (recent?.results || []).map(user => ({
            id: user.id,
            email: user.email,
            email_verified: Number(user.email_verified) === 1,
            status: user.status,
            created_at: user.created_at
          }))
        }, 200, origin);
      } catch (error) {
        console.error("CIVIL AI admin overview failed:", {
          name: error instanceof Error ? error.name : "UnknownError"
        });
        return jsonResponse({ error: "Could not load admin data." }, 500, origin);
      }
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        service: "CIVIL AI Backend",
        status: "online",
        mode: "ai-assistant",
        ai_enabled: Boolean(env?.AI),
        model: AI_MODEL
      }, 200, origin);
    }

    if (url.pathname === "/api/ai/ask" && request.method === "POST") {
      if (!env?.AI_ASSISTANT_LIMITER || typeof env.AI_ASSISTANT_LIMITER.limit !== "function") {
        return jsonResponse({ error: "AI request protection is not configured." }, 503, origin);
      }
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown-client";
      try {
        const rate = await env.AI_ASSISTANT_LIMITER.limit({ key: clientIp });
        if (!rate.success) {
          return jsonResponse({ error: "Too many questions. Please wait one minute and try again." }, 429, origin);
        }
      } catch {
        return jsonResponse({ error: "AI request protection is temporarily unavailable." }, 503, origin);
      }
      if (!env?.AI || typeof env.AI.run !== "function") {
        return jsonResponse({ error: "AI service is not configured yet." }, 503, origin);
      }

      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return jsonResponse({ error: "Content-Type must be application/json." }, 415, origin);
      }

      const declaredLength = Number(request.headers.get("Content-Length") || 0);
      if (declaredLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: "Request is too large." }, 413, origin);
      }

      let rawBody;
      try {
        rawBody = await request.text();
      } catch {
        return jsonResponse({ error: "Could not read request body." }, 400, origin);
      }
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: "Request is too large." }, 413, origin);
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: "Request body must be valid JSON." }, 400, origin);
      }

      const question = typeof body?.question === "string" ? body.question.trim() : "";
      if (!question) {
        return jsonResponse({ error: "Please enter a question." }, 400, origin);
      }
      if (question.length > MAX_QUESTION_CHARS) {
        return jsonResponse({ error: "Question must be 4000 characters or fewer." }, 413, origin);
      }

      const messages = [
        {
          role: "system",
          content: [
            "You are CIVIL AI, a helpful civil engineering learning and productivity assistant.",
            "Answer clearly and show units and assumptions when relevant. Ask for missing project details rather than guessing.",
            "Never fabricate standards, code clauses, material properties, site conditions, calculations, or citations.",
            "For calculations, explain the method and state that results need independent checking.",
            "Do not provide final structural design approval, certify safety, or replace a licensed/qualified engineer's review.",
            "For structural, geotechnical, seismic, fire, temporary works, or life-safety decisions, advise review by a qualified local professional.",
            "If uncertain or the question lacks essential data, say so plainly.",
            "You may answer in the language used by the user."
          ].join(" ")
        },
        { role: "user", content: question }
      ];

      try {
        const result = await env.AI.run(AI_MODEL, { messages });
        const answer = getAnswer(result);
        if (!answer) {
          return jsonResponse({ error: "AI returned an empty response. Please try again." }, 502, origin);
        }
        return jsonResponse({
          answer,
          model: AI_MODEL,
          disclaimer: "Informational assistance only. Verify calculations, standards and project decisions with a qualified engineer."
        }, 200, origin);
      } catch {
        return jsonResponse({
          error: "The AI service is temporarily unavailable. Please try again later."
        }, 503, origin);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "API route not implemented yet." }, 501, origin);
    }

    return jsonResponse({ error: "Not found." }, 404, origin);
  }
};
