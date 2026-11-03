// Buyer orders: hold stock and credits, release them when an order expires, and issue tickets once a
// payment is confirmed. The browser verify and the Razorpay webhook both end in fulfillOrder(), and the
// conditional status updates make a second call a no-op, so tickets are never issued twice.

import { getTierPrefix, generateRandomCode } from "./util.js";

export const HOLD_SECONDS = 15 * 60;

// Take `qty` of stock and `qty` credits. The conditional UPDATEs can never oversell or overdraw.
export async function reserve(env, type, qty) {
  const stock = await env.DB.prepare(
    "UPDATE ticket_types SET held = held + ? WHERE id = ? AND active = 1 AND sold + held + ? <= quantity"
  ).bind(qty, type.id, qty).run();
  if (!stock.meta?.changes) return "sold_out";

  const credits = await env.DB.prepare(
    "UPDATE organizers SET ticket_credits = ticket_credits - ? WHERE id = ? AND ticket_credits >= ?"
  ).bind(qty, type.organizer_id, qty).run();
  if (!credits.meta?.changes) {
    await env.DB.prepare("UPDATE ticket_types SET held = held - ? WHERE id = ?").bind(qty, type.id).run();
    return "no_credits";
  }
  return "ok";
}

export async function unreserve(env, typeId, organizerId, qty) {
  await env.DB.batch([
    env.DB.prepare("UPDATE ticket_types SET held = MAX(held - ?, 0) WHERE id = ?").bind(qty, typeId),
    env.DB.prepare("UPDATE organizers SET ticket_credits = ticket_credits + ? WHERE id = ?").bind(qty, organizerId)
  ]);
}

// Unpaid orders past their hold give stock and credits back. Run lazily before any stock check
// instead of from a cron, so it needs no extra Cloudflare setup.
export async function releaseExpired(env, typeId) {
  const { results } = await env.DB.prepare(
    "SELECT id, organizer_id, ticket_type_id, qty FROM orders WHERE ticket_type_id = ? AND status = 'pending' AND expires_at < ? LIMIT 50"
  ).bind(typeId, Math.floor(Date.now() / 1000)).all();
  for (const o of results) {
    const flip = await env.DB.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(o.id).run();
    if (flip.meta?.changes) await unreserve(env, o.ticket_type_id, o.organizer_id, o.qty);
  }
}

// Issue the tickets for a paid order. Returns { status: 'issued' | 'already' | 'needs_review', ticketIds? }.
// The caller has already verified the payment (signature or webhook) and that the amount matches.
export async function fulfillOrder(env, order, paymentId) {
  if (order.status === "issued") return { status: "already" };
  if (order.status === "needs_review") return { status: "needs_review" };

  const type = await env.DB.prepare("SELECT * FROM ticket_types WHERE id = ?").bind(order.ticket_type_id).first();

  // Paid after the hold expired: take stock and credits again. If either is gone the buyer already
  // paid, so park the order for the organizer to refund instead of dropping it.
  if (order.status === "expired") {
    if (await reserve(env, type, order.qty) !== "ok") {
      await env.DB.prepare("UPDATE orders SET status = 'needs_review', rzp_payment_id = ? WHERE id = ? AND status = 'expired'")
        .bind(paymentId, order.id).run();
      return { status: "needs_review" };
    }
    const back = await env.DB.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'expired'").bind(order.id).run();
    if (!back.meta?.changes) {
      await unreserve(env, type.id, type.organizer_id, order.qty);
      return { status: "already" };
    }
  }

  // The claim: only one caller flips pending -> issued
  const claim = await env.DB.prepare(
    "UPDATE orders SET status = 'issued', rzp_payment_id = ?, issued_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
  ).bind(paymentId, order.id).run();
  if (!claim.meta?.changes) return { status: "already" };

  const event = await env.DB.prepare("SELECT total_days FROM events WHERE id = ?").bind(order.event_id).first();
  const prefix = getTierPrefix(type.tier);
  const ticketIds = [];
  const statements = [];
  for (let i = 0; i < order.qty; i++) {
    const id = `${prefix}-${generateRandomCode(8)}`;
    ticketIds.push(id);
    statements.push(
      env.DB.prepare(`
        INSERT INTO tickets (id, event_id, attendee_name, email, phone, tier, total_days, allowed_days, scanned_days, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'valid')
      `).bind(id, order.event_id, order.buyer_name, order.buyer_email, order.buyer_phone || "", type.tier, event.total_days, type.allowed_days || "ALL"),
      env.DB.prepare("INSERT INTO order_tickets (order_id, ticket_id) VALUES (?, ?)").bind(order.id, id)
    );
  }
  statements.push(
    env.DB.prepare("UPDATE ticket_types SET held = MAX(held - ?, 0), sold = sold + ? WHERE id = ?").bind(order.qty, order.qty, type.id)
  );

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // All-or-nothing batch failed: reopen the order so the webhook retry (or the buyer) can finish it
    await env.DB.prepare("UPDATE orders SET status = 'pending', issued_at = NULL WHERE id = ?").bind(order.id).run();
    throw err;
  }

  // Email the passes in the background. Only the caller that won the claim gets here, so each order
  // is queued once; a missing queue (local dev) just means the buyer sees the QR on the page only.
  if (env.EMAIL_QUEUE) {
    try {
      await env.EMAIL_QUEUE.sendBatch(ticketIds.map(ticketId => ({ body: { ticketId, organizerId: order.organizer_id } })));
    } catch (err) {
      console.error("order email queue failed", order.id, err);
    }
  }
  return { status: "issued", ticketIds };
}
