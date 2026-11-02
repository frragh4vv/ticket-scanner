// Organizer account: profile, data export, password change, deletion.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { json } from "../lib/http.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { adminSession } from "../lib/session.js";
import { eventScope } from "../lib/scope.js";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // GET /api/auth/me -> Current Organizer Profile & Balance
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const org = await env.DB.prepare(`
      SELECT o.id, o.email, o.company_name, o.ticket_credits,
        EXISTS (SELECT 1 FROM tour_grants g WHERE g.organizer_id = o.id) AS tour_tickets_used
      FROM organizers o WHERE o.id = ?
    `).bind(organizerId).first();
    if (!org) return json({ ok: false, error: "Organizer not found" }, 404, origin);
    org.tour_tickets_used = !!org.tour_tickets_used;
    return json({ ok: true, organizer: org }, 200, origin);
  }

  // GET /api/auth/export -> Everything stored for this organizer (data portability)
  if (url.pathname === "/api/auth/export" && request.method === "GET") {
    const scope = eventScope("ALL", organizerId);
    const [org, events, tickets, scans, orders] = await Promise.all([
      env.DB.prepare("SELECT id, email, company_name, ticket_credits, created_at FROM organizers WHERE id = ?").bind(organizerId).first(),
      env.DB.prepare("SELECT id, title, total_days, start_date, gate_pin, created_at FROM events WHERE organizer_id = ?").bind(organizerId).all(),
      env.DB.prepare(`SELECT * FROM tickets WHERE ${scope.sql}`).bind(...scope.params).all(),
      env.DB.prepare(`SELECT * FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params).all(),
      env.DB.prepare("SELECT order_id, credits_purchased, amount_inr, currency, payment_id, status, created_at FROM credit_orders WHERE organizer_id = ?").bind(organizerId).all(),
    ]);
    return json({
      exported_at: new Date().toISOString(),
      organizer: org,
      events: events.results || [],
      tickets: tickets.results || [],
      scan_logs: scans.results || [],
      credit_orders: orders.results || [],
    }, 200, origin, { "Content-Disposition": 'attachment; filename="tixdesk-account-export.json"' });
  }

  // POST /api/auth/password -> Change password (signs out every other device)
  if (url.pathname === "/api/auth/password" && request.method === "POST") {
    const { current_password, new_password } = await request.json();
    const org = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(organizerId).first();
    if (!org || typeof current_password !== "string" || !(await verifyPassword(current_password, org.password_hash))) {
      return json({ ok: false, error: "Current password is incorrect." }, 400, origin);
    }
    if (typeof new_password !== "string" || new_password.length < 8 || new_password.length > 200) {
      return json({ ok: false, error: "New password must be 8 to 200 characters." }, 400, origin);
    }
    org.password_hash = await hashPassword(new_password);
    await env.DB.prepare("UPDATE organizers SET password_hash = ? WHERE id = ?").bind(org.password_hash, org.id).run();
    return json({ ok: true, token: await adminSession(env, org) }, 200, origin);
  }

  // POST /api/auth/delete -> Delete the account: events, tickets and scan logs are erased.
  // Payment records are kept (tax law) but detached from any personal data.
  if (url.pathname === "/api/auth/delete" && request.method === "POST") {
    const { password, confirm } = await request.json();
    const org = await env.DB.prepare("SELECT id, password_hash FROM organizers WHERE id = ?").bind(organizerId).first();
    if (confirm !== "DELETE" || !org || typeof password !== "string" || !(await verifyPassword(password, org.password_hash))) {
      return json({ ok: false, error: "Type DELETE and enter your current password to confirm." }, 400, origin);
    }
    const scope = eventScope("ALL", organizerId);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
      env.DB.prepare(`DELETE FROM tickets WHERE ${scope.sql}`).bind(...scope.params),
      env.DB.prepare("DELETE FROM events WHERE organizer_id = ?").bind(organizerId),
      env.DB.prepare(`
        UPDATE organizers SET email = 'deleted+' || id || '@deleted.invalid', company_name = 'Deleted account',
          password_hash = '', ticket_credits = 0 WHERE id = ?
      `).bind(organizerId),
    ]);
    return json({ ok: true, message: "Your account and event data have been deleted." }, 200, origin);
  }

  return null;
}
