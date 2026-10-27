// 🎟️ Cloudflare Workers API for Ticket Scanner & SaaS Platform
// Backed by Cloudflare D1 (Serverless SQLite at the Edge) with signed sessions & per-organizer scoping.

const ALLOWED_HEADERS = "Content-Type, Authorization, If-None-Match";
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

const VALID_TIERS = ["VIP", "General", "Guestlist"];
const MAX_TICKETS_PER_BATCH = 1000;
const ADMIN_SESSION_TTL = 7 * 24 * 3600;   // 7 days
const GATE_SESSION_TTL = 14 * 24 * 3600;   // covers a 10-day festival
const MAX_FAILED_ATTEMPTS = 10;            // per key, per window
const GATE_EVENT_MAX_FAILURES = 100;       // all IPs combined, per event, per window
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const PBKDF2_ITERATIONS = 100000;          // Workers' WebCrypto max

const CREDIT_PACKS = {
  starter: { credits: 500, amount: 1499 },
  pro: { credits: 2500, amount: 6250 },
  enterprise: { credits: 10000, amount: 19999 }
};

// Cross-origin callers allowed in addition to same-origin pages (comma-separated ALLOWED_ORIGINS var).
// Set once per request from env; local dev origins are always allowed.
let allowedOrigins = new Set();
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function getCorsHeaders(origin) {
  const headers = { Vary: "Origin" };
  if (origin && (allowedOrigins.has(origin) || LOCAL_ORIGIN.test(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS;
    headers["Access-Control-Allow-Headers"] = ALLOWED_HEADERS;
    headers["Access-Control-Expose-Headers"] = "ETag";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extraHeaders, ...getCorsHeaders(origin) },
  });
}

function generateRandomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Ambiguity-free charset (no 0/O, 1/I)
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

function generatePin() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0] % 900000)); // 6 digits
}

function getTierPrefix(tier) {
  const normalized = (tier || "general").toLowerCase();
  if (normalized.includes("vip")) return "VIP";
  if (normalized.includes("guest") || normalized.includes("list")) return "GST";
  return "GEN";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDays(value, totalDays) {
  if (value === "ALL") return Array.from({ length: totalDays || 1 }, (_, i) => i + 1);
  return (value || "").split(",").map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
}

// =========================================================================
// CRYPTO HELPERS (HMAC sessions, PBKDF2 passwords, constant-time compare)
// =========================================================================
const encoder = new TextEncoder();

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

function timingSafeEqual(a, b) {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) {
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

function getSessionSecret(env) {
  return env.SESSION_SECRET || env.SCANNER_ACCESS_KEY || "";
}

async function signSession(env, payload, ttlSeconds) {
  const body = bytesToB64url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = bytesToB64url(await hmac(getSessionSecret(env), body));
  return `st.${body}.${sig}`;
}

async function verifySession(env, token) {
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

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith("pbkdf2$")) {
    // Legacy plaintext rows (e.g. seed.sql) — compared once, then upgraded on successful login
    return timingSafeEqual(password, stored);
  }
  const [, iterations, saltB64, hashB64] = stored.split("$");
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64urlToBytes(saltB64), iterations: parseInt(iterations, 10) },
    key,
    256
  );
  return timingSafeEqual(bytesToB64url(new Uint8Array(bits)), hashB64);
}

// =========================================================================
// BRUTE-FORCE PROTECTION (failed attempts tracked in D1)
// =========================================================================
async function isLockedOut(env, key, limit = MAX_FAILED_ATTEMPTS) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL)"
  ).run();
  const row = await env.DB.prepare("SELECT failures, window_start FROM auth_attempts WHERE key = ?").bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  return !!row && now - row.window_start < ATTEMPT_WINDOW_SECONDS && row.failures >= limit;
}

