import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleAuthRequest, requirePremium } from "../worker/auth.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MemoryD1 {
  users = [];
  sessions = [];
  entitlements = [];
  verificationTokens = [];
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("FROM users WHERE email")) {
          const user = db.users.find(x => x.email.toLowerCase() === String(args[0]).toLowerCase());
          if (!user) return null;
          return sql.includes("password_salt") ? { ...user } : { id:user.id, email_verified:user.email_verified };
        }
        if (sql.includes("FROM sessions s JOIN users u")) {
          const [hash, now] = args;
          const session = db.sessions.find(x => x.token_hash === hash && x.expires_at > now);
          const user = session && db.users.find(x => x.id === session.user_id && x.status === "active");
          return user ? { id:user.id, email:user.email, email_verified:user.email_verified, expires_at:session.expires_at } : null;
        }
        if (sql.includes("FROM email_verification_tokens")) {
          const [hash, now] = args;
          return db.verificationTokens.find(x => x.token_hash === hash && x.used_at === null && x.expires_at > now) || null;
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
          return {success:true};
        }
        if (sql.startsWith("UPDATE email_verification_tokens SET used_at")) {
          const [usedAt,second] = args;
          db.verificationTokens.forEach(x => {
            if ((sql.includes("user_id = ?") ? x.user_id === second : x.token_hash === second) && x.used_at === null) x.used_at = usedAt;
          });
          return {success:true};
        }
        if (sql.startsWith("INSERT INTO email_verification_tokens")) {
          const [token_hash,user_id,created_at,expires_at] = args;
          db.verificationTokens.push({token_hash,user_id,created_at,expires_at,used_at:null});
          return {success:true};
        }
        if (sql.startsWith("UPDATE users SET email_verified")) {
          const user = db.users.find(x => x.id === args[0]);
          if (user) user.email_verified = 1;
          return {success:true};
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          const [token_hash,user_id,created_at,expires_at] = args;
          db.sessions.push({token_hash,user_id,created_at,expires_at});
          return {success:true};
        }
        if (sql.startsWith("DELETE FROM sessions")) {
          db.sessions = db.sessions.filter(x => x.token_hash !== args[0]);
          return {success:true};
        }
        throw new Error("Unhandled SQL in isolated auth test: " + sql);
      }
    };
  }
}

const DB = new MemoryD1();
const limiter = { async limit() { return {success:true}; } };
const env = {
  DB,
  AUTH_REGISTER_LIMITER:limiter,
  AUTH_LOGIN_LIMITER:limiter,
  AUTH_VERIFY_LIMITER:limiter,
  RESEND_API_KEY:"test-resend-key",
  EMAIL_FROM:"CIVIL AI <verify@example.test>"
};
const origin = "https://civil-ai.pages.dev";
const base = "https://civil-ai-backend.test";
const email = "auth-e2e@example.invalid";
const password = "Strong-Test-Password-2026!";
const cookieName = "__Host-civilai_session";
let sentVerificationToken = "";
let emailSendCount = 0;

