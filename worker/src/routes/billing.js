// Credit top-ups through Razorpay (or DEMO_BILLING locally).
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { CREDIT_PACKS } from "../config.js";
import { json } from "../lib/http.js";
import { generateRandomCode } from "../lib/util.js";
import { bytesToHex, hmac, timingSafeEqual } from "../lib/crypto.js";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // =========================================================================
  // BILLING & CREDIT RECHARGE APIS (Razorpay)
  // Real payments need RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
  // For local testing only, DEMO_BILLING="true" skips the gateway.
  // =========================================================================
  const razorpayEnabled = !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const demoBilling = !razorpayEnabled && env.DEMO_BILLING === "true";

  // POST /api/billing/create-order -> Create Top-up Order
  if (url.pathname === "/api/billing/create-order" && request.method === "POST") {
    if (!razorpayEnabled && !demoBilling) {
      return json({ ok: false, error: "Payments are not configured on this server." }, 503, origin);
    }

    const { pack } = await request.json();
    const selected = CREDIT_PACKS[pack] || CREDIT_PACKS.starter;
    let orderId = `demo_${Date.now()}_${generateRandomCode(4)}`;

    if (razorpayEnabled) {
      const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`
        },
        body: JSON.stringify({
          amount: selected.amount * 100, // paise
          currency: "INR",
          receipt: `rcpt_${Date.now()}`,
          notes: { organizer_id: organizerId, credits: String(selected.credits) }
        })
      });
      if (!rpRes.ok) {
        return json({ ok: false, error: "Could not create payment order", details: await rpRes.text() }, 502, origin);
      }
      orderId = (await rpRes.json()).id;
    }

    await env.DB.prepare(`
      INSERT INTO credit_orders (order_id, organizer_id, credits_purchased, amount_inr, status)
      VALUES (?, ?, ?, ?, 'created')
    `).bind(orderId, organizerId, selected.credits, selected.amount).run();

    return json({
      ok: true,
      order_id: orderId,
      credits: selected.credits,
      amount_inr: selected.amount,
      currency: "INR",
      razorpay_key_id: razorpayEnabled ? env.RAZORPAY_KEY_ID : null,
      demo: demoBilling
    }, 200, origin);
  }

  // POST /api/billing/verify-order -> Confirm Payment & Credit Balance
  if (url.pathname === "/api/billing/verify-order" && request.method === "POST") {
    const { order_id, razorpay_payment_id, razorpay_signature } = await request.json();

    const order = await env.DB.prepare("SELECT * FROM credit_orders WHERE order_id = ? AND organizer_id = ?")
      .bind(order_id || "", organizerId).first();
    if (!order) return json({ ok: false, error: "Order not found" }, 404, origin);

    if (razorpayEnabled) {
      const expected = bytesToHex(await hmac(env.RAZORPAY_KEY_SECRET, `${order.order_id}|${razorpay_payment_id || ""}`));
      if (!razorpay_signature || !timingSafeEqual(String(razorpay_signature), expected)) {
        await env.DB.prepare("UPDATE credit_orders SET status = 'failed' WHERE order_id = ? AND status = 'created'").bind(order.order_id).run();
        return json({ ok: false, error: "Payment signature verification failed." }, 400, origin);
      }
    } else if (!demoBilling) {
      return json({ ok: false, error: "Payments are not configured on this server." }, 503, origin);
    }

    // Credit (amount comes from the stored order, never the client) and mark paid in one transaction.
    // The EXISTS guard makes replays of the same order a no-op.
    const [credit] = await env.DB.batch([
      env.DB.prepare(`
        UPDATE organizers SET ticket_credits = ticket_credits + ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM credit_orders WHERE order_id = ? AND status = 'created')
      `).bind(order.credits_purchased, organizerId, order.order_id),
      env.DB.prepare("UPDATE credit_orders SET status = 'paid', payment_id = ? WHERE order_id = ? AND status = 'created'")
        .bind(razorpay_payment_id || "demo", order.order_id)
    ]);

    const updatedOrg = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
    if (!credit.meta || credit.meta.changes === 0) {
      return json({ ok: false, error: "This order was already processed.", new_balance: updatedOrg?.ticket_credits ?? 0 }, 409, origin);
    }

    return json({
      ok: true,
      success: true,
      message: `Successfully credited ${order.credits_purchased} passes!`,
      new_balance: updatedOrg?.ticket_credits ?? 0
    }, 200, origin);
  }

  return null;
}
