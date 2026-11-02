import { ALLOWED_HEADERS, ALLOWED_METHODS } from "../config.js";

// Response helpers: JSON responses, CORS and security headers.

// Cross-origin callers allowed in addition to same-origin pages (comma-separated ALLOWED_ORIGINS var).
// Set once per request from env; local dev origins are always allowed.
export let allowedOrigins = new Set();
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function getCorsHeaders(origin) {
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

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extraHeaders, ...getCorsHeaders(origin) },
  });
}

// Called once per request from index.js; ALLOWED_ORIGINS is the same for every request.
export function setAllowedOrigins(env) {
  allowedOrigins = new Set((env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
}

export function lockedOutResponse(origin) {
  return json({ ok: false, error: "Too many failed attempts. Try again in 15 minutes." }, 429, origin);
}
