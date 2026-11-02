// Public routes (no session): master key, sign up, login, password reset, gate PIN.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { GATE_SESSION_TTL, GATE_EVENT_MAX_FAILURES, EMAIL_RE } from "../config.js";
import { json, lockedOutResponse } from "../lib/http.js";
import { generateRandomCode, generatePin, escapeHtml } from "../lib/util.js";
import { timingSafeEqual, hashPassword, verifyPassword } from "../lib/crypto.js";
import { signSession, verifySession, passwordFingerprint, adminSession, adminSessionIsCurrent } from "../lib/session.js";
import { isLockedOut, recordFailure, clearFailures, consumeQuota } from "../lib/limits.js";
import { eventDayNow } from "../lib/eventday.js";

export async function handle(ctx) {
  const { request, env, url, origin, bearer, session, clientIp } = ctx;

  // =========================================================================
  // /api/auth-verify -> Session check, or exchange the master key for an owner session
  // =========================================================================
  if (url.pathname === "/api/auth-verify") {
    let sentToken = bearer;
    if (!sentToken && request.method === "POST") {
      try {
        const body = await request.clone().json();
        if (body && body.key) sentToken = String(body.key).trim();
      } catch (_) {}
    }

    const existing = await verifySession(env, sentToken);
    if (existing && (existing.role === "gate" || (existing.role === "admin" && await adminSessionIsCurrent(env, existing)))) {
      return json({ ok: true, role: existing.role, token: sentToken }, 200, origin);
    }

    const masterKey = env.SCANNER_ACCESS_KEY;
    const lockKey = `master:${clientIp}`;
    if (masterKey && sentToken) {
      if (await isLockedOut(env, lockKey)) return lockedOutResponse(origin);
      if (timingSafeEqual(sentToken, masterKey)) {
        await clearFailures(env, lockKey);
        const ownerId = env.OWNER_ORG_ID || "org_raghav";
        const owner = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(ownerId).first();
        if (!owner) {
          return json({ ok: false, error: `Owner organizer '${ownerId}' not found. Run seed.sql or set OWNER_ORG_ID.` }, 500, origin);
        }
        return json({ ok: true, role: "admin", token: await adminSession(env, owner) }, 200, origin);
      }
      await recordFailure(env, lockKey);
    }
    return json({ ok: false, error: "Invalid access key" }, 401, origin);
  }

  // =========================================================================
  // MULTI-TENANT ORGANIZER AUTH & EVENT APIS
  // =========================================================================

  // POST /api/auth/register -> Organizer Sign Up (with 100 Starter Credits)
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    const { email, password, company_name, accept_terms } = await request.json();
    const cleanEmail = (email || "").trim().toLowerCase().slice(0, 254);
    const company = String(company_name || "").trim().slice(0, 120) || "New Organizer";

    if (!EMAIL_RE.test(cleanEmail)) {
      return json({ ok: false, error: "Please enter a valid email address." }, 400, origin);
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      return json({ ok: false, error: "Password must be 8 to 200 characters." }, 400, origin);
    }
    if (accept_terms !== true) {
      return json({ ok: false, error: "Please accept the Terms of Service and Privacy Policy." }, 400, origin);
    }
    if (!(await consumeQuota(env, `register:${clientIp}`, 5, 3600))) {
      return json({ ok: false, error: "Too many sign-ups from this network. Try again in an hour." }, 429, origin);
    }

    const existing = await env.DB.prepare("SELECT id FROM organizers WHERE LOWER(email) = ?").bind(cleanEmail).first();
    if (existing) {
      return json({ ok: false, error: "An account with this email already exists. Please sign in." }, 400, origin);
    }

    const orgId = `org_${generateRandomCode(10).toLowerCase()}`;
    const passwordHash = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO organizers (id, email, company_name, password_hash, ticket_credits)
        VALUES (?, ?, ?, ?, 50)
      `).bind(orgId, cleanEmail, company, passwordHash),
      // Create default starter event workspace
      env.DB.prepare(`
        INSERT INTO events (id, organizer_id, title, total_days, start_date, gate_pin)
        VALUES (?, ?, 'My First Event', 1, DATE('now'), ?)
      `).bind(`evt_${Date.now()}_${generateRandomCode(4).toLowerCase()}`, orgId, generatePin())
    ]);

    return json({
      ok: true,
      token: await adminSession(env, { id: orgId, password_hash: passwordHash }),
      organizer: { id: orgId, email: cleanEmail, company_name: company, ticket_credits: 50 }
    }, 200, origin);
  }

  // POST /api/auth/login -> Organizer Login
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const { email, password } = await request.json();
    const cleanEmail = (email || "").trim().toLowerCase();
    const lockKey = `login:${cleanEmail}`;

    if (await isLockedOut(env, lockKey)) return lockedOutResponse(origin);

    const org = await env.DB.prepare("SELECT * FROM organizers WHERE LOWER(email) = ?").bind(cleanEmail).first();
    if (!org || typeof password !== "string" || !(await verifyPassword(password, org.password_hash))) {
      await recordFailure(env, lockKey);
      return json({ ok: false, error: "Invalid email or password." }, 401, origin);
    }

    await clearFailures(env, lockKey);
    if (!org.password_hash.startsWith("pbkdf2$")) {
      org.password_hash = await hashPassword(password);
      await env.DB.prepare("UPDATE organizers SET password_hash = ? WHERE id = ?").bind(org.password_hash, org.id).run();
    }

    return json({
      ok: true,
      token: await adminSession(env, org),
      organizer: { id: org.id, email: org.email, company_name: org.company_name, ticket_credits: org.ticket_credits }
    }, 200, origin);
  }

  // POST /api/auth/forgot -> Email a password reset link (always answers the same way)
  if (url.pathname === "/api/auth/forgot" && request.method === "POST") {
    const { email } = await request.json();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const generic = json({ ok: true, message: "If an account exists for that email, a reset link is on its way." }, 200, origin);
    if (!EMAIL_RE.test(cleanEmail)) return generic;
    if (!(await consumeQuota(env, `forgot:${cleanEmail}`, 3, 3600)) || !(await consumeQuota(env, `forgot-ip:${clientIp}`, 10, 3600))) {
      return generic;
    }

    const org = await env.DB.prepare("SELECT id, email, password_hash FROM organizers WHERE LOWER(email) = ?").bind(cleanEmail).first();
    if (!org || !org.password_hash || !env.RESEND_API_KEY) return generic;

    const token = await signSession(env, { role: "reset", sub: org.id, pv: await passwordFingerprint(org.password_hash) }, 30 * 60);
    const link = `${env.APP_URL || url.origin}/reset#token=${encodeURIComponent(token)}`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "TixDesk <onboarding@resend.dev>",
        to: [org.email],
        subject: "Reset your TixDesk password",
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111214">
          <h2 style="margin:0 0 12px">Reset your password</h2>
          <p style="line-height:1.5">Someone asked to reset the password for your TixDesk organizer account. The link works once and expires in 30 minutes.</p>
          <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#D4F36B;color:#111214;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Choose a new password</a></p>
          <p style="line-height:1.5;color:#5B5C56;font-size:13px">If you didn't ask for this, ignore this email. Your password stays the same.</p>
        </div>`
      })
    });
    return generic;
  }

  // POST /api/auth/reset -> Set a new password using a reset link token
  if (url.pathname === "/api/auth/reset" && request.method === "POST") {
    const { token, password } = await request.json();
    const claims = await verifySession(env, String(token || ""));
    if (!claims || claims.role !== "reset") {
      return json({ ok: false, error: "This reset link is invalid or has expired." }, 400, origin);
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      return json({ ok: false, error: "Password must be 8 to 200 characters." }, 400, origin);
    }
    const org = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(claims.sub).first();
    // The fingerprint changes once the password changes, so each link works only once
    if (!org || !org.password_hash || claims.pv !== await passwordFingerprint(org.password_hash)) {
      return json({ ok: false, error: "This reset link has already been used or has expired." }, 400, origin);
    }
    org.password_hash = await hashPassword(password);
    await env.DB.prepare("UPDATE organizers SET password_hash = ? WHERE id = ?").bind(org.password_hash, org.id).run();
    return json({ ok: true, token: await adminSession(env, org) }, 200, origin);
  }

  // POST /api/gate/auth -> Door Volunteer PIN Verification (scoped to one event)
  if (url.pathname === "/api/gate/auth" && request.method === "POST") {
    const { event_id, pin } = await request.json();
    const cleanEventId = (event_id || "").trim();
    if (!cleanEventId || !pin) {
      return json({ ok: false, error: "Event and PIN are required. Use the gate link shared by your organizer." }, 400, origin);
    }

    // Per-IP lock stops one device guessing; the looser per-event cap bounds distributed guessing
    // without letting a single attacker lock every volunteer out on event day.
    const lockKey = `gate:${cleanEventId}:${clientIp}`;
    const eventLockKey = `gate:${cleanEventId}`;
    if (await isLockedOut(env, lockKey) || await isLockedOut(env, eventLockKey, GATE_EVENT_MAX_FAILURES)) {
      return lockedOutResponse(origin);
    }

    const event = await env.DB.prepare("SELECT id, organizer_id, title, total_days, start_date, gate_pin, timezone FROM events WHERE id = ?")
      .bind(cleanEventId).first();
    if (!event || !timingSafeEqual(String(pin).trim(), String(event.gate_pin))) {
      await recordFailure(env, lockKey);
      await recordFailure(env, eventLockKey);
      return json({ ok: false, error: "Invalid Gate PIN" }, 401, origin);
    }

    await clearFailures(env, lockKey);
    const { gate_pin, organizer_id, ...publicEvent } = event;
    return json({
      ok: true,
      role: "gate",
      token: await signSession(env, { role: "gate", sub: organizer_id, evt: event.id }, GATE_SESSION_TTL),
      event: publicEvent,
      today: eventDayNow(event.start_date, event.total_days, event.timezone)
    }, 200, origin);
  }
  return null;
}
