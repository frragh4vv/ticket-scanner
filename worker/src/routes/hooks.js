// Inbound webhooks from payment providers. Public (no session), so every request is verified
// against the provider's signature over the raw body before anything is read from it.

import { json } from "../lib/http.js";
import { bytesToHex, hmac, timingSafeEqual } from "../lib/crypto.js";
import { settleCreditOrder } from "../lib/credits.js";

export async function handle(ctx) {
  const { request, env, url, origin } = ctx;

  // POST /api/hooks/razorpay -> payment.captured / order.paid credit the organizer even if the tab died
  if (url.pathname === "/api/hooks/razorpay" && request.method === "POST") {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      return json({ error: "Webhook not configured" }, 503, origin);
    }

    // The signature covers the exact bytes Razorpay sent, so read the body as text before parsing
    const raw = await request.text();
    const sig = request.headers.get("X-Razorpay-Signature") || "";
    const expected = bytesToHex(await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw));
    if (!sig || !timingSafeEqual(sig, expected)) {
      return json({ error: "Invalid signature" }, 400, origin);
    }

    let evt;
    try { evt = JSON.parse(raw); } catch (_) { return json({ error: "Bad payload" }, 400, origin); }
    if (evt.event !== "payment.captured" && evt.event !== "order.paid") {
      return json({ ok: true, ignored: evt.event || "unknown" }, 200, origin);
    }

    const payment = evt.payload?.payment?.entity;
    if (!payment || payment.status !== "captured" || !payment.order_id) {
      return json({ ok: true, ignored: "not captured" }, 200, origin);
    }

    // Always answer 200 below this point: a non-2xx makes Razorpay retry for days
    const order = await env.DB.prepare("SELECT * FROM credit_orders WHERE order_id = ?").bind(payment.order_id).first();
    if (!order) return json({ ok: true, ignored: "unknown order" }, 200, origin);

    // Amount comes from our stored order; a mismatch is logged and left uncredited for manual review
    if (Math.round(order.amount_inr * 100) !== payment.amount) {
      console.error("Razorpay amount mismatch", order.order_id, order.amount_inr, payment.amount);
      return json({ ok: true, ignored: "amount mismatch" }, 200, origin);
    }

    const credited = await settleCreditOrder(env, order, payment.id);
    const eventId = request.headers.get("X-Razorpay-Event-Id");
    if (eventId) {
      await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (source, event_id) VALUES ('razorpay', ?)").bind(eventId).run();
    }
    return json({ ok: true, credited }, 200, origin);
  }

  return null;
}
