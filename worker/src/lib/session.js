import { ADMIN_SESSION_TTL } from "../config.js";
import { encoder, bytesToB64url, b64urlToBytes, bytesToHex, hmac, timingSafeEqual } from "./crypto.js";

// Signed session tokens: st.<base64url JSON payload>.<base64url HMAC-SHA256>.

export function getSessionSecret(env) {
  return env.SESSION_SECRET || env.SCANNER_ACCESS_KEY || "";
}

export async function signSession(env, payload, ttlSeconds) {
  const body = bytesToB64url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = bytesToB64url(await hmac(getSessionSecret(env), body));
  return `st.${body}.${sig}`;
}

export async function verifySession(env, token) {
  if (!token || !token.startsWith("st.")) return null;
  const [, body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = bytesToB64url(await hmac(getSessionSecret(env), body));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// Short digest of the stored password hash. Embedded in admin sessions and reset links so a
// password change or account deletion invalidates every token issued before it.
export async function passwordFingerprint(passwordHash) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(passwordHash || ""));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

export async function adminSession(env, org) {
  return signSession(env, { role: "admin", sub: org.id, pv: await passwordFingerprint(org.password_hash) }, ADMIN_SESSION_TTL);
}

export async function adminSessionIsCurrent(env, session) {
  const org = await env.DB.prepare("SELECT password_hash FROM organizers WHERE id = ?").bind(session.sub).first();
  return !!org && !!org.password_hash && session.pv === await passwordFingerprint(org.password_hash);
}
