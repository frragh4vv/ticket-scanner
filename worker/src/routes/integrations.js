// Connect the organizer's own Razorpay account. The key secret is stored AES-GCM encrypted and is never
// sent back to the browser. The webhook is optional (off by default): payments the browser misses are
// found by the server-side check in lib/reconcile.js. A webhook secret is stored from the start so the
// webhook URL works the moment an organizer opts in, but it is only shown via /webhook-secret.

import { json } from "../lib/http.js";
import { generateRandomCode } from "../lib/util.js";
import { encryptSecret } from "../lib/secrets.js";
import { KEY_ID_RE, razorpayFetch } from "../lib/razorpay.js";

function webhookUrl(url, publicId) {
  return `${url.origin}/api/hooks/razorpay/org/${publicId}`;
}

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;
  if (!url.pathname.startsWith("/api/integrations")) return null;

  if (!env.INTEGRATIONS_KEY) {
    return json({ error: "Integrations are not enabled on this server yet (INTEGRATIONS_KEY is missing)." }, 503, origin);
  }

  const row = await env.DB.prepare("SELECT public_id, key_id, created_at FROM integrations WHERE organizer_id = ?").bind(organizerId).first();

  // GET /api/integrations -> connection state (never the secret)
  if (url.pathname === "/api/integrations" && request.method === "GET") {
    if (!row) return json({ ok: true, connected: false }, 200, origin);
    return json({
      ok: true, connected: true, key_id: row.key_id,
      mode: row.key_id.startsWith("rzp_live_") ? "live" : "test",
      webhook_url: webhookUrl(url, row.public_id)
    }, 200, origin);
  }

  // PUT /api/integrations { key_id, key_secret } -> verify with Razorpay, then store
  if (url.pathname === "/api/integrations" && request.method === "PUT") {
    const { key_id, key_secret } = await request.json();
    const keyId = String(key_id || "").trim();
    const keySecret = String(key_secret || "").trim();
    if (!KEY_ID_RE.test(keyId) || keySecret.length < 10 || keySecret.length > 80) {
      return json({ error: "Enter the Key ID (rzp_test_… or rzp_live_…) and its Key Secret from the Razorpay dashboard." }, 400, origin);
    }
    const check = await razorpayFetch(keyId, keySecret, "/orders?count=1");
    if (!check.ok) {
      return json({ error: "Razorpay rejected these keys. Check that both were copied from the same key pair and mode." }, 400, origin);
    }

    const secretEnc = await encryptSecret(env, keySecret);
    if (row) {
      await env.DB.prepare("UPDATE integrations SET key_id = ?, key_secret_enc = ? WHERE organizer_id = ?").bind(keyId, secretEnc, organizerId).run();
    } else {
      const webhookSecret = generateRandomCode(32);
      await env.DB.prepare(
        "INSERT INTO integrations (organizer_id, public_id, key_id, key_secret_enc, webhook_secret_enc) VALUES (?, ?, ?, ?, ?)"
      ).bind(organizerId, generateRandomCode(16).toLowerCase(), keyId, secretEnc, await encryptSecret(env, webhookSecret)).run();
    }
    const saved = await env.DB.prepare("SELECT public_id FROM integrations WHERE organizer_id = ?").bind(organizerId).first();
    return json({
      ok: true, connected: true, key_id: keyId,
      mode: keyId.startsWith("rzp_live_") ? "live" : "test",
      webhook_url: webhookUrl(url, saved.public_id)
    }, 200, origin);
  }

  // POST /api/integrations/webhook-secret -> opt in to the webhook: new secret, shown once
  if (url.pathname === "/api/integrations/webhook-secret" && request.method === "POST") {
    if (!row) return json({ error: "Connect Razorpay first." }, 409, origin);
    const webhookSecret = generateRandomCode(32);
    await env.DB.prepare("UPDATE integrations SET webhook_secret_enc = ? WHERE organizer_id = ?")
      .bind(await encryptSecret(env, webhookSecret), organizerId).run();
    return json({ ok: true, webhook_url: webhookUrl(url, row.public_id), webhook_secret: webhookSecret }, 200, origin);
  }

  // DELETE /api/integrations -> disconnect
  if (url.pathname === "/api/integrations" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM integrations WHERE organizer_id = ?").bind(organizerId).run();
    return json({ ok: true }, 200, origin);
  }

  return null;
}
