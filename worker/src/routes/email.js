// Pass emails: send one now, or queue every unsent pass of an event for background delivery.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { json } from "../lib/http.js";
import { consumeQuota } from "../lib/limits.js";
import { eventScope } from "../lib/scope.js";
import { sendPassEmail } from "../lib/email.js";

const QUEUE_SEND_BATCH = 100;      // Queues sendBatch() accepts at most 100 messages per call
const MAX_QUEUED_PER_REQUEST = 1000;

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // =========================================================================
  // POST /api/send-email -> Dispatch one pass via Resend (browser attaches the rendered PDF/JPG)
  // =========================================================================
  if (url.pathname === "/api/send-email" && request.method === "POST") {
    const result = await sendPassEmail(env, organizerId, await request.json());
    return json(result.body, result.status, origin);
  }

  // =========================================================================
  // POST /api/send-email/queue -> Queue every unsent pass of one event.
  // The queue consumer (queue/email-consumer.js) sends them in the background, so the organizer
  // can close the tab. Queued emails carry the QR code in the body, not the designed PDF,
  // because the PDF is only ever rendered in the organizer's browser.
  // =========================================================================
  if (url.pathname === "/api/send-email/queue" && request.method === "POST") {
    if (!env.EMAIL_QUEUE) {
      return json({ error: "Background email is not configured on this server." }, 503, origin);
    }
    const { event_id } = await request.json();
    if (!event_id || event_id === "ALL") {
      return json({ error: "Pick one event to send." }, 400, origin);
    }
    // One queue run per event every 10 minutes, so a double click doesn't queue everything twice
    if (!(await consumeQuota(env, `emailq:${organizerId}:${event_id}`, 1, 600))) {
      return json({ error: "Emails for this event were queued a moment ago. Give them a few minutes." }, 429, origin);
    }

    const scope = eventScope(event_id, organizerId);
    const rows = await env.DB.prepare(`
      SELECT id FROM tickets
      WHERE ${scope.sql} AND email != '' AND email_sent_at IS NULL AND status != 'revoked'
      ORDER BY created_at LIMIT ?
    `).bind(...scope.params, MAX_QUEUED_PER_REQUEST).all();
    const ids = (rows.results || []).map(r => r.id);

    for (let i = 0; i < ids.length; i += QUEUE_SEND_BATCH) {
      await env.EMAIL_QUEUE.sendBatch(ids.slice(i, i + QUEUE_SEND_BATCH).map(ticketId => ({
        body: { ticketId, organizerId }
      })));
    }
    return json({ ok: true, queued: ids.length, more: ids.length === MAX_QUEUED_PER_REQUEST }, 200, origin);
  }

  return null;
}
