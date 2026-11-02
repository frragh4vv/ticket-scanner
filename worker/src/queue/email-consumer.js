// Cloudflare Queues consumer for "tixdesk-email". Each message is { ticketId, organizerId }.
// Runs in the background, separate from any HTTP request. Wired up in index.js as `queue()`.

import { sendPassEmail } from "../lib/email.js";

export async function consumeEmailBatch(batch, env) {
  for (const message of batch.messages) {
    const { ticketId, organizerId } = message.body || {};
    try {
      const result = await sendPassEmail(env, organizerId, { ticketId, onlyIfUnsent: true });
      if (result.status === 429 && !/Daily email limit/.test(result.body.error || "")) {
        // Resend is throttling: try this message again in a minute
        message.retry({ delaySeconds: 60 });
      } else if (result.status === 502) {
        // Resend errored; 500 means RESEND_API_KEY is missing, which retrying won't fix
        message.retry({ delaySeconds: 30 });
      } else {
        // Sent, skipped, or a permanent problem (bad email, ticket gone, daily cap). Retrying won't help;
        // the ticket stays unsent in the dashboard so the organizer can see it.
        if (result.status !== 200) console.warn("email queue: not sent", ticketId, result.status, result.body.error);
        message.ack();
      }
    } catch (err) {
      console.error("email queue: failed", ticketId, err);
      message.retry({ delaySeconds: 30 });
    }
  }
}
