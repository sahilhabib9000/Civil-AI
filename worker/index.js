/**
 * CIVIL AI backend foundation.
 * API-only: this Worker never serves repository files.
 * AI, authentication and payment routes remain inactive until implemented.
 */
const ALLOWED_ORIGIN = "https://civil-ai.pages.dev";

function corsHeaders(origin) {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  return headers;
}

function jsonResponse(payload, status, origin) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(payload), { status, headers });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return new Response(null, { status: 403, headers: corsHeaders("") });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        service: "CIVIL AI Backend",
        status: "online",
        mode: "foundation",
        ai_enabled: false
      }, 200, origin);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "API route not implemented yet." }, 501, origin);
    }

    return jsonResponse({ error: "Not found." }, 404, origin);
  }
};
