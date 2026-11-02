// Ticket writes: generate, assign names, inline edits, render marks, event reset.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { VALID_TIERS, MAX_TICKETS_PER_BATCH, EMAIL_RE } from "../config.js";
import { json } from "../lib/http.js";
import { generateRandomCode, getTierPrefix } from "../lib/util.js";
import { eventScope } from "../lib/scope.js";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // -----------------------------------------------------------------------
  // POST /api/generate -> Batch Creation with Credit Wallet Deductions
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/generate" && request.method === "POST") {
    const body = await request.json();
    const batches = Array.isArray(body.batches) ? body.batches : [];

    if (batches.length === 0 && body.count) {
      batches.push({
        count: body.count,
        tier: body.tier || "General",
        total_days: body.total_days || 1,
        allowed_days: body.allowed_days || [1]
      });
    }

    const event = await env.DB.prepare("SELECT id, total_days FROM events WHERE id = ? AND organizer_id = ?")
      .bind(body.event_id || "", organizerId).first();
    if (!event) {
      return json({ error: "Event not found. Select one of your events first." }, 404, origin);
    }

    // A batch may carry an attendee list (pasted or CSV-imported); one ticket per row
    for (const b of batches) {
      if (!Array.isArray(b.attendees)) continue;
      b.attendees = b.attendees.map(a => ({
        name: String(a?.name || "").trim().slice(0, 120),
        email: String(a?.email || "").trim().toLowerCase().slice(0, 254),
        phone: String(a?.phone || "").trim().slice(0, 20)
      }));
      const badRow = b.attendees.findIndex(a => a.email && !EMAIL_RE.test(a.email));
      if (badRow !== -1) {
        return json({ error: `Row ${badRow + 1}: '${b.attendees[badRow].email}' is not a valid email.` }, 400, origin);
      }
      b.count = b.attendees.length;
    }

    let totalTicketsToMake = 0;
    for (const b of batches) {
      const count = parseInt(b.count, 10) || 0;
      if (count < 0) return json({ error: "Ticket count cannot be negative." }, 400, origin);
      if (b.tier && !VALID_TIERS.includes(b.tier)) {
        return json({ error: `Unknown tier '${b.tier}'. Use VIP, General or Guestlist.` }, 400, origin);
      }
      totalTicketsToMake += count;
    }

    if (totalTicketsToMake === 0) {
      return json({ error: "Nothing to generate." }, 400, origin);
    }
    if (totalTicketsToMake > MAX_TICKETS_PER_BATCH) {
      return json({ error: `You can generate up to ${MAX_TICKETS_PER_BATCH} tickets per batch.` }, 400, origin);
    }

    // Guided tour: one free sample set per organizer, at most one blank ticket per tier, no credits spent
    const tour = body.tour === true;
    if (tour) {
      const used = batches.filter(b => (parseInt(b.count, 10) || 0) > 0);
      const tiers = used.map(b => b.tier || "General");
      if (used.some(b => b.attendees || parseInt(b.count, 10) > 1) || new Set(tiers).size !== tiers.length) {
        return json({ error: "Free tour tickets are limited to one blank ticket per tier." }, 400, origin);
      }
      // INSERT OR IGNORE is the one-time claim: a second request (or a replayed tour) changes nothing
      const grant = await env.DB.prepare("INSERT OR IGNORE INTO tour_grants (organizer_id) VALUES (?)").bind(organizerId).run();
      if (!grant.meta || grant.meta.changes === 0) {
        return json({ error: "Your free tour tickets were already made. Generate more with credits.", code: "TOUR_USED" }, 409, origin);
      }
    }

    // Reserve credits first; the conditional UPDATE can never drive the balance negative
    const reserve = tour ? { meta: { changes: 1 } } : await env.DB.prepare(
      "UPDATE organizers SET ticket_credits = ticket_credits - ? WHERE id = ? AND ticket_credits >= ?"
    ).bind(totalTicketsToMake, organizerId, totalTicketsToMake).run();

    if (!reserve.meta || reserve.meta.changes === 0) {
      const org = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
      const currentCredits = org ? org.ticket_credits : 0;
      return json({
        error: `Insufficient Ticket Credits! You have ${currentCredits} credits, but need ${totalTicketsToMake}. Please recharge your balance to generate this batch.`,
        code: "INSUFFICIENT_CREDITS",
        current_credits: currentCredits,
        needed_credits: totalTicketsToMake
      }, 402, origin);
    }

    const insertStatements = [];
    const createdList = [];

    for (const batch of batches) {
      const count = parseInt(batch.count, 10) || 0;
      const tier = batch.tier || "General";
      const prefix = getTierPrefix(tier);
      // A ticket can never cover more days than the event runs
      const totalDays = event.total_days;
      const allowedDaysStr = batch.allowed_days === "ALL"
        ? "ALL"
        : (Array.isArray(batch.allowed_days) ? batch.allowed_days : String(batch.allowed_days || "1").split(","))
            .map(d => parseInt(d, 10))
            .filter(d => d >= 1 && d <= totalDays)
            .join(",") || "1";

      for (let i = 0; i < count; i++) {
        const ticketId = `${prefix}-${generateRandomCode(8)}`;
        const person = batch.attendees ? batch.attendees[i] : { name: batch.attendee_name, email: batch.email, phone: batch.phone };
        insertStatements.push(
          env.DB.prepare(`
            INSERT INTO tickets (id, event_id, attendee_name, email, phone, tier, total_days, allowed_days, scanned_days, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'valid')
          `).bind(
            ticketId,
            event.id,
            person.name || "",
            person.email || "",
            person.phone || "",
            tier,
            totalDays,
            allowedDaysStr
          )
        );

        createdList.push({
          id: ticketId,
          attendee_name: person.name || "",
          email: person.email || "",
          tier,
          total_days: totalDays,
          allowed_days: allowedDaysStr,
          status: "Valid"
        });
      }
    }

    try {
      await env.DB.batch(insertStatements);
    } catch (err) {
      // Refund the reservation (or give the tour grant back) if the inserts failed (batch is all-or-nothing)
      await (tour
        ? env.DB.prepare("DELETE FROM tour_grants WHERE organizer_id = ?").bind(organizerId)
        : env.DB.prepare("UPDATE organizers SET ticket_credits = ticket_credits + ? WHERE id = ?").bind(totalTicketsToMake, organizerId)
      ).run();
      throw err;
    }

    const org = await env.DB.prepare("SELECT ticket_credits FROM organizers WHERE id = ?").bind(organizerId).first();
    return json({
      success: true,
      count: createdList.length,
      tickets: createdList,
      remaining_credits: org ? org.ticket_credits : 0
    }, 200, origin);
  }

  // -----------------------------------------------------------------------
  // POST /api/assign -> Put names on blank tickets the organizer already generated.
  // No credits are spent; each row takes one blank ticket of the matching tier and day scope.
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/assign" && request.method === "POST") {
    const body = await request.json();
    const event = await env.DB.prepare("SELECT id, total_days, use_tiers FROM events WHERE id = ? AND organizer_id = ?")
      .bind(body.event_id || "", organizerId).first();
    if (!event) return json({ ok: false, error: "Event not found. Select one of your events first." }, 404, origin);

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    if (rawRows.length === 0) return json({ ok: false, error: "Nothing to assign." }, 400, origin);
    if (rawRows.length > MAX_TICKETS_PER_BATCH) {
      return json({ ok: false, error: `You can assign up to ${MAX_TICKETS_PER_BATCH} tickets at a time.` }, 400, origin);
    }

    // Day scope as a canonical "1,2" string, or null for "any blank ticket"; never beyond the event's days
    const dayKey = (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (String(v).toUpperCase() === "ALL") return Array.from({ length: event.total_days }, (_, i) => i + 1).join(",");
      const days = [...new Set((Array.isArray(v) ? v : String(v).split(","))
        .map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= event.total_days))].sort((a, b) => a - b);
      return days.length ? days.join(",") : undefined;
    };
    const defaultKey = dayKey(body.allowed_days);
    if (defaultKey === undefined) {
      return json({ ok: false, error: `This event only runs ${event.total_days} day${event.total_days === 1 ? "" : "s"}.` }, 400, origin);
    }
    const defaultTier = VALID_TIERS.includes(body.tier) ? body.tier : null;

    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i] || {};
      const row = {
        name: String(r.name || "").trim().slice(0, 120),
        email: String(r.email || "").trim().toLowerCase().slice(0, 254),
        phone: String(r.phone || "").trim().slice(0, 20),
        tier: event.use_tiers ? (VALID_TIERS.includes(r.tier) ? r.tier : defaultTier) : null,
        key: r.days ? dayKey(r.days) : defaultKey
      };
      if (!row.name && !row.email) return json({ ok: false, error: `Row ${i + 1} has no name or email.` }, 400, origin);
      if (row.email && !EMAIL_RE.test(row.email)) {
        return json({ ok: false, error: `Row ${i + 1}: '${row.email}' is not a valid email.` }, 400, origin);
      }
      if (row.key === undefined) {
        return json({ ok: false, error: `Row ${i + 1}: this event only runs ${event.total_days} day${event.total_days === 1 ? "" : "s"}.` }, 400, origin);
      }
      rows.push(row);
    }

    const blanks = (await env.DB.prepare(`
      SELECT id, tier, allowed_days FROM tickets
      WHERE event_id = ? AND attendee_name = '' AND COALESCE(email, '') = '' AND status = 'valid'
      ORDER BY created_at, id LIMIT 5000
    `).bind(event.id).all()).results || [];
    for (const b of blanks) b.key = dayKey(b.allowed_days) || "";

    const taken = new Set();
    const picks = [];
    const short = {};
    for (const row of rows) {
      const match = blanks.find(b => !taken.has(b.id) && (!row.tier || b.tier === row.tier) && (row.key === null || b.key === row.key));
      if (!match) {
        const label = [row.tier, row.key ? `day${row.key.includes(",") ? "s" : ""} ${row.key}` : ""].filter(Boolean).join(", ") || "any";
        short[label] = (short[label] || 0) + 1;
        continue;
      }
      taken.add(match.id);
      picks.push({ id: match.id, tier: match.tier, row });
    }
    if (Object.keys(short).length) {
      const detail = Object.entries(short).map(([k, n]) => `${n} more (${k})`).join("; ");
      return json({
        ok: false,
        error: `Not enough blank tickets. Generate ${detail} first.`,
        code: "NOT_ENOUGH_BLANKS",
        short
      }, 409, origin);
    }

    // Preview: report which blank ticket each row would take, without writing anything
    if (body.dry_run === true) {
      return json({
        ok: true,
        dry_run: true,
        assigned: picks.length,
        tickets: picks.map(p => ({ id: p.id, tier: p.tier, attendee_name: p.row.name, email: p.row.email }))
      }, 200, origin);
    }

    await env.DB.batch(picks.map(p => env.DB.prepare(`
      UPDATE tickets SET attendee_name = ?, email = ?, phone = ?
      WHERE id = ? AND attendee_name = '' AND COALESCE(email, '') = ''
    `).bind(p.row.name, p.row.email, p.row.phone, p.id)));

    return json({
      ok: true,
      assigned: picks.length,
      tickets: picks.map(p => ({ id: p.id, tier: p.tier, attendee_name: p.row.name, email: p.row.email }))
    }, 200, origin);
  }

  // -----------------------------------------------------------------------
  // POST /api/save-attendee -> Attendee Record Update
  // -----------------------------------------------------------------------
  if ((url.pathname === "/api/save-attendee" || url.pathname === "/api/save-email") && request.method === "POST") {
    const { ticketId, attendee_name, email, phone, tier } = await request.json();
    if (!ticketId) {
      return json({ error: "Missing ticketId" }, 400, origin);
    }
    if (tier && !VALID_TIERS.includes(tier)) {
      return json({ error: `Unknown tier '${tier}'.` }, 400, origin);
    }

    const result = await env.DB.prepare(`
      UPDATE tickets
      SET attendee_name = COALESCE(?, attendee_name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          tier = COALESCE(?, tier)
      WHERE id = ? AND event_id IN (SELECT id FROM events WHERE organizer_id = ?)
    `).bind(attendee_name || null, email || null, phone || null, tier || null, ticketId, organizerId).run();

    if (!result.meta || result.meta.changes === 0) {
      return json({ error: "Ticket not found" }, 404, origin);
    }
    return json({ success: true }, 200, origin);
  }

  // -----------------------------------------------------------------------
  // POST /api/mark-rendered -> Record that pass images were exported
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/mark-rendered" && request.method === "POST") {
    const { ticketIds } = await request.json();
    const ids = (Array.isArray(ticketIds) ? ticketIds : []).map(String).slice(0, MAX_TICKETS_PER_BATCH);
    if (ids.length === 0) return json({ error: "ticketIds is required." }, 400, origin);
    const stmts = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      stmts.push(env.DB.prepare(`
        UPDATE tickets SET rendered_at = CURRENT_TIMESTAMP
        WHERE id IN (${chunk.map(() => "?").join(",")}) AND event_id IN (SELECT id FROM events WHERE organizer_id = ?)
      `).bind(...chunk, organizerId));
    }
    await env.DB.batch(stmts);
    return json({ success: true }, 200, origin);
  }

  // -----------------------------------------------------------------------
  // POST /api/reset-db -> Event Database Reset (organizer's own events only)
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/reset-db" && request.method === "POST") {
    const { mode, confirm, event_id } = await request.json();

    if (confirm !== "CONFIRM_RESET") {
      return json({ error: "Safety check failed. Confirmation string 'CONFIRM_RESET' required." }, 400, origin);
    }
    if (!event_id) {
      return json({ error: "event_id is required." }, 400, origin);
    }

    const scope = eventScope(event_id, organizerId);

    if (mode === "wipe_all") {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
        env.DB.prepare(`DELETE FROM tickets WHERE ${scope.sql}`).bind(...scope.params)
      ]);
      return json({ success: true, mode: "wipe_all", message: "Database completely wiped for this event." }, 200, origin);
    } else if (mode === "reset_scans") {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM scan_logs WHERE ${scope.sql}`).bind(...scope.params),
        env.DB.prepare(`UPDATE tickets SET status = 'valid', scanned_days = '' WHERE status != 'revoked' AND ${scope.sql}`).bind(...scope.params)
      ]);
      return json({ success: true, mode: "reset_scans", message: "Reset all tickets back to 'Valid' status." }, 200, origin);
    }
    return json({ error: "Unknown mode. Use 'wipe_all' or 'reset_scans'." }, 400, origin);
  }

  return null;
}
