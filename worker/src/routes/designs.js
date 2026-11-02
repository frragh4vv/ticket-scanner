// Ticket studio design per event (layout JSON + background artwork), kept server side so passes can be
// drawn from any browser and, later, by buyer-triggered flows. Organizer-only.
// Artwork lives in D1 as a downscaled JPEG data URL for now; swap the two artwork queries for R2 put/get when R2 is enabled.

import { json } from "../lib/http.js";

const MAX_LAYOUT_CHARS = 8000;
const MAX_ARTWORK_CHARS = 1_600_000;   // ~1.2 MB of JPEG, comfortably under D1's 2 MB row limit
const JPEG_PREFIX = "data:image/jpeg;base64,";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;
  if (!url.pathname.startsWith("/api/designs")) return null;

  const eventId = url.searchParams.get("event_id") || "";
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND organizer_id = ?").bind(eventId, organizerId).first();
  if (!event) return json({ error: "Event not found" }, 404, origin);

  // GET /api/designs?event_id= -> { layout, has_artwork }
  if (url.pathname === "/api/designs" && request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT layout_json, artwork IS NOT NULL AS has_artwork, updated_at FROM event_designs WHERE event_id = ?"
    ).bind(eventId).first();
    if (!row) return json({ ok: true, layout: null, has_artwork: false }, 200, origin);
    let layout = null;
    try { layout = row.layout_json ? JSON.parse(row.layout_json) : null; } catch (_) {}
    return json({ ok: true, layout, has_artwork: !!row.has_artwork, updated_at: row.updated_at }, 200, origin);
  }

  // PUT /api/designs?event_id= { layout } -> save the layout (positions, sizes, colours, layer toggles)
  if (url.pathname === "/api/designs" && request.method === "PUT") {
    const { layout } = await request.json();
    const text = JSON.stringify(layout || null);
    if (!layout || typeof layout !== "object" || text.length > MAX_LAYOUT_CHARS) {
      return json({ error: "Invalid layout" }, 400, origin);
    }
    await env.DB.prepare(`
      INSERT INTO event_designs (event_id, organizer_id, layout_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = CURRENT_TIMESTAMP
    `).bind(eventId, organizerId, text).run();
    return json({ ok: true }, 200, origin);
  }

  // GET /api/designs/artwork?event_id= -> { image: "data:image/jpeg;base64,..." }
  if (url.pathname === "/api/designs/artwork" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT artwork FROM event_designs WHERE event_id = ?").bind(eventId).first();
    if (!row || !row.artwork) return json({ error: "No artwork" }, 404, origin);
    return json({ ok: true, image: row.artwork }, 200, origin);
  }

  // PUT /api/designs/artwork?event_id= { image } -> save the downscaled JPEG background
  if (url.pathname === "/api/designs/artwork" && request.method === "PUT") {
    const { image } = await request.json();
    if (typeof image !== "string" || !image.startsWith(JPEG_PREFIX) || image.length > MAX_ARTWORK_CHARS) {
      return json({ error: "Artwork must be a JPEG under about 1.2 MB." }, 400, origin);
    }
    await env.DB.prepare(`
      INSERT INTO event_designs (event_id, organizer_id, artwork, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET artwork = excluded.artwork, updated_at = CURRENT_TIMESTAMP
    `).bind(eventId, organizerId, image).run();
    return json({ ok: true }, 200, origin);
  }

  // DELETE /api/designs/artwork?event_id= -> remove the background
  if (url.pathname === "/api/designs/artwork" && request.method === "DELETE") {
    await env.DB.prepare("UPDATE event_designs SET artwork = NULL, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?").bind(eventId).run();
    return json({ ok: true }, 200, origin);
  }

  return null;
}
