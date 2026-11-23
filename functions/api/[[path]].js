// Same-origin Pages Function proxy for the CIVIL AI backend.
// This keeps the session cookie on civil-ai.pages.dev instead of relying on
// a third-party workers.dev cookie, which browsers may block.
const BACKEND = "https://civil-ai-backend.sahilhabib9000.workers.dev";

export async function onRequest(context) {
  const incoming = context.request;
  const sourceUrl = new URL(incoming.url);
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, BACKEND);
  const headers = new Headers(incoming.headers);
  headers.delete("host");
  const init = {
    method: incoming.method,
    headers,
    redirect: "manual"
  };
  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    init.body = incoming.body;
  }
  return fetch(new Request(targetUrl.toString(), init));
}
