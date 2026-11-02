// Events: list and create.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { DEFAULT_EVENT_TZ } from "../config.js";
import { json } from "../lib/http.js";
import { generateRandomCode, generatePin } from "../lib/util.js";
import { validTimeZone } from "../lib/eventday.js";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // GET /api/events -> List Events for Organizer
  if (url.pathname === "/api/events" && request.method === "GET") {
    const events = await env.DB.prepare("SELECT * FROM events WHERE organizer_id = ? ORDER BY created_at DESC").bind(organizerId).all();
    return json({ ok: true, events: events.results || [] }, 200, origin);
  }

  // POST /api/events -> Create New Event
  if (url.pathname === "/api/events" && request.method === "POST") {
    const { title, total_days, start_date, gate_pin, use_tiers, timezone } = await request.json();
    const cleanTitle = (title || "").trim().slice(0, 120);
    if (!cleanTitle) return json({ ok: false, error: "Event title is required." }, 400, origin);

    const requestedPin = String(gate_pin || "").trim();
    const pin = /^\d{6,8}$/.test(requestedPin) ? requestedPin : generatePin();
    const eventId = `evt_${Date.now()}_${generateRandomCode(4).toLowerCase()}`;
    const totalDays = Math.max(1, Math.min(10, parseInt(total_days, 10) || 1));
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(start_date || "") ? start_date : new Date().toISOString().split("T")[0];

    const useTiers = use_tiers ? 1 : 0;
    const tz = (typeof timezone === "string" && validTimeZone(timezone)) ? timezone : DEFAULT_EVENT_TZ;

    // Events can't start in the past (compared on the event's own calendar day)
    const todayInTz = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    if (startDate < todayInTz) {
      return json({ ok: false, error: "The start date can't be in the past." }, 400, origin);
    }

    const dupe = await env.DB.prepare("SELECT 1 FROM events WHERE organizer_id = ? AND lower(title) = lower(?)")
      .bind(organizerId, cleanTitle).first();
    if (dupe) {
      return json({ ok: false, error: `You already have an event called "${cleanTitle}". Pick a different name.` }, 409, origin);
    }

    await env.DB.prepare(`
      INSERT INTO events (id, organizer_id, title, total_days, start_date, gate_pin, use_tiers, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(eventId, organizerId, cleanTitle, totalDays, startDate, pin, useTiers, tz).run();

    return json({
      ok: true,
      event: { id: eventId, title: cleanTitle, total_days: totalDays, start_date: startDate, gate_pin: pin, use_tiers: useTiers, timezone: tz }
    }, 200, origin);
  }

  return null;
}
