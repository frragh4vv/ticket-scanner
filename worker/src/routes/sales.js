// Organizer side of selling: ticket types per event, the public booking page slug, and the orders list.

import { VALID_TIERS, EMAIL_RE } from "../config.js";
import { json } from "../lib/http.js";
import { generateRandomCode, parseDays } from "../lib/util.js";
import { releaseExpired } from "../lib/orders.js";
import { INFO_FIELDS } from "../lib/eventinfo.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const JPEG_PREFIX = "data:image/jpeg;base64,";
const MAX_COVER_CHARS = 800_000;   // ~600 KB of JPEG; the page asks the browser to downscale first
const INFO_MAX = { start_time: 5, end_time: 5, venue: 120, address: 240, map_url: 500, about: 3000, host_name: 80, contact_email: 254, contact_phone: 20 };

async function ownedEvent(env, eventId, organizerId) {
  return env.DB.prepare("SELECT id, total_days FROM events WHERE id = ? AND organizer_id = ?").bind(eventId || "", organizerId).first();
}

function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;
  const path = url.pathname;

  // GET /api/ticket-types?event_id= -> types with live stock, plus the booking page slug
  if (path === "/api/ticket-types" && request.method === "GET") {
    const event = await ownedEvent(env, url.searchParams.get("event_id"), organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);
    const { results: types } = await env.DB.prepare("SELECT id FROM ticket_types WHERE event_id = ?").bind(event.id).all();
    for (const t of types) await releaseExpired(env, t.id);
    const list = await env.DB.prepare(
      "SELECT id, name, description, tier, price_paise, quantity, held, sold, allowed_days, sales_start, sales_end, active FROM ticket_types WHERE event_id = ? ORDER BY created_at"
    ).bind(event.id).all();
    const page = await env.DB.prepare("SELECT slug, enabled FROM event_pages WHERE event_id = ?").bind(event.id).first();
    const info = await env.DB.prepare(
      `SELECT ${INFO_FIELDS.join(", ")}, cover IS NOT NULL AS has_cover FROM event_info WHERE event_id = ?`
    ).bind(event.id).first();
    return json({ ok: true, types: list.results, page: page || null, info: info || null, total_days: event.total_days }, 200, origin);
  }

  // PUT /api/event-info { event_id, venue, about, ... } -> booking page details (text only; cover has its own route)
  if (path === "/api/event-info" && request.method === "PUT") {
    const b = await request.json();
    const event = await ownedEvent(env, b.event_id, organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);
    const v = {};
    for (const f of INFO_FIELDS) v[f] = String(b[f] ?? "").trim().slice(0, INFO_MAX[f]);
    for (const f of ["start_time", "end_time"]) {
      if (v[f] && !TIME_RE.test(v[f])) return json({ error: "Times must look like 18:30." }, 400, origin);
    }
    if (v.map_url && !/^https:\/\/\S+$/.test(v.map_url)) return json({ error: "Map link must start with https://" }, 400, origin);
    if (v.contact_email && !EMAIL_RE.test(v.contact_email)) return json({ error: "Contact email doesn't look right." }, 400, origin);
    await env.DB.prepare(`
      INSERT INTO event_info (event_id, organizer_id, ${INFO_FIELDS.join(", ")}, updated_at)
      VALUES (?, ?, ${INFO_FIELDS.map(() => "?").join(", ")}, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET ${INFO_FIELDS.map(f => `${f} = excluded.${f}`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    `).bind(event.id, organizerId, ...INFO_FIELDS.map(f => v[f])).run();
    return json({ ok: true }, 200, origin);
  }

  // GET ?event_id= -> { image } | PUT { event_id, image } -> save downscaled JPEG banner | DELETE ?event_id= -> remove
  if (path === "/api/event-info/cover" && ["GET", "PUT", "DELETE"].includes(request.method)) {
    const b = request.method === "PUT" ? await request.json() : { event_id: url.searchParams.get("event_id") };
    const event = await ownedEvent(env, b.event_id, organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT cover FROM event_info WHERE event_id = ?").bind(event.id).first();
      if (!row || !row.cover) return json({ error: "No cover" }, 404, origin);
      return json({ ok: true, image: row.cover }, 200, origin);
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("UPDATE event_info SET cover = NULL, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?").bind(event.id).run();
      return json({ ok: true }, 200, origin);
    }
    const image = b.image;
    if (typeof image !== "string" || !image.startsWith(JPEG_PREFIX) || image.length > MAX_COVER_CHARS) {
      return json({ error: "Cover must be a JPEG under about 600 KB." }, 400, origin);
    }
    await env.DB.prepare(`
      INSERT INTO event_info (event_id, organizer_id, cover, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET cover = excluded.cover, updated_at = CURRENT_TIMESTAMP
    `).bind(event.id, organizerId, image).run();
    return json({ ok: true }, 200, origin);
  }

  // PUT /api/ticket-types -> create or update one type
  if (path === "/api/ticket-types" && request.method === "PUT") {
    const b = await request.json();
    const event = await ownedEvent(env, b.event_id, organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);

    const name = String(b.name || "").trim().slice(0, 80);
    const description = String(b.description || "").trim().slice(0, 300);
    const price = Math.round(Number(b.price_inr) * 100);
    const quantity = parseInt(b.quantity, 10);
    const salesStart = isoOrNull(b.sales_start);
    const salesEnd = isoOrNull(b.sales_end);
    if (!name) return json({ error: "Give the ticket type a name." }, 400, origin);
    if (!VALID_TIERS.includes(b.tier)) return json({ error: "Tier must be VIP, General or Guestlist." }, 400, origin);
    if (!Number.isFinite(price) || price < 100) return json({ error: "Price must be at least ₹1." }, 400, origin);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000) return json({ error: "Quantity must be a whole number." }, 400, origin);
    if (salesStart === undefined || salesEnd === undefined) return json({ error: "Sale dates are not valid." }, 400, origin);
    const days = b.allowed_days === "ALL" || !b.allowed_days
      ? "ALL"
      : parseDays(String(b.allowed_days), event.total_days).filter(d => d >= 1 && d <= event.total_days).join(",") || "ALL";

    if (b.id) {
      const cur = await env.DB.prepare("SELECT held, sold FROM ticket_types WHERE id = ? AND event_id = ?").bind(b.id, event.id).first();
      if (!cur) return json({ error: "Ticket type not found" }, 404, origin);
      if (quantity < cur.held + cur.sold) {
        return json({ error: `${cur.held + cur.sold} are already sold or held, so quantity can't go below that.` }, 409, origin);
      }
      // A price change would break orders already created at the old price, so it only applies to new orders
      await env.DB.prepare(`
        UPDATE ticket_types SET name = ?, description = ?, tier = ?, price_paise = ?, quantity = ?, allowed_days = ?,
          sales_start = ?, sales_end = ?, active = ? WHERE id = ? AND event_id = ?
      `).bind(name, description, b.tier, price, quantity, days, salesStart, salesEnd, b.active === false ? 0 : 1, b.id, event.id).run();
      return json({ ok: true, id: b.id }, 200, origin);
    }

    const id = `tt_${generateRandomCode(10).toLowerCase()}`;
    await env.DB.prepare(`
      INSERT INTO ticket_types (id, event_id, organizer_id, name, description, tier, price_paise, quantity, allowed_days, sales_start, sales_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, event.id, organizerId, name, description, b.tier, price, quantity, days, salesStart, salesEnd).run();
    return json({ ok: true, id }, 200, origin);
  }

  // DELETE /api/ticket-types?id= -> delete if never ordered, otherwise just stop selling it
  if (path === "/api/ticket-types" && request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    const type = await env.DB.prepare("SELECT id FROM ticket_types WHERE id = ? AND organizer_id = ?").bind(id, organizerId).first();
    if (!type) return json({ error: "Ticket type not found" }, 404, origin);
    const used = await env.DB.prepare("SELECT 1 AS n FROM orders WHERE ticket_type_id = ? LIMIT 1").bind(id).first();
    if (used) {
      await env.DB.prepare("UPDATE ticket_types SET active = 0 WHERE id = ?").bind(id).run();
      return json({ ok: true, deactivated: true }, 200, origin);
    }
    await env.DB.prepare("DELETE FROM ticket_types WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200, origin);
  }

  // PUT /api/event-page { event_id, slug, enabled } -> the public link /e/<slug>
  if (path === "/api/event-page" && request.method === "PUT") {
    const b = await request.json();
    const event = await ownedEvent(env, b.event_id, organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);
    const slug = String(b.slug || "").trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return json({ error: "Link name: 3-40 letters, numbers or dashes." }, 400, origin);
    try {
      await env.DB.prepare(`
        INSERT INTO event_pages (event_id, organizer_id, slug, enabled) VALUES (?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET slug = excluded.slug, enabled = excluded.enabled
      `).bind(event.id, organizerId, slug, b.enabled === false ? 0 : 1).run();
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return json({ error: "That link name is taken. Try another." }, 409, origin);
      throw err;
    }
    return json({ ok: true, slug }, 200, origin);
  }

  // GET /api/orders?event_id= -> latest 100 buyer orders
  if (path === "/api/orders" && request.method === "GET") {
    const event = await ownedEvent(env, url.searchParams.get("event_id"), organizerId);
    if (!event) return json({ error: "Event not found" }, 404, origin);
    const { results } = await env.DB.prepare(`
      SELECT o.id, o.status, o.qty, o.amount_paise, o.buyer_name, o.buyer_email, o.rzp_payment_id, o.created_at, o.issued_at, t.name AS type_name
      FROM orders o JOIN ticket_types t ON t.id = o.ticket_type_id
      WHERE o.event_id = ? ORDER BY o.created_at DESC LIMIT 100
    `).bind(event.id).all();
    return json({ ok: true, orders: results }, 200, origin);
  }

  return null;
}
