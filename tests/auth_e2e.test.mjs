import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleAuthRequest, requirePremium } from "../worker/auth.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MemoryD1 {
  users = [];
  sessions = [];
  entitlements = [];
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM users WHERE email")) {
          const user = db.users.find(x => x.email.toLowerCase() === String(args[0]).toLowerCase());
          if (!user) return null;
          if (sql.includes("password_salt")) return { ...user };
          return { id: user.id };
        }
        if (sql.includes("FROM sessions s JOIN users u")) {
          const [hash, now] = args;
          const session = db.sessions.find(x => x.token_hash === hash && x.expires_at > now);
          const user = session && db.users.find(x => x.id === session.user_id && x.status === "active");
          return user ? { id:user.id, email:user.email, email_verified:user.email_verified, expires_at:session.expires_at } : null;
        }
        if (sql.includes("FROM premium_entitlements")) {
          const [userId, now1, now2] = args;
          return db.entitlements.find(x => x.user_id === userId && x.status === "active" && x.starts_at <= now1 && (x.expires_at === null || x.expires_at > now2)) || null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO users")) {
          const [id,email,salt,hash,created] = args;
          if (db.users.some(x => x.email.toLowerCase() === email.toLowerCase())) throw new Error("unique");
          db.users.push({id,email,password_salt:salt,password_hash:hash,email_verified:0,status:"active",created_at:created});
          return { success:true };
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          const [token_hash,user_id,created_at,expires_at] = args;
          db.sessions.push({token_hash,user_id,created_at,expires_at});
          return { success:true };
        }
        if (sql.startsWith("DELETE FROM sessions")) {
          db.sessions = db.sessions.filter(x => x.token_hash !== args[0]);
          return { success:true };
        }
        throw new Error("Unhandled SQL in isolated auth test: " + sql);
      }
    };
  }
}

const DB = new MemoryD1();
const limiter = { async limit() { return { success:true }; } };
const env = { DB, AUTH_REGISTER_LIMITER:limiter, AUTH_LOGIN_LIMITER:limiter };
const origin = "https://civil-ai.pages.dev";
const base = "https://civil-ai-backend.test";
const email = "auth-e2e@example.invalid";
const password = "Strong-Test-Password-2026!";
const cookieName = "__Host-civilai_session";

async function call(path, {method="GET", body, cookie, contentType="application/json", includeLimiter=true}={}) {
  const headers = new Headers({ Origin:origin });
  if (body !== undefined) {
    if (contentType) headers.set("Content-Type",contentType);
  }
  if (cookie) headers.set("Cookie",cookie);
  const testEnv = includeLimiter ? env : { DB };
  const request = new Request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return handleAuthRequest(request,testEnv,origin);
}
function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  const match = value.match(new RegExp(cookieName+"=([^;]*)"));
  assert.ok(match,"Expected session cookie");
  return cookieName+"="+match[1];
}

const weak = await call("/api/auth/register",{method:"POST",body:{email:"weak@example.invalid",password:"short"}});
assert.equal(weak.status,400,"reject short passwords");

const wrongType = await call("/api/auth/register",{method:"POST",body:{email,password},contentType:"text/plain"});
assert.equal(wrongType.status,415,"reject non-JSON requests");

const registered = await call("/api/auth/register",{method:"POST",body:{email,password}});
assert.equal(registered.status,201,"registration succeeds");
const registeredBody = await registered.json();
assert.equal(registeredBody.user.email,email);
assert.equal(registeredBody.user.email_verified,false);
assert.equal(registeredBody.premium_access,false);
const sessionCookie = cookieFrom(registered);

const duplicate = await call("/api/auth/register",{method:"POST",body:{email:email.toUpperCase(),password}});
assert.equal(duplicate.status,409,"duplicate email is rejected case-insensitively");

const me = await call("/api/auth/me",{cookie:sessionCookie});
assert.equal(me.status,200);
const meBody = await me.json();
assert.equal(meBody.user.email,email,"session resolves to registered user");
assert.equal(meBody.premium_access,false,"unverified account has no Premium access");

const wrongLogin = await call("/api/auth/login",{method:"POST",body:{email,password:"Wrong-Password-2026!"}});
assert.equal(wrongLogin.status,401,"wrong password rejected");

const login = await call("/api/auth/login",{method:"POST",body:{email,password}});
assert.equal(login.status,200,"valid login succeeds");
const loginCookie = cookieFrom(login);
const loginBody = await login.json();
assert.equal(loginBody.user.email_verified,false);
assert.equal(loginBody.premium_access,false);

const premium = await requirePremium(new Request(base+"/api/premium",{headers:{Cookie:loginCookie}}),env);
assert.equal(premium.allowed,false,"unverified account cannot access Premium");
assert.equal(premium.status,401);

const logout = await call("/api/auth/logout",{method:"POST",cookie:loginCookie});
assert.equal(logout.status,200);
assert.equal((await logout.json()).logged_out,true);
const afterLogout = await call("/api/auth/me",{cookie:loginCookie});
assert.equal((await afterLogout.json()).user,null,"logout invalidates the server-side session");

const noLimiter = await call("/api/auth/login",{method:"POST",body:{email,password},includeLimiter:false});
assert.equal(noLimiter.status,503,"missing rate limiter fails closed");

const anonymous = await call("/api/auth/me");
assert.equal(anonymous.status,200);
assert.equal((await anonymous.json()).premium_access,false);

console.log("PASS: 12 isolated authentication end-to-end assertions");
console.log("PASS: registration, validation, duplicate email, session, login, bad password, logout, rate limiting, and Premium denial");
