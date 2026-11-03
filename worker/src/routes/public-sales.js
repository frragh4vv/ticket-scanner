// Buyer-facing endpoints behind /e/<slug>. No login. Prices and amounts always come from our database,
// never from the request. Payment is made to the organizer's own Razorpay account.

import { EMAIL_RE } from "../config.js";
import { json } from "../lib/http.js";
import { bytesToHex, hmac, timingSafeEqual } from "../lib/crypto.js";
import { consumeQuota } from "../lib/limits.js";
import { generateRandomCode } from "../lib/util.js";
import { loadIntegration, razorpayFetch } from "../lib/razorpay.js";
import { HOLD_SECONDS, reserve, unreserve, releaseExpired, fulfillOrder } from "../lib/orders.js";

const MAX_QTY_PER_ORDER = 10;

async function pageBySlug(env, slug) {
  return env.DB.prepare(`
    SELECT p.event_id, p.organizer_id, e.title, e.start_date, e.total_days
    FROM event_pages p JOIN events e ON e.id = p.event_id
    WHERE p.slug = ? AND p.enabled = 1
  `).bind(String(slug || "").toLowerCase()).first();
}

function onSale(t, nowMs) {
  if (!t.active) return false;
  if (t.sales_start && Date.parse(t.sales_start) > nowMs) return false;
  if (t.sales_end && Date.parse(t.sales_end) < nowMs) return false;
  return true;
}

