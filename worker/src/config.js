// Tunable limits, prices and defaults shared by every module.

export const ALLOWED_HEADERS = "Content-Type, Authorization, If-None-Match";
export const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

export const VALID_TIERS = ["VIP", "General", "Guestlist"];
export const MAX_TICKETS_PER_BATCH = 1000;
export const ADMIN_SESSION_TTL = 7 * 24 * 3600;   // 7 days
export const GATE_SESSION_TTL = 14 * 24 * 3600;   // covers a 10-day festival
export const MAX_FAILED_ATTEMPTS = 10;            // per key, per window
export const GATE_EVENT_MAX_FAILURES = 100;       // all IPs combined, per event, per window
export const ATTEMPT_WINDOW_SECONDS = 15 * 60;
export const PBKDF2_ITERATIONS = 100000;          // Workers' WebCrypto max

export const CREDIT_PACKS = {
  starter: { credits: 500, amount: 5000 },
  pro: { credits: 2500, amount: 20000 },
  enterprise: { credits: 10000, amount: 50000 }
};

export const DEFAULT_EVENT_TZ = "Asia/Kolkata";
// The event day rolls over at 6 AM local time, so a 1 AM scan still counts toward the night it started.
export const DAY_ROLLOVER_HOUR = 6;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
