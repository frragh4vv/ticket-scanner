// Gate scan: POST /api/check. Works with gate and organizer sessions.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { json } from "../lib/http.js";
import { parseDays } from "../lib/util.js";
import { eventDayNow } from "../lib/eventday.js";

export async function handle(ctx) {
  const { request, env, url, origin, session, organizerId } = ctx;

  // -----------------------------------------------------------------------
  // POST /api/check -> Atomic Multi-Day Verification (admin or gate sessions)
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/check" && request.method === "POST") {
    const { ticketId, scannerName, eventDay: rawEventDay, allowReEntry } = await request.json();
    const cleanTicketId = (ticketId || "").trim();

    if (!cleanTicketId) {
      return json({ error: "Missing ticketId" }, 400, origin);
    }

    const ticket = await env.DB.prepare(`
      SELECT t.*, e.start_date AS event_start, e.total_days AS event_days, e.timezone AS event_tz
      FROM tickets t JOIN events e ON e.id = t.event_id
      WHERE t.id = ? AND e.organizer_id = ?
    `).bind(cleanTicketId, organizerId).first();

    // Gate sessions only see tickets for their own event
    if (!ticket || (session.role === "gate" && ticket.event_id !== session.evt)) {
      return json({
        result: "notfound",
        message: "TICKET NOT FOUND\nNot in system.",
        ticket: { id: cleanTicketId }
      }, 200, origin);
    }

    if (ticket.status === "revoked") {
      return json({
        result: "invalid",
        message: "REVOKED PASS\nDo not admit attendee.",
        ticket: { id: cleanTicketId, tier: ticket.tier, attendee_name: ticket.attendee_name, status: "revoked" }
      }, 200, origin);
    }

    // The day comes from the event's start date, not the scanner. Gates are held to the event
    // dates; organizers may scan outside them (rehearsals) using the day their scanner sends.
    const today = eventDayNow(ticket.event_start, ticket.event_days, ticket.event_tz);
    const clientDay = Math.max(1, Math.min(10, parseInt(rawEventDay, 10) || 1));
    if (today && (today.before || today.after) && session.role === "gate") {
      return json({
        result: "wrong_day",
        message: today.before
          ? `EVENT HASN'T STARTED\nStarts ${ticket.event_start}`
          : "EVENT HAS ENDED\nThis pass is no longer valid.",
        ticket: { id: cleanTicketId, tier: ticket.tier, attendee_name: ticket.attendee_name, status: ticket.status },
        eventDay: today.day
      }, 200, origin);
    }
    const eventDay = today && !today.before && !today.after ? today.day : clientDay;

    // Compute Allowed & Scanned Days
    const totalDays = ticket.total_days || 1;
    const allowedDays = parseDays(ticket.allowed_days || "1", totalDays);
    const scannedDaysList = parseDays(ticket.scanned_days, totalDays);
    const isAlreadyScannedToday = scannedDaysList.includes(eventDay);

    const duplicateResponse = (daysUsed) => json({
      result: "duplicate",
      message: `ALREADY SCANNED TODAY (Day ${eventDay})`,
      ticket: {
        id: cleanTicketId,
        tier: ticket.tier,
        attendee_name: ticket.attendee_name,
        email: ticket.email || "",
        status: "scanned",
        day_scanned: eventDay,
        total_days: totalDays,
        allowed_days: allowedDays,
        days_used: daysUsed
      },
      eventDay
    }, 200, origin);

    // 1. Day Authorization Check
    if (!allowedDays.includes(eventDay)) {
      return json({
        result: "wrong_day",
        message: `WRONG EVENT DAY\nTicket valid for Day(s): ${allowedDays.join(", ")}\nCurrent scanner: Day ${eventDay}`,
        ticket: {
          id: cleanTicketId,
          tier: ticket.tier,
          attendee_name: ticket.attendee_name,
          total_days: totalDays,
          allowed_days: allowedDays,
          days_used: scannedDaysList.length,
          status: ticket.status
        },
        eventDay,
        allowedDays
      }, 200, origin);
    }

    // 2. Duplicate Turnstile Prevention
    if (isAlreadyScannedToday && !allowReEntry) {
      return duplicateResponse(scannedDaysList.length);
    }

    // 3. Atomic compare-and-set: only succeeds if no other gate changed scanned_days since our read
    const isReEntry = isAlreadyScannedToday && allowReEntry;
    if (!isAlreadyScannedToday) {
      scannedDaysList.push(eventDay);
    }

    const newScannedDaysStr = scannedDaysList.sort((a, b) => a - b).join(",");
    const allUsed = allowedDays.every(d => scannedDaysList.includes(d));
    const newStatus = allUsed ? "scanned" : "valid";

    if (!isReEntry) {
      const update = await env.DB.prepare(
        "UPDATE tickets SET scanned_days = ?, status = ? WHERE id = ? AND COALESCE(scanned_days, '') = ? AND status != 'revoked'"
      ).bind(newScannedDaysStr, newStatus, cleanTicketId, ticket.scanned_days || "").run();

      if (!update.meta || update.meta.changes === 0) {
        // Another gate admitted this ticket a moment ago
        return duplicateResponse(scannedDaysList.length);
      }
    }

    await env.DB.prepare("INSERT INTO scan_logs (ticket_id, event_id, scanned_day, gate_device_id) VALUES (?, ?, ?, ?)")
      .bind(cleanTicketId, ticket.event_id, eventDay, String(scannerName || "Gate-1").slice(0, 60)).run();

    const passTypeName = totalDays > 1 ? `${totalDays}-Day Pass` : "Single Day Pass";

    return json({
      result: "valid",
      message: isReEntry
        ? `RE-ENTRY APPROVED (Day ${eventDay})`
        : allUsed
          ? `ENTRY APPROVED • DAY ${eventDay} (Final Day)`
          : `ENTRY APPROVED • DAY ${eventDay} (${scannedDaysList.length}/${allowedDays.length} Days Used)`,
      isReEntry: !!isReEntry,
      ticket: {
        id: cleanTicketId,
        tier: ticket.tier,
        attendee_name: ticket.attendee_name,
        email: ticket.email || "",
        status: newStatus,
        total_days: totalDays,
        allowed_days: allowedDays,
        days_used: scannedDaysList.length,
        pass_type_name: passTypeName
      },
      eventDay,
      daysUsed: scannedDaysList.length,
      totalDays,
      allDaysUsed: allUsed
    }, 200, origin);
  }
  return null;
}