async function recordFailure(env, key, windowSeconds = ATTEMPT_WINDOW_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO auth_attempts (key, failures, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
      window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
  `).bind(key, now, now, windowSeconds, now, windowSeconds, now).run();
}

async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
}

function lockedOutResponse(origin) {
  return json({ ok: false, error: "Too many failed attempts. Try again in 15 minutes." }, 429, origin);
}

// Fixed-window quota (sign-ups per IP, reset emails, pass emails per day). Counts every call,
// not only failures. Returns false once `limit` calls happened inside the window.
async function consumeQuota(env, key, limit, windowSeconds) {
  await isLockedOut(env, key); // ensures the table exists
  const row = await env.DB.prepare("SELECT failures, window_start FROM auth_attempts WHERE key = ?").bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  if (row && now - row.window_start < windowSeconds && row.failures >= limit) return false;
  await recordFailure(env, key, windowSeconds);
  return true;
}

// Short digest of the stored password hash. Embedded in admin sessions and reset links so a
// password change or account deletion invalidates every token issued before it.
async function passwordFingerprint(passwordHash) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(passwordHash || ""));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

async function adminSession(env, org) {
  return signSession(env, { role: "admin", sub: org.id, pv: await passwordFingerprint(org.password_hash) }, ADMIN_SESSION_TTL);
}

async function adminSessionIsCurrent(env, session) {
  const org = await env.DB.prepare("SELECT password_hash FROM organizers WHERE id = ?").bind(session.sub).first();
  return !!org && !!org.password_hash && session.pv === await passwordFingerprint(org.password_hash);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// SQL fragment restricting a tickets/scan_logs query to the organizer's own events.
// `eventId === "ALL"` means every event this organizer owns (never other organizers').
function eventScope(eventId, organizerId) {
  if (eventId === "ALL") {
    return { sql: "event_id IN (SELECT id FROM events WHERE organizer_id = ?)", params: [organizerId] };
  }
  return { sql: "event_id IN (SELECT id FROM events WHERE id = ? AND organizer_id = ?)", params: [eventId, organizerId] };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    allowedOrigins = new Set((env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: getCorsHeaders(origin),
      });
    }

    try {
      const url = new URL(request.url);

      // Serve static assets if not an /api/ route
      if (!url.pathname.startsWith("/api/")) {
        if (env.ASSETS) {
          // Note: don't set assets.not_found_handling in wrangler.toml — it makes the asset layer
          // answer browser navigations to "/", "/scan" etc. with the 404 page before this Worker runs.
          const serve = async (path) => {
            let res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));
            if (res.status === 404) {
              const page = await env.ASSETS.fetch(new Request(new URL("/404", request.url), request));
              res = new Response(page.body, { status: 404, headers: page.headers });
            }
            const out = new Response(res.body, res);
            for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
            return out;
          };
          // Smart Routing for SaaS Portal & Gate Scanner:
          // 1. '/scan', '/scanner', or a shared gate link on root ('/?pin=') -> serve scanner.html
          if (url.pathname === "/scan" || url.pathname === "/scanner" || (url.pathname === "/" && url.searchParams.has("pin"))) {
            return serve(`/scanner${url.search}`);
          }
          // 2. Root '/' -> serve /landing.html
          if (url.pathname === "/" || url.pathname === "/landing") {
            return serve("/landing");
          }
          // 3. '/admin', '/login', '/signup' -> serve admin.html (Organizer sign-in & Command Center)
          if (url.pathname === "/admin" || url.pathname === "/login" || url.pathname === "/signup") {
            const mode = url.pathname === "/signup" ? "?mode=signup" : url.search;
            return serve(`/admin${mode}`);
          }
          // 4. '/reset' -> password reset page (token travels in the URL fragment)
          if (url.pathname === "/reset") {
            return serve("/reset");
          }
          return serve(url.pathname + url.search);
        }
      }

      if (!env.DB) {
        return json({ error: "Server misconfigured", details: "D1 binding 'DB' is missing" }, 500, origin);
      }
      if (!getSessionSecret(env)) {
        return json({ error: "Server misconfigured", details: "Set SESSION_SECRET (or SCANNER_ACCESS_KEY) as a Worker secret" }, 500, origin);
      }

      const authHeader = request.headers.get("Authorization") || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
      const session = await verifySession(env, bearer);
      const clientIp = request.headers.get("CF-Connecting-IP") || "local";

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
            VALUES (?, ?, ?, ?, 100)
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
          organizer: { id: orgId, email: cleanEmail, company_name: company, ticket_credits: 100 }
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
            from: env.EMAIL_FROM || "stub <onboarding@resend.dev>",
            to: [org.email],
            subject: "Reset your stub password",
            html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111214">
              <h2 style="margin:0 0 12px">Reset your password</h2>
              <p style="line-height:1.5">Someone asked to reset the password for your stub organizer account. The link works once and expires in 30 minutes.</p>
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

        const event = await env.DB.prepare("SELECT id, organizer_id, title, total_days, start_date, gate_pin FROM events WHERE id = ?")
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
          event: publicEvent
        }, 200, origin);
      }

      // =========================================================================
      // EVERYTHING BELOW REQUIRES A VALID SESSION
      // =========================================================================
      // Only organizer and gate sessions are API sessions (reset-link tokens are not).
      // Organizer sessions also die when the password changes or the account is deleted.
      const sessionValid = session && (session.role === "gate" || (session.role === "admin" && await adminSessionIsCurrent(env, session)));
      if (!sessionValid) {
        return json({ error: "Unauthorized", details: "Missing or expired session. Please sign in again." }, 401, origin);
      }
      const organizerId = session.sub;
      const isAdmin = session.role === "admin";

      // -----------------------------------------------------------------------
      // POST /api/check -> Atomic Multi-Day Verification (admin or gate sessions)
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/check" && request.method === "POST") {
        const { ticketId, scannerName, eventDay: rawEventDay, allowReEntry } = await request.json();
        const cleanTicketId = (ticketId || "").trim();
        const eventDay = Math.max(1, Math.min(10, parseInt(rawEventDay, 10) || 1));

        if (!cleanTicketId) {
          return json({ error: "Missing ticketId" }, 400, origin);
        }

        const ticket = await env.DB.prepare(`
          SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id
          WHERE t.id = ? AND e.organizer_id = ?
        `).bind(cleanTicketId, organizerId).first();

        // Gate sessions only see tickets for their own event
        if (!ticket || (session.role === "gate" && ticket.event_id !== session.evt)) {
          return json({
            result: "notfound",
            message: "TICKET NOT FOUND\nNot in system.",
            ticket: { id: cleanTicketId }
          }, 200, origin);
        }

        if (ticket.status === "revoked") {
          return json({
            result: "invalid",
            message: "REVOKED PASS\nDo not admit attendee.",
            ticket: { id: cleanTicketId, tier: ticket.tier, attendee_name: ticket.attendee_name, status: "revoked" }
          }, 200, origin);
        }

        // Compute Allowed & Scanned Days
        const totalDays = ticket.total_days || 1;
        const allowedDays = parseDays(ticket.allowed_days || "1", totalDays);
        const scannedDaysList = parseDays(ticket.scanned_days, totalDays);
        const isAlreadyScannedToday = scannedDaysList.includes(eventDay);

        const duplicateResponse = (daysUsed) => json({
          result: "duplicate",
          message: `ALREADY SCANNED TODAY (Day ${eventDay})`,
          ticket: {
            id: cleanTicketId,
            tier: ticket.tier,
            attendee_name: ticket.attendee_name,
            email: ticket.email || "",
            status: "scanned",
            day_scanned: eventDay,
            total_days: totalDays,
            allowed_days: allowedDays,
            days_used: daysUsed
          },
          eventDay
        }, 200, origin);

        // 1. Day Authorization Check
        if (!allowedDays.includes(eventDay)) {
          return json({
            result: "wrong_day",
            message: `WRONG EVENT DAY\nTicket valid for Day(s): ${allowedDays.join(", ")}\nCurrent scanner: Day ${eventDay}`,
            ticket: {
              id: cleanTicketId,
              tier: ticket.tier,
              attendee_name: ticket.attendee_name,
              total_days: totalDays,
              allowed_days: allowedDays,
              days_used: scannedDaysList.length,
              status: ticket.status
            },
            eventDay,
            allowedDays
          }, 200, origin);
        }

        // 2. Duplicate Turnstile Prevention
        if (isAlreadyScannedToday && !allowReEntry) {
          return duplicateResponse(scannedDaysList.length);
        }

        // 3. Atomic compare-and-set: only succeeds if no other gate changed scanned_days since our read
        const isReEntry = isAlreadyScannedToday && allowReEntry;
        if (!isAlreadyScannedToday) {
          scannedDaysList.push(eventDay);
        }

        const newScannedDaysStr = scannedDaysList.sort((a, b) => a - b).join(",");
        const allUsed = allowedDays.every(d => scannedDaysList.includes(d));
        const newStatus = allUsed ? "scanned" : "valid";

        if (!isReEntry) {
          const update = await env.DB.prepare(
            "UPDATE tickets SET scanned_days = ?, status = ? WHERE id = ? AND COALESCE(scanned_days, '') = ? AND status != 'revoked'"
          ).bind(newScannedDaysStr, newStatus, cleanTicketId, ticket.scanned_days || "").run();

          if (!update.meta || update.meta.changes === 0) {
            // Another gate admitted this ticket a moment ago
            return duplicateResponse(scannedDaysList.length);
          }
        }

        await env.DB.prepare("INSERT INTO scan_logs (ticket_id, event_id, scanned_day, gate_device_id) VALUES (?, ?, ?, ?)")
          .bind(cleanTicketId, ticket.event_id, eventDay, String(scannerName || "Gate-1").slice(0, 60)).run();

        const passTypeName = totalDays > 1 ? `${totalDays}-Day Pass` : "Single Day Pass";

        return json({
          result: "valid",
          message: isReEntry
            ? `RE-ENTRY APPROVED (Day ${eventDay})`
            : allUsed
              ? `ENTRY APPROVED • DAY ${eventDay} (Final Day)`
              : `ENTRY APPROVED • DAY ${eventDay} (${scannedDaysList.length}/${allowedDays.length} Days Used)`,
          isReEntry: !!isReEntry,
          ticket: {
            id: cleanTicketId,
            tier: ticket.tier,
            attendee_name: ticket.attendee_name,
            email: ticket.email || "",
            status: newStatus,
            total_days: totalDays,
            allowed_days: allowedDays,
            days_used: scannedDaysList.length,
            pass_type_name: passTypeName
          },
          eventDay,
          daysUsed: scannedDaysList.length,
          totalDays,
          allDaysUsed: allUsed
        }, 200, origin);
      }

      // Gate volunteers can only scan — everything else is organizer-only
      if (!isAdmin) {
        return json({ error: "Forbidden", details: "Gate sessions can only scan tickets." }, 403, origin);
      }

      // GET /api/auth/me -> Current Organizer Profile & Balance
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const org = await env.DB.prepare("SELECT id, email, company_name, ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
        if (!org) return json({ ok: false, error: "Organizer not found" }, 404, origin);
        return json({ ok: true, organizer: org }, 200, origin);
      }

      // GET /api/auth/export -> Everything stored for this organizer (data portability)
      if (url.pathname === "/api/auth/export" && request.method === "GET") {
        const scope = eventScope("ALL", organizerId);
        const [org, events, tickets, scans, orders] = await Promise.all([
          env.DB.prepare("SELECT id, email, company_name, ticket_credits, created_at FROM organizers WHERE id = ?").bind(organizerId).first(),
          env.DB.prepare("SELECT id, title, total_days, start_date, gate_pin, created_at FROM events WHERE organizer_id = ?").bind(organizerId).all(),
          env.DB.prepare(`SELECT * FROM tickets WHERE ${scope.sql}`).bind(...scope.params).all(),
          env.DB.prepare(`SELECT * FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params).all(),
          env.DB.prepare("SELECT order_id, credits_purchased, amount_inr, currency, payment_id, status, created_at FROM credit_orders WHERE organizer_id = ?").bind(organizerId).all(),
        ]);
        return json({
          exported_at: new Date().toISOString(),
          organizer: org,
          events: events.results || [],
          tickets: tickets.results || [],
          scan_logs: scans.results || [],
          credit_orders: orders.results || [],
        }, 200, origin, { "Content-Disposition": 'attachment; filename="stub-account-export.json"' });
      }

      // POST /api/auth/password -> Change password (signs out every other device)
      if (url.pathname === "/api/auth/password" && request.method === "POST") {
        const { current_password, new_password } = await request.json();
        const org = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(organizerId).first();
        if (!org || typeof current_password !== "string" || !(await verifyPassword(current_password, org.password_hash))) {
          return json({ ok: false, error: "Current password is incorrect." }, 400, origin);
        }
        if (typeof new_password !== "string" || new_password.length < 8 || new_password.length > 200) {
          return json({ ok: false, error: "New password must be 8 to 200 characters." }, 400, origin);
        }
        org.password_hash = await hashPassword(new_password);
        await env.DB.prepare("UPDATE organizers SET password_hash = ? WHERE id = ?").bind(org.password_hash, org.id).run();
        return json({ ok: true, token: await adminSession(env, org) }, 200, origin);
      }

      // POST /api/auth/delete -> Delete the account: events, tickets and scan logs are erased.
      // Payment records are kept (tax law) but detached from any personal data.
      if (url.pathname === "/api/auth/delete" && request.method === "POST") {
        const { password, confirm } = await request.json();
        const org = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(organizerId).first();
        if (confirm !== "DELETE" || !org || typeof password !== "string" || !(await verifyPassword(password, org.password_hash))) {
          return json({ ok: false, error: "Type DELETE and enter your current password to confirm." }, 400, origin);
        }
        const scope = eventScope("ALL", organizerId);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
          env.DB.prepare(`DELETE FROM tickets WHERE ${scope.sql}`).bind(...scope.params),
          env.DB.prepare("DELETE FROM events WHERE organizer_id = ?").bind(organizerId),
          env.DB.prepare(`
            UPDATE organizers SET email = 'deleted+' || id || '@deleted.invalid', company_name = 'Deleted account',
              password_hash = '', ticket_credits = 0 WHERE id = ?
          `).bind(organizerId),
        ]);
        return json({ ok: true, message: "Your account and event data have been deleted." }, 200, origin);
      }

      // GET /api/events -> List Events for Organizer
      if (url.pathname === "/api/events" && request.method === "GET") {
        const events = await env.DB.prepare("SELECT * FROM events WHERE organizer_id = ? ORDER BY created_at DESC").bind(organizerId).all();
        return json({ ok: true, events: events.results || [] }, 200, origin);
      }

      // POST /api/events -> Create New Event
      if (url.pathname === "/api/events" && request.method === "POST") {
        const { title, total_days, start_date, gate_pin } = await request.json();
        const cleanTitle = (title || "").trim().slice(0, 120);
        if (!cleanTitle) return json({ ok: false, error: "Event title is required." }, 400, origin);

        const requestedPin = String(gate_pin || "").trim();
        const pin = /^\d{6,8}$/.test(requestedPin) ? requestedPin : generatePin();
        const eventId = `evt_${Date.now()}_${generateRandomCode(4).toLowerCase()}`;
        const totalDays = Math.max(1, Math.min(10, parseInt(total_days, 10) || 1));
        const startDate = /^\d{4}-\d{2}-\d{2}$/.test(start_date || "") ? start_date : new Date().toISOString().split("T")[0];

        await env.DB.prepare(`
          INSERT INTO events (id, organizer_id, title, total_days, start_date, gate_pin)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(eventId, organizerId, cleanTitle, totalDays, startDate, pin).run();

        return json({
          ok: true,
          event: { id: eventId, title: cleanTitle, total_days: totalDays, start_date: startDate, gate_pin: pin }
        }, 200, origin);
      }

      // =========================================================================
      // BILLING & CREDIT RECHARGE APIS (Razorpay)
      // Real payments need RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
      // For local testing only, DEMO_BILLING="true" skips the gateway.
      // =========================================================================
      const razorpayEnabled = !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
      const demoBilling = !razorpayEnabled && env.DEMO_BILLING === "true";

      // POST /api/billing/create-order -> Create Top-up Order
      if (url.pathname === "/api/billing/create-order" && request.method === "POST") {
        if (!razorpayEnabled && !demoBilling) {
          return json({ ok: false, error: "Payments are not configured on this server." }, 503, origin);
        }

        const { pack } = await request.json();
        const selected = CREDIT_PACKS[pack] || CREDIT_PACKS.starter;
        let orderId = `demo_${Date.now()}_${generateRandomCode(4)}`;

        if (razorpayEnabled) {
          const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`
            },
            body: JSON.stringify({
              amount: selected.amount * 100, // paise
              currency: "INR",
              receipt: `rcpt_${Date.now()}`,
              notes: { organizer_id: organizerId, credits: String(selected.credits) }
            })
          });
          if (!rpRes.ok) {
            return json({ ok: false, error: "Could not create payment order", details: await rpRes.text() }, 502, origin);
          }
          orderId = (await rpRes.json()).id;
        }

        await env.DB.prepare(`
          INSERT INTO credit_orders (order_id, organizer_id, credits_purchased, amount_inr, status)
          VALUES (?, ?, ?, ?, 'created')
        `).bind(orderId, organizerId, selected.credits, selected.amount).run();

        return json({
          ok: true,
          order_id: orderId,
          credits: selected.credits,
          amount_inr: selected.amount,
          currency: "INR",
          razorpay_key_id: razorpayEnabled ? env.RAZORPAY_KEY_ID : null,
          demo: demoBilling
        }, 200, origin);
      }

      // POST /api/billing/verify-order -> Confirm Payment & Credit Balance
      if (url.pathname === "/api/billing/verify-order" && request.method === "POST") {
        const { order_id, razorpay_payment_id, razorpay_signature } = await request.json();

        const order = await env.DB.prepare("SELECT * FROM credit_orders WHERE order_id = ? AND organizer_id = ?")
          .bind(order_id || "", organizerId).first();
        if (!order) return json({ ok: false, error: "Order not found" }, 404, origin);

        if (razorpayEnabled) {
          const expected = bytesToHex(await hmac(env.RAZORPAY_KEY_SECRET, `${order.order_id}|${razorpay_payment_id || ""}`));
          if (!razorpay_signature || !timingSafeEqual(String(razorpay_signature), expected)) {
            await env.DB.prepare("UPDATE credit_orders SET status = 'failed' WHERE order_id = ? AND status = 'created'").bind(order.order_id).run();
            return json({ ok: false, error: "Payment signature verification failed." }, 400, origin);
          }
        } else if (!demoBilling) {
          return json({ ok: false, error: "Payments are not configured on this server." }, 503, origin);
        }

        // Credit (amount comes from the stored order, never the client) and mark paid in one transaction.
        // The EXISTS guard makes replays of the same order a no-op.
        const [credit] = await env.DB.batch([
          env.DB.prepare(`
            UPDATE organizers SET ticket_credits = ticket_credits + ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM credit_orders WHERE order_id = ? AND status = 'created')
          `).bind(order.credits_purchased, organizerId, order.order_id),
          env.DB.prepare("UPDATE credit_orders SET status = 'paid', payment_id = ? WHERE order_id = ? AND status = 'created'")
            .bind(razorpay_payment_id || "demo", order.order_id)
        ]);

        const updatedOrg = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
        if (!credit.meta || credit.meta.changes === 0) {
          return json({ ok: false, error: "This order was already processed.", new_balance: updatedOrg?.ticket_credits ?? 0 }, 409, origin);
        }

        return json({
          ok: true,
          success: true,
          message: `Successfully credited ${order.credits_purchased} passes!`,
          new_balance: updatedOrg?.ticket_credits ?? 0
        }, 200, origin);
      }

      // -----------------------------------------------------------------------
      // GET /api/stats -> Aggregation with ETag (scoped to the organizer's events)
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/stats" && request.method === "GET") {
        const eventId = url.searchParams.get("event_id") || "ALL";
        const scope = eventScope(eventId, organizerId);

        const statsQuery = await env.DB.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'scanned' THEN 1 ELSE 0 END) as scanned,
            SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) as valid,
            SUM(CASE WHEN total_days > 1 THEN 1 ELSE 0 END) as multiDayCount,
            SUM(CASE WHEN tier = 'VIP' THEN 1 ELSE 0 END) as vip_total,
            SUM(CASE WHEN tier = 'VIP' AND status = 'scanned' THEN 1 ELSE 0 END) as vip_scanned,
            SUM(CASE WHEN tier = 'General' THEN 1 ELSE 0 END) as gen_total,
            SUM(CASE WHEN tier = 'General' AND status = 'scanned' THEN 1 ELSE 0 END) as gen_scanned,
            SUM(CASE WHEN tier = 'Guestlist' THEN 1 ELSE 0 END) as gst_total,
            SUM(CASE WHEN tier = 'Guestlist' AND status = 'scanned' THEN 1 ELSE 0 END) as gst_scanned
          FROM tickets
          WHERE ${scope.sql}
        `).bind(...scope.params).first();

        const scanCount = await env.DB.prepare(`SELECT COUNT(*) as n, MAX(id) as last FROM scan_logs WHERE ${scope.sql}`)
          .bind(...scope.params).first();

        const total = statsQuery?.total || 0;
        const scanned = statsQuery?.scanned || 0;
        const valid = statsQuery?.valid || 0;
        const multiDayCount = statsQuery?.multiDayCount || 0;

        // ETag includes the scan log head so day-2+ scans (which don't change status) still bust the cache
        const etag = `W/"stats-${eventId}-${total}-${scanned}-${scanCount?.n || 0}-${scanCount?.last || 0}"`;
        const rawIfNoneMatch = request.headers.get("If-None-Match") || "";
        const ifNoneMatchClean = rawIfNoneMatch.replace(/["'\sW\/]/g, "");
        const etagClean = etag.replace(/["'\sW\/]/g, "");
        const cacheHeaders = { ETag: etag, "Cache-Control": "private, max-age=10" };

        if (rawIfNoneMatch && (rawIfNoneMatch === etag || ifNoneMatchClean === etagClean)) {
          return new Response(null, { status: 304, headers: { ...cacheHeaders, ...getCorsHeaders(origin) } });
        }

        // Daily scans breakdown
        const dailyRows = await env.DB.prepare(`
          SELECT scanned_day, COUNT(*) as count
          FROM scan_logs
          WHERE ${scope.sql}
          GROUP BY scanned_day
        `).bind(...scope.params).all();

        const scansByDay = {};
        for (let d = 1; d <= 10; d++) scansByDay[`day_${d}`] = 0;
        for (const row of (dailyRows.results || [])) {
          scansByDay[`day_${row.scanned_day}`] = row.count;
        }

        // Recent 15 scans
        const recentRows = await env.DB.prepare(`
          SELECT s.ticket_id as id, t.tier, t.attendee_name, s.gate_device_id as scanned_by, s.scan_timestamp as scan_time, s.scanned_day
          FROM scan_logs s
          LEFT JOIN tickets t ON s.ticket_id = t.id
          WHERE s.${scope.sql}
          ORDER BY s.id DESC
          LIMIT 15
        `).bind(...scope.params).all();

        return json({
          total,
          scanned,
          valid,
          multiDayCount,
          scansByDay,
          tiers: {
            VIP: { total: statsQuery?.vip_total || 0, scanned: statsQuery?.vip_scanned || 0 },
            General: { total: statsQuery?.gen_total || 0, scanned: statsQuery?.gen_scanned || 0 },
            Guestlist: { total: statsQuery?.gst_total || 0, scanned: statsQuery?.gst_scanned || 0 }
          },
          recentScans: recentRows.results || []
        }, 200, origin, cacheHeaders);
      }

      // -----------------------------------------------------------------------
      // GET /api/tickets -> Server-Side Pagination & Filter
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/tickets" && request.method === "GET") {
        const eventId = url.searchParams.get("event_id") || "ALL";
        const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
        const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get("limit"), 10) || 50));
        const offset = (page - 1) * limit;
        const tier = (url.searchParams.get("tier") || "").trim();
        const status = (url.searchParams.get("status") || "").trim().toLowerCase();
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();

        const scope = eventScope(eventId, organizerId);
        let where = scope.sql;
        const params = [...scope.params];

        if (tier && tier !== "All") {
          where += " AND tier = ?";
          params.push(tier);
        }
        if (status && status !== "all") {
          where += " AND LOWER(status) = ?";
          params.push(status);
        }
        if (q) {
          where += " AND (LOWER(id) LIKE ? OR LOWER(attendee_name) LIKE ? OR LOWER(email) LIKE ?)";
          const wild = `%${q}%`;
          params.push(wild, wild, wild);
        }

        const countRes = await env.DB.prepare(`SELECT COUNT(*) as total FROM tickets WHERE ${where}`).bind(...params).first();
        const totalCount = countRes ? countRes.total : 0;

        const rows = await env.DB.prepare(`SELECT * FROM tickets WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .bind(...params, limit, offset).all();

        // Normalize format for frontend
        const ticketsList = (rows.results || []).map(t => {
          const allowedDaysArr = parseDays(t.allowed_days || "1", t.total_days);
          const scannedDaysArr = parseDays(t.scanned_days, t.total_days);
          const dailyScans = {};
          for (const d of allowedDaysArr) {
            dailyScans[`day_${d}`] = { scanned: scannedDaysArr.includes(d) };
          }

          return {
            id: t.id,
            attendee_name: t.attendee_name || "",
            email: t.email || "",
            phone: t.phone || "",
            tier: t.tier,
            total_days: t.total_days || 1,
            allowed_days: allowedDaysArr,
            scanned_days: scannedDaysArr,
            days_used: scannedDaysArr.length,
            status: t.status === "scanned" ? "Scanned" : "Valid",
            daily_scans: dailyScans,
            pass_type_name: (t.total_days || 1) > 1 ? `${t.total_days}-Day Pass` : "Single Day Pass",
            created_at: t.created_at
          };
        });

        return json({
          tickets: ticketsList,
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit) || 1
        }, 200, origin);
      }

      // -----------------------------------------------------------------------
      // POST /api/generate -> Batch Creation with Credit Wallet Deductions
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/generate" && request.method === "POST") {
        const body = await request.json();
        const batches = Array.isArray(body.batches) ? body.batches : [];

        if (batches.length === 0 && body.count) {
          batches.push({
            count: body.count,
            tier: body.tier || "General",
            total_days: body.total_days || 1,
            allowed_days: body.allowed_days || [1]
          });
        }

        const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND organizer_id = ?")
          .bind(body.event_id || "", organizerId).first();
        if (!event) {
          return json({ error: "Event not found. Select one of your events first." }, 404, origin);
        }

        let totalTicketsToMake = 0;
        for (const b of batches) {
          const count = parseInt(b.count, 10) || 0;
          if (count < 0) return json({ error: "Ticket count cannot be negative." }, 400, origin);
          if (b.tier && !VALID_TIERS.includes(b.tier)) {
            return json({ error: `Unknown tier '${b.tier}'. Use VIP, General or Guestlist.` }, 400, origin);
          }
          totalTicketsToMake += count;
        }

        if (totalTicketsToMake === 0) {
          return json({ error: "Nothing to generate." }, 400, origin);
        }
        if (totalTicketsToMake > MAX_TICKETS_PER_BATCH) {
          return json({ error: `You can generate up to ${MAX_TICKETS_PER_BATCH} tickets per batch.` }, 400, origin);
        }

        // Reserve credits first; the conditional UPDATE can never drive the balance negative
        const reserve = await env.DB.prepare(
          "UPDATE organizers SET ticket_credits = ticket_credits - ? WHERE id = ? AND ticket_credits >= ?"
        ).bind(totalTicketsToMake, organizerId, totalTicketsToMake).run();

        if (!reserve.meta || reserve.meta.changes === 0) {
          const org = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
          const currentCredits = org ? org.ticket_credits : 0;
          return json({
            error: `Insufficient Ticket Credits! You have ${currentCredits} credits, but need ${totalTicketsToMake}. Please recharge your balance to generate this batch.`,
            code: "INSUFFICIENT_CREDITS",
            current_credits: currentCredits,
            needed_credits: totalTicketsToMake
          }, 402, origin);
        }

        const insertStatements = [];
        const createdList = [];

        for (const batch of batches) {
          const count = parseInt(batch.count, 10) || 0;
          const tier = batch.tier || "General";
          const prefix = getTierPrefix(tier);
          const totalDays = Math.max(1, Math.min(10, parseInt(batch.total_days, 10) || 1));
          const allowedDaysStr = batch.allowed_days === "ALL"
            ? "ALL"
            : (Array.isArray(batch.allowed_days) ? batch.allowed_days : String(batch.allowed_days || "1").split(","))
                .map(d => parseInt(d, 10))
                .filter(d => d >= 1 && d <= totalDays)
                .join(",") || "1";

          for (let i = 0; i < count; i++) {
            const ticketId = `${prefix}-${generateRandomCode(8)}`;
            insertStatements.push(
              env.DB.prepare(`
                INSERT INTO tickets (id, event_id, attendee_name, email, phone, tier, total_days, allowed_days, scanned_days, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'valid')
              `).bind(
                ticketId,
                event.id,
                batch.attendee_name || "",
                batch.email || "",
                batch.phone || "",
                tier,
                totalDays,
                allowedDaysStr
              )
            );

            createdList.push({
              id: ticketId,
              tier,
              total_days: totalDays,
              allowed_days: allowedDaysStr,
              status: "Valid"
            });
          }
        }

        try {
          await env.DB.batch(insertStatements);
        } catch (err) {
          // Refund the reservation if the inserts failed (batch is all-or-nothing)
          await env.DB.prepare("UPDATE organizers SET ticket_credits = ticket_credits + ? WHERE id = ?")
            .bind(totalTicketsToMake, organizerId).run();
          throw err;
        }

        const org = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
        return json({
          success: true,
          count: createdList.length,
          tickets: createdList,
          remaining_credits: org ? org.ticket_credits : 0
        }, 200, origin);
      }

      // -----------------------------------------------------------------------
      // POST /api/save-attendee -> Attendee Record Update
      // -----------------------------------------------------------------------
      if ((url.pathname === "/api/save-attendee" || url.pathname === "/api/save-email") && request.method === "POST") {
        const { ticketId, attendee_name, email, phone, tier } = await request.json();
        if (!ticketId) {
          return json({ error: "Missing ticketId" }, 400, origin);
        }
        if (tier && !VALID_TIERS.includes(tier)) {
          return json({ error: `Unknown tier '${tier}'.` }, 400, origin);
        }

        const result = await env.DB.prepare(`
          UPDATE tickets
          SET attendee_name = COALESCE(?, attendee_name),
              email = COALESCE(?, email),
              phone = COALESCE(?, phone),
              tier = COALESCE(?, tier)
          WHERE id = ? AND event_id IN (SELECT id FROM events WHERE organizer_id = ?)
        `).bind(attendee_name || null, email || null, phone || null, tier || null, ticketId, organizerId).run();

        if (!result.meta || result.meta.changes === 0) {
          return json({ error: "Ticket not found" }, 404, origin);
        }
        return json({ success: true }, 200, origin);
      }

      // -----------------------------------------------------------------------
      // POST /api/reset-db -> Event Database Reset (organizer's own events only)
      // -----------------------------------------------------------------------
      if (url.pathname === "/api/reset-db" && request.method === "POST") {
        const { mode, confirm, event_id } = await request.json();

        if (confirm !== "CONFIRM_RESET") {
          return json({ error: "Safety check failed. Confirmation string 'CONFIRM_RESET' required." }, 400, origin);
        }
        if (!event_id) {
          return json({ error: "event_id is required." }, 400, origin);
        }

        const scope = eventScope(event_id, organizerId);

        if (mode === "wipe_all") {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
            env.DB.prepare(`DELETE FROM tickets WHERE ${scope.sql}`).bind(...scope.params)
          ]);
          return json({ success: true, mode: "wipe_all", message: "Database completely wiped for this event." }, 200, origin);
        } else if (mode === "reset_scans") {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
            env.DB.prepare(`UPDATE tickets SET status = 'valid', scanned_days = '' WHERE status != 'revoked' AND ${scope.sql}`).bind(...scope.params)
          ]);
          return json({ success: true, mode: "reset_scans", message: "Reset all tickets back to 'Valid' status." }, 200, origin);
        }
        return json({ error: "Unknown mode. Use 'wipe_all' or 'reset_scans'." }, 400, origin);
      }

      // =========================================================================
      // POST /api/send-email -> Dispatch Pass via Resend
      // =========================================================================
      if (url.pathname === "/api/send-email" && request.method === "POST") {
        const { ticketId, email, eventName, passImageData } = await request.json();

        const ticket = await env.DB.prepare(`
          SELECT t.*, e.title AS event_title FROM tickets t JOIN events e ON e.id = t.event_id
          WHERE t.id = ? AND e.organizer_id = ?
        `).bind(ticketId || "", organizerId).first();
        if (!ticket) {
          return json({ error: "Ticket not found" }, 404, origin);
        }

        const recipient = (email || ticket.email || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
          return json({ error: "Missing or invalid attendee email" }, 400, origin);
        }

        const ticketTier = ticket.tier || "General";
        const displayName = escapeHtml(ticket.attendee_name || "Event Guest");
        const displayEvent = escapeHtml((eventName || ticket.event_title || "Official Event Admission").slice(0, 120));
        const safeTicketId = escapeHtml(ticket.id);

        let badgeColor = "#7FE3C4";
        let tierBg = "#16302A";
        let tierLabel = "GENERAL ADMISSION";

        if (ticketTier === "VIP") {
          badgeColor = "#D4F36B";
          tierBg = "#2A3014";
          tierLabel = "👑 VIP PASS";
        } else if (ticketTier === "Guestlist") {
          badgeColor = "#C9B6FF";
          tierBg = "#2A2540";
          tierLabel = "⭐ GUESTLIST PASS";
        }

        // Rendered passes go out as a real attachment — most mail clients block data: URI images
        const attachments = [];
        const passMatch = typeof passImageData === "string" && passImageData.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
        if (passMatch && passMatch[2].length < 5_000_000) {
          attachments.push({ filename: `${ticket.id}.${passMatch[1] === "png" ? "png" : "jpg"}`, content: passMatch[2] });
        }

        const passContentHtml = `
          <div style="background: #17191C; border: 1px solid #2A2D31; border-radius: 16px; padding: 24px; margin: 20px 0; text-align: center;">
            <div style="display: inline-block; padding: 4px 14px; background: ${tierBg}; color: ${badgeColor}; border: 1px solid ${badgeColor}; border-radius: 20px; font-size: 13px; font-weight: 700; letter-spacing: 1.5px; margin-bottom: 16px;">
              ${tierLabel}
            </div>
            <div style="background: #ffffff; display: inline-block; padding: 14px; border-radius: 14px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); margin-bottom: 16px;">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(ticket.id)}" alt="Entry QR Code" width="200" height="200" style="display: block;" />
            </div>
            <div style="font-family: monospace; font-size: 20px; font-weight: 700; color: #F2EFE8; letter-spacing: 3px; margin-bottom: 8px;">
              ${safeTicketId}
            </div>
            <div style="font-size: 14px; color: #C9C7BF;">
              Attendee: <strong style="color: #F2EFE8;">${displayName}</strong>
            </div>
            ${attachments.length ? `<div style="font-size: 12px; color: #9C9B94; margin-top: 10px;">Your designed pass is attached to this email.</div>` : ""}
          </div>
        `;

        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"/></head>
          <body style="font-family: 'Bricolage Grotesque', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0F1012; color: #F2EFE8; padding: 30px 15px; margin: 0;">
            <div style="max-width: 500px; margin: 0 auto; background: #0F1012; border: 1px solid #2A2D31; border-radius: 20px; padding: 28px; box-shadow: 0 15px 30px rgba(0,0,0,0.5);">
              <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #F2EFE8; font-size: 24px; margin: 0 0 6px 0; letter-spacing: -0.5px;">${displayEvent}</h1>
                <p style="color: #9C9B94; font-size: 14px; margin: 0;">Your Official Entry Pass is Ready</p>
              </div>
              ${passContentHtml}
              <div style="background: #1B1D21; border-radius: 12px; padding: 14px; font-size: 13px; color: #C9C7BF; line-height: 1.6; border: 1px solid #2A2D31;">
                • Present this QR code at the entrance gate on your phone.<br/>
                • Single-entry verification. Do not share or duplicate this pass.<br/>
                • Gate staff will scan this QR directly from your screen.
              </div>
              <div style="text-align: center; margin-top: 24px; font-size: 11px; color: #8F8E87;">
                Secured by stub
              </div>
            </div>
          </body>
          </html>
        `;

        const resendKey = env.RESEND_API_KEY;
        if (!resendKey) {
          return json({ error: "RESEND_API_KEY is not configured", details: "Set RESEND_API_KEY in Cloudflare Worker secrets" }, 500, origin);
        }
        // Keeps a free account from turning the mail sender into a spam relay
        const dailyCap = parseInt(env.EMAIL_DAILY_CAP, 10) || 1000;
        if (!(await consumeQuota(env, `email:${organizerId}`, dailyCap, 24 * 3600))) {
          return json({ error: `Daily email limit reached (${dailyCap}). Try again tomorrow or contact support.` }, 429, origin);
        }

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resendKey}`
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM || "Tickets <onboarding@resend.dev>",
            to: [recipient],
            subject: `🎟️ Your ${ticketTier} Pass for ${(eventName || ticket.event_title || "your event").slice(0, 120)}`,
            html: emailHtml,
            ...(attachments.length ? { attachments } : {})
          })
        });

        if (!resendRes.ok) {
          const errText = await resendRes.text();
          return json({ error: "Failed to dispatch email", details: errText }, 502, origin);
        }

        return json({ success: true, message: "Email dispatched successfully" }, 200, origin);
      }

      // Fallback 404
      return json({ error: "Endpoint not found" }, 404, origin);

    } catch (err) {
      console.error(err);
      return json({ error: "Internal Server Error" }, 500, origin);
    }
  }
};