globalThis.fetch = async (_url, options) => {
  assert.match(options.headers.Authorization,/Bearer test-resend-key/);
  const body = JSON.parse(options.body);
  assert.equal(body.to[0],email);
  const match = body.html.match(/verify-email\.html\?token=([^"&]+)/);
  assert.ok(match,"verification email contains a one-time link");
  sentVerificationToken = decodeURIComponent(match[1]);
  emailSendCount++;
  return new Response(JSON.stringify({id:"test-email"}),{status:200,headers:{"Content-Type":"application/json"}});
};

async function call(path,{method="GET",body,cookie,contentType="application/json",customEnv=env}={}) {
  const headers = new Headers({Origin:origin});
  if (body !== undefined && contentType) headers.set("Content-Type",contentType);
  if (cookie) headers.set("Cookie",cookie);
  const request = new Request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return handleAuthRequest(request,customEnv,origin);
}
function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  const match = value.match(new RegExp(cookieName+"=([^;]*)"));
  assert.ok(match,"Expected session cookie");
  return cookieName+"="+match[1];
}

const invalidEmail = await call("/api/auth/register",{method:"POST",body:{email:"not-an-email",password}});
assert.equal(invalidEmail.status,400);
const weak = await call("/api/auth/register",{method:"POST",body:{email:"weak@example.invalid",password:"short"}});
assert.equal(weak.status,400);
const wrongType = await call("/api/auth/register",{method:"POST",body:{email,password},contentType:"text/plain"});
assert.equal(wrongType.status,415);

const missingMailConfig = await call("/api/auth/register",{method:"POST",body:{email,password},customEnv:{DB,AUTH_REGISTER_LIMITER:limiter}});
assert.equal(missingMailConfig.status,503,"registration fails closed without mail configuration");

const registered = await call("/api/auth/register",{method:"POST",body:{email,password}});
assert.equal(registered.status,201);
const registeredBody = await registered.json();
assert.equal(registeredBody.user.email,email);
assert.equal(registeredBody.user.email_verified,false);
assert.equal(registeredBody.premium_access,false);
assert.equal(registeredBody.verification_required,true);
assert.equal(emailSendCount,1);
const sessionCookie = cookieFrom(registered);
const cookieHeader = registered.headers.get("set-cookie") || "";
assert.match(cookieHeader,/HttpOnly/i);
assert.match(cookieHeader,/Secure/i);
assert.match(cookieHeader,/SameSite=None/i);
const firstVerificationToken = sentVerificationToken;

const resend = await call("/api/auth/resend-verification",{method:"POST",body:{email}});
assert.equal(resend.status,200);
assert.equal(emailSendCount,2);
const currentVerificationToken = sentVerificationToken;
assert.notEqual(currentVerificationToken,firstVerificationToken);

const oldToken = await call("/api/auth/verify-email",{method:"POST",body:{token:firstVerificationToken}});
assert.equal(oldToken.status,400,"resending invalidates the previous token");
const verified = await call("/api/auth/verify-email",{method:"POST",body:{token:currentVerificationToken}});
assert.equal(verified.status,200);
assert.equal((await verified.json()).verified,true);
const reused = await call("/api/auth/verify-email",{method:"POST",body:{token:currentVerificationToken}});
assert.equal(reused.status,400,"verification token is single-use");

const duplicate = await call("/api/auth/register",{method:"POST",body:{email:email.toUpperCase(),password}});
assert.equal(duplicate.status,409);
const me = await call("/api/auth/me",{cookie:sessionCookie});
const meBody = await me.json();
assert.equal(meBody.user.email_verified,true);
assert.equal(meBody.premium_access,false);

const wrongLogin = await call("/api/auth/login",{method:"POST",body:{email,password:"Wrong-Password-2026!"}});
assert.equal(wrongLogin.status,401);
const login = await call("/api/auth/login",{method:"POST",body:{email,password}});
assert.equal(login.status,200);
const loginCookie = cookieFrom(login);
const loginBody = await login.json();
assert.equal(loginBody.user.email_verified,true);
assert.equal(loginBody.premium_access,false);

const noEntitlement = await requirePremium(new Request(base+"/api/premium",{headers:{Cookie:loginCookie}}),env);
assert.equal(noEntitlement.allowed,false);
assert.equal(noEntitlement.status,403);
const user = DB.users.find(x => x.email === email);
const now = Math.floor(Date.now()/1000);
DB.entitlements.push({id:"ent-active",user_id:user.id,status:"active",starts_at:now-60,expires_at:now+3600});
const activePremium = await requirePremium(new Request(base+"/api/premium",{headers:{Cookie:loginCookie}}),env);
assert.equal(activePremium.allowed,true);
assert.equal(activePremium.status,200);
DB.entitlements[0].expires_at = now-1;
const expiredPremium = await requirePremium(new Request(base+"/api/premium",{headers:{Cookie:loginCookie}}),env);
assert.equal(expiredPremium.allowed,false);
assert.equal(expiredPremium.status,403);

const tampered = await call("/api/auth/me",{cookie:cookieName+"=tampered-token"});
assert.equal((await tampered.json()).user,null);
const logout = await call("/api/auth/logout",{method:"POST",cookie:loginCookie});
assert.equal(logout.status,200);
assert.match(logout.headers.get("set-cookie")||"",/Max-Age=0/i);
const afterLogout = await call("/api/auth/me",{cookie:loginCookie});
assert.equal((await afterLogout.json()).user,null);

const noLimiter = await call("/api/auth/login",{method:"POST",body:{email,password},customEnv:{DB}});
assert.equal(noLimiter.status,503);
const noDatabase = await call("/api/auth/me",{customEnv:{}});
assert.equal(noDatabase.status,503);

console.log("PASS: isolated authentication and email verification E2E suite");
console.log("PASS: registration, email send, resend invalidation, single-use verification, sessions, login, logout, Premium entitlement lifecycle, and fail-closed checks");
