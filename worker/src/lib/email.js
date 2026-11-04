// Builds and sends one pass email through the configured mail provider (see mailer.js). Used by POST /api/send-email and the email queue consumer.
// Returns { status, body } so callers decide how to respond.

import { escapeHtml } from "./util.js";
import { consumeQuota } from "./limits.js";
import { mailConfigured, sendMail } from "./mailer.js";

// onlyIfUnsent: the queue consumer sets it so a ticket queued twice is only emailed once.
export async function sendPassEmail(env, organizerId, { ticketId, email, eventName, passImageData, passPdfData, onlyIfUnsent = false } = {}) {
  const ticket = await env.DB.prepare(`
    SELECT t.*, e.title AS event_title FROM tickets t JOIN events e ON e.id = t.event_id
    WHERE t.id = ? AND e.organizer_id = ?
  `).bind(ticketId || "", organizerId).first();
  if (!ticket) {
    return { status: 404, body: { error: "Ticket not found" } };
  }
  if (onlyIfUnsent && (ticket.email_sent_at || ticket.status === "revoked")) {
    return { status: 200, body: { success: true, skipped: true } };
  }

  const recipient = (email || ticket.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { status: 400, body: { error: "Missing or invalid attendee email" } };
  }

  const ticketTier = ticket.tier || "General";
  const plainEvent = (eventName || ticket.event_title || "your event").slice(0, 120);
  const displayEvent = escapeHtml(plainEvent);
  const firstName = escapeHtml((ticket.attendee_name || "").trim().split(/\s+/)[0] || "there");
  const safeTicketId = escapeHtml(ticket.id);

  // Tier chip colours, tuned for a light email body
  const tierStyle = {
    VIP: { fg: "#4A6200", bg: "#EEF8C4", label: "VIP" },
    Guestlist: { fg: "#5A3FB0", bg: "#EFE9FF", label: "Guestlist" },
    General: { fg: "#0F6B53", bg: "#DDF5EC", label: "General" }
  }[ticketTier] || { fg: "#0F6B53", bg: "#DDF5EC", label: "General" };

  // The ticket goes out as a real attachment (PDF preferred, JPG as fallback); data: URI images are blocked by most mail clients
  const attachments = [];
  const pdfMatch = typeof passPdfData === "string" && passPdfData.match(/^data:application\/pdf(?:;[a-z-]+=[^;,]+)*;base64,([A-Za-z0-9+/=]+)$/);
  const imgMatch = typeof passImageData === "string" && passImageData.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (pdfMatch && pdfMatch[1].length < 7_000_000) {
    attachments.push({ filename: `${ticket.id}.pdf`, content: pdfMatch[1] });
  } else if (imgMatch && imgMatch[2].length < 5_000_000) {
    attachments.push({ filename: `${ticket.id}.${imgMatch[1] === "png" ? "png" : "jpg"}`, content: imgMatch[2] });
  }
  const attachedKind = attachments.length ? (attachments[0].filename.endsWith(".pdf") ? "PDF" : "image") : "";

  // Without an attachment the QR code is the only copy of the ticket, so it goes in the body
  const qrBlock = attachments.length ? "" : `
          <tr><td align="center" style="padding: 8px 0 24px 0;">
            <div style="display: inline-block; padding: 12px; background: #ffffff; border: 1px solid #E4E1D8;">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(ticket.id)}" alt="Entry QR code" width="200" height="200" style="display: block;" />
            </div>
          </td></tr>`;

  const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="color-scheme" content="light"/></head>
<body style="margin: 0; padding: 0; background: #F4F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #17191C;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">Your ticket for ${displayEvent} is attached.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F4F2EC;">
<tr><td align="center" style="padding: 32px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: #ffffff; border: 1px solid #E4E1D8;">
  <tr><td style="height: 6px; background: #D4F36B; font-size: 0; line-height: 0;">&nbsp;</td></tr>
  <tr><td style="padding: 36px 36px 8px 36px;">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #6B6A63;">Your ticket</div>
    <h1 style="margin: 10px 0 0 0; font-size: 28px; line-height: 1.2; font-weight: 800; letter-spacing: -0.5px; color: #17191C;">${displayEvent}</h1>
  </td></tr>
  <tr><td style="padding: 18px 36px 8px 36px; font-size: 16px; line-height: 1.6; color: #34363A;">
    Hi ${firstName}, here is your ticket for <strong>${displayEvent}</strong>. ${attachments.length ? `It is attached to this email as a ${attachedKind}.` : "Show the code below at the gate."}
  </td></tr>
  <tr><td style="padding: 18px 36px 8px 36px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #FAF9F5; border: 1px solid #E4E1D8;">
      <tr>
        <td style="padding: 16px 18px;">
          <div style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #8A897F;">Ticket ID</div>
          <div style="margin-top: 4px; font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 18px; font-weight: 700; letter-spacing: 2px; color: #17191C;">${safeTicketId}</div>
        </td>
        <td align="right" style="padding: 16px 18px;">
          <span style="display: inline-block; padding: 6px 12px; background: ${tierStyle.bg}; color: ${tierStyle.fg}; font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">${tierStyle.label}</span>
        </td>
      </tr>
    </table>
  </td></tr>
  ${qrBlock}
  <tr><td style="padding: 20px 36px 32px 36px; font-size: 14px; line-height: 1.6; color: #5A5B55;">
    Show the QR code on your phone at the entrance. Each ticket works for one person, so please don't share it.
  </td></tr>
  <tr><td style="padding: 16px 36px; border-top: 1px solid #E4E1D8; font-size: 12px; color: #8A897F;">
    Sent with TixDesk
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  if (!mailConfigured(env)) {
    return { status: 500, body: { error: "Email is not configured", details: "Set APPS_SCRIPT_URL + APPS_SCRIPT_SECRET, or RESEND_API_KEY, in Worker secrets" } };
  }
  // Keeps a free account from turning the mail sender into a spam relay
  const dailyCap = parseInt(env.EMAIL_DAILY_CAP, 10) || 1000;
  if (!(await consumeQuota(env, `email:${organizerId}`, dailyCap, 24 * 3600))) {
    return { status: 429, body: { error: `Daily email limit reached (${dailyCap}). Try again tomorrow or contact support.` } };
  }

  const sent = await sendMail(env, {
    to: recipient,
    subject: `Your ticket for ${plainEvent}`,
    html: emailHtml,
    attachments
  });

  if (!sent.ok) {
    // 429 passes through so bulk senders know to back off and retry
    return { status: sent.status === 429 ? 429 : 502, body: { error: "Failed to dispatch email", details: sent.text } };
  }

  await env.DB.prepare("UPDATE tickets SET email_sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(ticket.id).run();
  return { status: 200, body: { success: true, message: "Email dispatched successfully" } };
}
