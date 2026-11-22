const PBKDF2_ITERATIONS = 100000;
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const SESSION_COOKIE = "__Host-civilai_session";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_SECONDS = 86400;

async function sendVerificationEmail(env, email, token) {
  if (!env?.RESEND_API_KEY || !env?.EMAIL_FROM) {
    console.warn("CIVIL AI verification email skipped: Resend configuration missing", {
      hasApiKey: Boolean(env?.RESEND_API_KEY),
      hasEmailFrom: Boolean(env?.EMAIL_FROM)
    });
    return false;
  }
  const verifyUrl = `https://civil-ai.pages.dev/verify-email.html?token=${encodeURIComponent(token)}`;
  let result;
  try { result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: "Verify your CIVIL AI account",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Welcome to CIVIL AI</h2><p>Verify your email address. This one-time link expires in 24 hours.</p><p><a href="${verifyUrl}">Verify my email</a></p><p>If you did not create this account, ignore this email.</p></div>`
    })
  }); } catch (error) {
    console.error("CIVIL AI Resend request failed", {
      name: error instanceof Error ? error.name : "UnknownError"
    });
    return false;
  }
  console.log("CIVIL AI Resend provider response", {
    status: result.status,
    ok: result.ok
  });
  return result.ok;
}

async function issueVerification(db, env, userId, email) {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digestHex(token);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, userId).run();
  await db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)")
    .bind(tokenHash, userId, now, now + VERIFICATION_SECONDS).run();
  return await sendVerificationEmail(env, email, token);
}


function response(payload, status, origin, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
    ...extraHeaders
  });
  if (origin === "https://civil-ai.pages.dev") {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digestHex(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function derivePasswordHash(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g) || [], part => parseInt(part, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return bytesToHex(bits);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return sessionCookie("", 0);
}

function hasDatabase(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === "function");
}

async function rateLimit(env, bindingName, request) {
  const limiter = env?.[bindingName];
  if (!limiter || typeof limiter.limit !== "function") return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown-client";
  try {
    const result = await limiter.limit({ key: ip });
    return Boolean(result?.success);
  } catch {
    return false;
  }
}

async function createSession(db, userId) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const tokenHash = await digestHex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_SECONDS;
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, userId, now, expiresAt).run();
  return token;
}

export async function getSessionUser(request, env) {
  if (!hasDatabase(env)) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await digestHex(token);
  const now = Math.floor(Date.now() / 1000);
  return await env.DB.prepare(
    "SELECT u.id, u.email, u.email_verified, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active' LIMIT 1"
  ).bind(tokenHash, now).first();
}

async function hasActivePremiumEntitlement(db, userId) {
  const now = Math.floor(Date.now() / 1000);
  const entitlement = await db.prepare(
    "SELECT id FROM premium_entitlements WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
  ).bind(userId, now, now).first();
  return Boolean(entitlement);
}

export async function requirePremium(request, env) {
  if (!hasDatabase(env)) return { allowed: false, status: 503, user: null };
  const user = await getSessionUser(request, env);
  if (!user || Number(user.email_verified) !== 1) return { allowed: false, status: 401, user: null };
  const allowed = await hasActivePremiumEntitlement(env.DB, user.id);
  return allowed
    ? { allowed: true, status: 200, user }
    : { allowed: false, status: 403, user };
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return { error: 415 };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8192) return { error: 413 };
  try { return { body: JSON.parse(raw) }; } catch { return { error: 400 }; }
}

export async function handleAuthRequest(request, env, origin) {
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
  if (!route.startsWith("/api/auth/")) return null;

  if (route === "/api/auth/register" && method === "POST") {
    if (!await rateLimit(env, "AUTH_REGISTER_LIMITER", request)) {
      return response({ error: "Registration protection is not configured or temporarily unavailable." }, 503, origin);
    }
    if (!hasDatabase(env)) return response({ error: "Account storage is not configured yet." }, 503, origin);
    if (!env?.RESEND_API_KEY || !env?.EMAIL_FROM) return response({ error: "Email verification service is not configured." }, 503, origin);
    const parsed = await readJson(request);
    if (parsed.error) return response({ error: "Invalid registration request." }, parsed.error, origin);
    const email = typeof parsed.body?.email === "string" ? parsed.body.email.trim().toLowerCase() : "";
    const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
    if (!EMAIL_RE.test(email) || email.length > 254 || password.length < 12 || password.length > 128) {
      return response({ error: "Enter a valid email and a password of 12–128 characters." }, 400, origin);
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
    if (existing) return response({ error: "Unable to create account with those details." }, 409, origin);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = bytesToHex(salt);
    const passwordHash = await derivePasswordHash(password, saltHex);
    const userId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        "INSERT INTO users (id, email, password_salt, password_hash, email_verified, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', ?)"
      ).bind(userId, email, saltHex, passwordHash, now).run();
      const emailSent = await issueVerification(env.DB, env, userId, email);
      if (!emailSent) return response({ error: "Account created but verification email could not be sent. Use resend verification after service is restored." }, 503, origin);
      const token = await createSession(env.DB, userId);
      return response({
        user: { id: userId, email, email_verified: false },
        premium_access: false,
        verification_required: true,
        message: "Account created. Check your email to verify your account."
      }, 201, origin, { "Set-Cookie": sessionCookie(token) });
    } catch (error) {
      // Keep failed registrations from leaving an unusable account behind.
      // Never log request bodies, passwords, email addresses, or verification tokens.
      console.error("CIVIL AI registration failed:", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Unknown registration error"
      });
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
          env.DB.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").bind(userId),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
        ]);
      } catch (cleanupError) {
        console.error("CIVIL AI registration cleanup failed:", {
          name: cleanupError instanceof Error ? cleanupError.name : "UnknownError",
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error"
        });
      }
      return response({ error: "Unable to create account. Please try again." }, 500, origin);
    }
  }


  if (route === "/api/auth/verify-email" && method === "POST") {
    if (!await rateLimit(env, "AUTH_VERIFY_LIMITER", request)) {
      return response({ error: "Email verification protection is unavailable." }, 503, origin);
    }
    if (!hasDatabase(env)) return response({ error: "Account storage is not configured yet." }, 503, origin);
    const parsed = await readJson(request);
    if (parsed.error) return response({ error: "Invalid verification request." }, parsed.error, origin);
    const token = typeof parsed.body?.token === "string" ? parsed.body.token : "";
    if (token.length < 32 || token.length > 128) return response({ error: "Verification link is invalid or expired." }, 400, origin);
    const tokenHash = await digestHex(token);
    const now = Math.floor(Date.now() / 1000);
    const record = await env.DB.prepare("SELECT t.user_id FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.status = 'active' LIMIT 1").bind(tokenHash, now).first();
    if (!record) return response({ error: "Verification link is invalid or expired." }, 400, origin);
    const consumed = await env.DB.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, tokenHash, now).run();
    if (!consumed?.meta?.changes) return response({ error: "Verification link is invalid or expired." }, 400, origin);
    await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ? AND status = 'active'").bind(record.user_id).run();
    return response({ verified: true, message: "Email address verified successfully." }, 200, origin);
  }

  if (route === "/api/auth/resend-verification" && method === "POST") {
    if (!await rateLimit(env, "AUTH_VERIFY_LIMITER", request)) {
      return response({ error: "Email verification protection is unavailable." }, 503, origin);
    }
    if (!hasDatabase(env)) return response({ error: "Account storage is not configured yet." }, 503, origin);
    const parsed = await readJson(request);
    if (parsed.error) return response({ error: "Invalid request." }, parsed.error, origin);
    const email = typeof parsed.body?.email === "string" ? parsed.body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) return response({ error: "If the account exists and needs verification, an email will be sent." }, 200, origin);
    const user = await env.DB.prepare("SELECT id, email_verified FROM users WHERE email = ? AND status = 'active' LIMIT 1").bind(email).first();
    if (user && Number(user.email_verified) !== 1 && env?.RESEND_API_KEY && env?.EMAIL_FROM) {
      const emailSent = await issueVerification(env.DB, env, user.id, email);
      console.log("CIVIL AI verification resend result", {
        userFound: true,
        emailVerified: false,
        emailSent
      });
    } else {
      console.log("CIVIL AI verification resend skipped", {
        userFound: Boolean(user),
        emailVerified: user ? Number(user.email_verified) === 1 : null,
        hasApiKey: Boolean(env?.RESEND_API_KEY),
        hasEmailFrom: Boolean(env?.EMAIL_FROM)
      });
    }
    return response({ message: "If the account exists and needs verification, an email will be sent." }, 200, origin);
  }

  if (route === "/api/auth/login" && method === "POST") {
    if (!await rateLimit(env, "AUTH_LOGIN_LIMITER", request)) {
      return response({ error: "Login protection is not configured or temporarily unavailable." }, 503, origin);
    }
    if (!hasDatabase(env)) return response({ error: "Account storage is not configured yet." }, 503, origin);
    const parsed = await readJson(request);
    if (parsed.error) return response({ error: "Invalid login request." }, parsed.error, origin);
    const email = typeof parsed.body?.email === "string" ? parsed.body.email.trim().toLowerCase() : "";
    const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
    if (!EMAIL_RE.test(email) || password.length > 128 || !password) {
      return response({ error: "Email or password is incorrect." }, 401, origin);
    }
    const user = await env.DB.prepare(
      "SELECT id, email, password_salt, password_hash, email_verified FROM users WHERE email = ? AND status = 'active' LIMIT 1"
    ).bind(email).first();
    const salt = user?.password_salt || "00000000000000000000000000000000";
    const expected = user?.password_hash || "0".repeat(64);
    const actual = await derivePasswordHash(password, salt);
    if (!user || !constantTimeEqual(actual, expected)) {
      return response({ error: "Email or password is incorrect." }, 401, origin);
    }
    const token = await createSession(env.DB, user.id);
    const emailVerified = Number(user.email_verified) === 1;
    const premiumAccess = emailVerified
      ? await hasActivePremiumEntitlement(env.DB, user.id)
      : false;
    return response({
      user: { id: user.id, email: user.email, email_verified: emailVerified },
      premium_access: premiumAccess
    }, 200, origin, { "Set-Cookie": sessionCookie(token) });
  }

  if (route === "/api/auth/logout" && method === "POST") {
    if (hasDatabase(env)) {
      const token = cookieValue(request, SESSION_COOKIE);
      if (token && token.length <= 128) {
        const tokenHash = await digestHex(token);
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
      }
    }
    return response({ logged_out: true }, 200, origin, { "Set-Cookie": clearSessionCookie() });
  }

  if (route === "/api/auth/me" && method === "GET") {
    if (!hasDatabase(env)) return response({ error: "Account storage is not configured yet." }, 503, origin);
    const user = await getSessionUser(request, env);
    if (!user) return response({ user: null, premium_access: false }, 200, origin);
    const emailVerified = Number(user.email_verified) === 1;
    const premiumAccess = emailVerified
      ? await hasActivePremiumEntitlement(env.DB, user.id)
      : false;
    return response({
      user: { id: user.id, email: user.email, email_verified: emailVerified },
      premium_access: premiumAccess
    }, 200, origin);
  }

  return response({ error: "Method not allowed or auth route not found." }, 405, origin);
}
