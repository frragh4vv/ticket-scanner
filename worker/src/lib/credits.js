// Credits a paid top-up exactly once. Shared by the browser callback (/api/billing/verify-order)
// and the Razorpay webhook (/api/hooks/razorpay), whichever arrives first wins and the other is a no-op.
// 'failed' is accepted too: a bad browser signature marks an order failed, but a verified webhook is authoritative.

export async function settleCreditOrder(env, order, paymentId) {
  const [credit] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE organizers SET ticket_credits = ticket_credits + ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM credit_orders WHERE order_id = ? AND status IN ('created', 'failed'))
    `).bind(order.credits_purchased, order.organizer_id, order.order_id),
    env.DB.prepare("UPDATE credit_orders SET status = 'paid', payment_id = ? WHERE order_id = ? AND status IN ('created', 'failed')")
      .bind(paymentId || "demo", order.order_id)
  ]);
  return !!(credit.meta && credit.meta.changes > 0);
}