export async function handle(ctx) {
  const { request, env, url, origin, clientIp } = ctx;
  const path = url.pathname;
  if (!path.startsWith("/api/public/")) return null;

  // GET /api/public/events/<slug> -> what the booking page shows
  const eventMatch = path.match(/^\/api\/public\/events\/([^/]+)$/);
  if (eventMatch && request.method === "GET") {
    const page = await pageBySlug(env, eventMatch[1]);
    if (!page) return json({ error: "This booking page doesn't exist or is closed." }, 404, origin);
    const { results: all } = await env.DB.prepare("SELECT id FROM ticket_types WHERE event_id = ?").bind(page.event_id).all();
    for (const t of all) await releaseExpired(env, t.id);
    const { results } = await env.DB.prepare(
      "SELECT id, name, description, tier, price_paise, quantity, held, sold, allowed_days, sales_start, sales_end, active FROM ticket_types WHERE event_id = ? AND active = 1 ORDER BY price_paise"
    ).bind(page.event_id).all();
    const now = Date.now();
    const integration = await env.DB.prepare("SELECT 1 AS ok FROM integrations WHERE organizer_id = ?").bind(page.organizer_id).first();
    return json({
      ok: true,
      event: { title: page.title, start_date: page.start_date, total_days: page.total_days },
      selling: !!integration,
      types: results.filter(t => onSale(t, now)).map(t => ({
        id: t.id, name: t.name, description: t.description || "", tier: t.tier, price_paise: t.price_paise, allowed_days: t.allowed_days,
        remaining: Math.max(t.quantity - t.sold - t.held, 0)
      }))
    }, 200, origin);
  }

  // POST /api/public/orders -> hold stock, create the Razorpay order on the organizer's account
  if (path === "/api/public/orders" && request.method === "POST") {
    if (!(await consumeQuota(env, `order:${clientIp}`, 12, 600))) {
      return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429, origin);
    }
    const b = await request.json();
    const page = await pageBySlug(env, b.slug);
    if (!page) return json({ error: "This booking page doesn't exist or is closed." }, 404, origin);

    const qty = parseInt(b.qty, 10);
    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 254);
    const phone = String(b.phone || "").trim().slice(0, 20);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ORDER) {
      return json({ error: `Choose between 1 and ${MAX_QTY_PER_ORDER} tickets.` }, 400, origin);
    }
    if (!name) return json({ error: "Enter your name." }, 400, origin);
    if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email. Your pass is sent there." }, 400, origin);

    const type = await env.DB.prepare("SELECT * FROM ticket_types WHERE id = ? AND event_id = ?").bind(String(b.type_id || ""), page.event_id).first();
    if (!type || !onSale(type, Date.now())) return json({ error: "This ticket isn't on sale right now." }, 409, origin);

    const integration = await loadIntegration(env, "organizer_id", page.organizer_id);
    if (!integration) return json({ error: "Ticket sales aren't open for this event yet." }, 409, origin);

    await releaseExpired(env, type.id);
    const held = await reserve(env, type, qty);
    if (held === "sold_out") return json({ error: "Not enough tickets left for that quantity.", code: "SOLD_OUT" }, 409, origin);
    if (held === "no_credits") return json({ error: "Sales are paused for this event. Please contact the organizer.", code: "PAUSED" }, 409, origin);

    const orderId = `ord_${generateRandomCode(12).toLowerCase()}`;
    const amount = type.price_paise * qty;
    try {
      const rp = await razorpayFetch(integration.keyId, integration.keySecret, "/orders", {
        method: "POST",
        body: JSON.stringify({ amount, currency: "INR", receipt: orderId, notes: { order_id: orderId, event: page.title } })
      });
      if (!rp.ok || !rp.data.id) throw new Error(`Razorpay order failed: ${rp.status}`);
      await env.DB.prepare(`
        INSERT INTO orders (id, organizer_id, event_id, ticket_type_id, qty, buyer_name, buyer_email, buyer_phone, amount_paise, rzp_order_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(orderId, page.organizer_id, page.event_id, type.id, qty, name, email, phone, amount, rp.data.id,
              Math.floor(Date.now() / 1000) + HOLD_SECONDS).run();
      return json({
        ok: true, rzp_order_id: rp.data.id, key_id: integration.keyId, amount, currency: "INR",
        event_title: page.title, type_name: type.name, expires_in: HOLD_SECONDS
      }, 200, origin);
    } catch (err) {
      await unreserve(env, type.id, page.organizer_id, qty);
      console.error(err);
      return json({ error: "Couldn't start the payment. Please try again." }, 502, origin);
    }
  }

  // POST /api/public/orders/verify { rzp_order_id, payment_id, signature } -> issue tickets right after checkout
  if (path === "/api/public/orders/verify" && request.method === "POST") {
    const b = await request.json();
    const order = await env.DB.prepare("SELECT * FROM orders WHERE rzp_order_id = ?").bind(String(b.rzp_order_id || "")).first();
    if (!order) return json({ error: "Order not found" }, 404, origin);
    if (!b.payment_id || !b.signature) return json({ error: "Missing payment details." }, 400, origin);

    const integration = await loadIntegration(env, "organizer_id", order.organizer_id);
    if (!integration) return json({ error: "Order not found" }, 404, origin);
    const expected = bytesToHex(await hmac(integration.keySecret, `${order.rzp_order_id}|${b.payment_id}`));
    if (!timingSafeEqual(String(b.signature), expected)) {
      return json({ error: "Payment could not be verified." }, 400, origin);
    }
    return json(await outcome(env, order, b.payment_id), 200, origin);
  }

  // GET /api/public/orders/<rzp_order_id> -> status poll (the webhook may finish an order before the browser does)
  const statusMatch = path.match(/^\/api\/public\/orders\/(order_[A-Za-z0-9]+)$/);
  if (statusMatch && request.method === "GET") {
    const order = await env.DB.prepare("SELECT * FROM orders WHERE rzp_order_id = ?").bind(statusMatch[1]).first();
    if (!order) return json({ error: "Order not found" }, 404, origin);
    return json(await outcome(env, order, null), 200, origin);
  }

  return null;
}

// Shared response for verify and status: fulfil when a verified payment id is given, then report.
async function outcome(env, order, paymentId) {
  let current = order;
  if (paymentId) {
    await fulfillOrder(env, order, paymentId);
    current = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first();
  }
  const base = { ok: true, order_id: current.id, status: current.status };
  if (current.status !== "issued") {
    return { ...base, message: current.status === "needs_review"
      ? "Your payment was received, but the tickets sold out while you paid. The organizer will refund you."
      : undefined };
  }
  const { results } = await env.DB.prepare("SELECT ticket_id FROM order_tickets WHERE order_id = ?").bind(current.id).all();
  return { ...base, ticket_ids: results.map(r => r.ticket_id), email: current.buyer_email };
}
