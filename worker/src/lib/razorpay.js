// Calls to an organizer's own Razorpay account (their key, not TixDesk's). Buyer payments go straight
// to them; TixDesk only creates the order and reads the result.

import { decryptSecret } from "./secrets.js";

export const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,40}$/;

export async function razorpayFetch(keyId, keySecret, path, init = {}) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`
    }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// The organizer's decrypted credentials, or null when they have not connected Razorpay
export async function loadIntegration(env, where, value) {
  const row = await env.DB.prepare(`SELECT * FROM integrations WHERE ${where} = ?`).bind(value).first();
  if (!row) return null;
  return {
    organizerId: row.organizer_id,
    publicId: row.public_id,
    keyId: row.key_id,
    keySecret: await decryptSecret(env, row.key_secret_enc),
    webhookSecret: await decryptSecret(env, row.webhook_secret_enc)
  };
}
