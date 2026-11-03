// Inbound webhooks from payment providers. Public (no session), so every request is verified
// against the provider's signature over the raw body before anything is read from it.

import { json } from "../lib/http.js";
import { bytesToHex, hmac, timingSafeEqual } from "../lib/crypto.js";
import { settleCreditOrder } from "../lib/credits.js";
import { fulfillOrder, unreserve } from "../lib/orders.js";
import { loadIntegration } from "../lib/razorpay.js";

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

  // POST /api/hooks/razorpay/org/<public_id> -> an organizer's own Razorpay account reporting a buyer payment.
  // Signed with that organizer's webhook secret, so one organizer can never settle another's orders.
  const orgMatch = url.pathname.match(/^\/api\/hooks\/razorpay\/org\/([a-z0-9]+)$/);
  if (orgMatch && request.method === "POST") {
    const integration = env.INTEGRATIONS_KEY ? await loadIntegration(env, "public_id", orgMatch[1]) : null;
    if (!integration) return json({ error: "Webhook not configured" }, 404, origin);

    const raw = await request.text();
    const sig = request.headers.get("X-Razorpay-Signature") || "";
    const expected = bytesToHex(await hmac(integration.webhookSecret, raw));
    if (!sig || !timingSafeEqual(sig, expected)) return json({ error: "Invalid signature" }, 400, origin);

    let evt;
    try { evt = JSON.parse(raw); } catch (_) { return json({ error: "Bad payload" }, 400, origin); }
    const payment = evt.payload?.payment?.entity;
    if ((evt.event !== "payment.captured" && evt.event !== "order.paid") || !payment || payment.status !== "captured" || !payment.order_id) {
      return json({ ok: true, ignored: evt.event || "unknown" }, 200, origin);
    }

    // Only orders created through TixDesk for this organizer; their other Razorpay traffic is ignored
    const order = await env.DB.prepare("SELECT * FROM orders WHERE rzp_order_id = ? AND organizer_id = ?")
      .bind(payment.order_id, integration.organizerId).first();
    if (!order) return json({ ok: true, ignored: "unknown order" }, 200, origin);
    if (order.amount_paise !== payment.amount) {
      // Money was captured but not for what we priced: park it for the organizer instead of dropping it
      console.error("Order amount mismatch", order.id, order.amount_paise, payment.amount);
      const parked = await env.DB.prepare("UPDATE orders SET status = 'needs_review', rzp_payment_id = ? WHERE id = ? AND status IN ('pending', 'expired')")
        .bind(payment.id, order.id).run();
      // A pending order still holds stock and credits; give them back since no tickets will be issued
      if (parked.meta?.changes && order.status === "pending") await unreserve(env, order.ticket_type_id, order.organizer_id, order.qty);
      return json({ ok: true, ignored: "amount mismatch" }, 200, origin);
    }

    // A thrown error here becomes a 500, which is right: Razorpay retries and the claim in fulfillOrder keeps it safe
    const result = await fulfillOrder(env, order, payment.id);
    const eventId = request.headers.get("X-Razorpay-Event-Id");
    if (eventId) {
      await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (source, event_id) VALUES ('razorpay-org', ?)").bind(eventId).run();
    }
    return json({ ok: true, status: result.status }, 200, origin);
  }

  return null;
}
