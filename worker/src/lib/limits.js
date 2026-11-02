import { MAX_FAILED_ATTEMPTS, ATTEMPT_WINDOW_SECONDS } from "../config.js";

// =========================================================================
// BRUTE-FORCE PROTECTION (failed attempts tracked in D1)
// =========================================================================
export async function isLockedOut(env, key, limit = MAX_FAILED_ATTEMPTS) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL)"
  ).run();
  const row = await env.DB.prepare("SELECT failures, window_start FROM auth_attempts WHERE key = ?").bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  return !!row && now - row.window_start < ATTEMPT_WINDOW_SECONDS && row.failures >= limit;
}

export async function recordFailure(env, key, windowSeconds = ATTEMPT_WINDOW_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO auth_attempts (key, failures, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
      window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
  `).bind(key, now, now, windowSeconds, now, windowSeconds, now).run();
}

export async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
}

// Fixed-window quota (sign-ups per IP, reset emails, pass emails per day). Counts every call,
// not only failures. Returns false once `limit` calls happened inside the window.
export async function consumeQuota(env, key, limit, windowSeconds) {
  await isLockedOut(env, key); // ensures the table exists
  const row = await env.DB.prepare("SELECT failures, window_start FROM auth_attempts WHERE key = ?").bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  if (row && now - row.window_start < windowSeconds && row.failures >= limit) return false;
  await recordFailure(env, key, windowSeconds);
  return true;
}
