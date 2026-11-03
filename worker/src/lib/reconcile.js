// Server-side payment check: ask the organizer's Razorpay account whether an order was paid, using the
// key we already store. This replaces the per-organizer webhook as the default safety net for buyers who
// pay but never get back to the page (tab closed on the bank page, network drop, mobile redirects).
// Runs from the 5-minute cron (index.js scheduled()) and from the booking page's status poll.

import { loadIntegration, razorpayFetch } from "./razorpay.js";
import { fulfillOrder, parkForReview, releaseExpired } from "./orders.js";

// Keep checking an order this long after its hold ends: bank payments can confirm late
const LATE_PAYMENT_SECONDS = 15 * 60;
// Workers Free allows 50 D1 queries per run and issuing a paid order takes several, so keep one sweep
// small; the cron runs every 5 minutes, so a backlog clears quickly
const SWEEP_LIMIT = 8;

// Returns 'issued' | 'already' | 'needs_review' | 'unpaid'
export async function reconcileOrder(env, order, integration) {
  const res = await razorpayFetch(integration.keyId, integration.keySecret, `/orders/${encodeURIComponent(order.rzp_order_id)}/payments`);
  if (!res.ok) throw new Error(`Razorpay payments lookup failed: ${res.status}`);
  const items = res.data.items || [];

  let paid = items.find(p => p.status === "captured");
  if (!paid) {
    // Accounts set to manual capture leave payments "authorized"; collect them so the organizer never
    // has to change that setting. Razorpay refuses a second capture, so a race here is harmless.
    const authorized = items.find(p => p.status === "authorized");
    if (!authorized) return "unpaid";
    const cap = await razorpayFetch(integration.keyId, integration.keySecret, `/payments/${encodeURIComponent(authorized.id)}/capture`, {
      method: "POST", body: JSON.stringify({ amount: authorized.amount, currency: authorized.currency || "INR" })
    });
    if (!cap.ok || cap.data.status !== "captured") return "unpaid";
    paid = cap.data;
  }

  if (paid.amount !== order.amount_paise) {
    console.error("Order amount mismatch", order.id, order.amount_paise, paid.amount);
    await parkForReview(env, order, paid.id);
    return "needs_review";
  }
  return (await fulfillOrder(env, order, paid.id)).status;
}

// Cron sweep: check every unpaid order that is still in its hold or recently expired, then release
// holds that are past due. Abandoned checkouts are checked a handful of times and then dropped.
export async function sweepPendingOrders(env) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(`
    SELECT * FROM orders
    WHERE status IN ('pending', 'expired') AND rzp_payment_id IS NULL AND expires_at > ?
    ORDER BY expires_at LIMIT ?
  `).bind(now - LATE_PAYMENT_SECONDS, SWEEP_LIMIT).all();

  const integrations = new Map();
  const types = new Set();
  for (const order of results) {
    types.add(order.ticket_type_id);
    try {
      if (!integrations.has(order.organizer_id)) {
        integrations.set(order.organizer_id, await loadIntegration(env, "organizer_id", order.organizer_id));
      }
      const integration = integrations.get(order.organizer_id);
      if (integration) await reconcileOrder(env, order, integration);
    } catch (err) {
      console.error("order sweep failed", order.id, err);
    }
  }
  for (const typeId of types) await releaseExpired(env, typeId);
  return results.length;
}
