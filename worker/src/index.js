// 🎟️ Cloudflare Workers API for Ticket Scanner & SaaS Platform
// Backed by Cloudflare D1 (Serverless SQLite at the Edge) with signed sessions & per-organizer scoping.
//
// This file is only the front door: it serves pages, applies rate limits, checks the session and
// hands each /api/ request to the route modules in routes/. Each module's handle(ctx) returns a
// Response if it owns the path, or null so the next one can try.

import { json, getCorsHeaders, setAllowedOrigins, SECURITY_HEADERS } from "./lib/http.js";
import { getSessionSecret, verifySession, adminSessionIsCurrent } from "./lib/session.js";
import { consumeEmailBatch } from "./queue/email-consumer.js";
import * as publicAuth from "./routes/public-auth.js";
import * as hooks from "./routes/hooks.js";
import * as scan from "./routes/scan.js";
import * as account from "./routes/account.js";
import * as events from "./routes/events.js";
import * as billing from "./routes/billing.js";
import * as stats from "./routes/stats.js";
import * as tickets from "./routes/tickets.js";
import * as email from "./routes/email.js";
import * as designs from "./routes/designs.js";

// Organizer-only modules, tried in this order after the session and role checks
const ORGANIZER_ROUTES = [account, events, billing, stats, tickets, email, designs];

// Unauthenticated endpoints that check a secret (password, PIN, master key, reset token)
const AUTH_PATHS = new Set([
  "/api/auth-verify", "/api/auth/register", "/api/auth/login",
  "/api/auth/forgot", "/api/auth/reset", "/api/gate/auth"
]);

// Cloudflare Rate Limiting bindings (wrangler.toml [[ratelimits]]). A cheap first filter in front of
// the D1 lockouts: it stops floods before they cost D1 reads and writes. It is approximate by design,
// so the exact "10 failures per 15 minutes" lockout still lives in lib/limits.js.
// Missing bindings (e.g. local_dev_server.mjs) mean no limit.
async function overRateLimit(env, request, url, bearer, clientIp) {
  if (request.method === "OPTIONS") return false;
  if (AUTH_PATHS.has(url.pathname)) {
    if (!env.AUTH_LIMITER) return false;
    return !(await env.AUTH_LIMITER.limit({ key: `${clientIp}:${url.pathname}` })).success;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!env.API_LIMITER) return false;
    // Keyed by token, not IP: every gate phone at one venue can share one Wi-Fi IP
    const key = bearer ? `t:${bearer.slice(-24)}` : `ip:${clientIp}`;
    return !(await env.API_LIMITER.limit({ key })).success;
  }
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    setAllowedOrigins(env);

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
      const clientIp = request.headers.get("CF-Connecting-IP") || "local";

      if (await overRateLimit(env, request, url, bearer, clientIp)) {
        return json({ error: "Too many requests. Slow down and try again in a minute." }, 429, origin);
      }

      const session = await verifySession(env, bearer);
      const ctx = { request, env, url, origin, bearer, session, clientIp };

      // Provider webhooks (signature-verified inside, no session)
      const hookRes = await hooks.handle(ctx);
      if (hookRes) return hookRes;

      // Public endpoints (sign up, login, reset, gate PIN, master key)
      const publicRes = await publicAuth.handle(ctx);
      if (publicRes) return publicRes;

      // =========================================================================
      // EVERYTHING BELOW REQUIRES A VALID SESSION
      // =========================================================================
      // Only organizer and gate sessions are API sessions (reset-link tokens are not).
      // Organizer sessions also die when the password changes or the account is deleted.
      const sessionValid = session && (session.role === "gate" || (session.role === "admin" && await adminSessionIsCurrent(env, session)));
      if (!sessionValid) {
        return json({ error: "Unauthorized", details: "Missing or expired session. Please sign in again." }, 401, origin);
      }
      ctx.organizerId = session.sub;
      ctx.isAdmin = session.role === "admin";

      const scanRes = await scan.handle(ctx);
      if (scanRes) return scanRes;

      // Gate volunteers can only scan — everything else is organizer-only
      if (!ctx.isAdmin) {
        return json({ error: "Forbidden", details: "Gate sessions can only scan tickets." }, 403, origin);
      }

      for (const route of ORGANIZER_ROUTES) {
        const res = await route.handle(ctx);
        if (res) return res;
      }

      // Fallback 404
      return json({ error: "Endpoint not found" }, 404, origin);

    } catch (err) {
      console.error(err);
      return json({ error: "Internal Server Error" }, 500, origin);
    }
  },

  // Background jobs from Cloudflare Queues (wrangler.toml [[queues.consumers]])
  async queue(batch, env) {
    if (batch.queue.startsWith("tixdesk-email")) return consumeEmailBatch(batch, env);
    console.warn("Unknown queue", batch.queue);
  }
};
