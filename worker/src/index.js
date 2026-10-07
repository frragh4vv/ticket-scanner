// 🎟️ Production-Grade Cloudflare Workers API for Ticket Scanner & Generator
// Concurrency-Safe Check-Ins (ETag Atomic Lock), Multi-Tier passes, Database Management.

const ALLOWED_HEADERS = "Content-Type, Authorization";
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

function generateRandomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Ambiguity-free charset (no 0/O, 1/I)
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

function getTierPrefix(tier) {
  const normalized = (tier || "general").toLowerCase();
  if (normalized.includes("vip")) return "VIP";
  if (normalized.includes("guest") || normalized.includes("list")) return "GST";
  return "GEN";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: getCorsHeaders(origin),
      });
    }

    try {
      const url = new URL(request.url);

      const authHeader = request.headers.get("Authorization");
      const urlToken = url.searchParams.get("token");
      const expectedToken = env.SCANNER_ACCESS_KEY || "Raghav@ticket";

      // =========================================================================
      // /api/auth-verify -> Check if entered passkey is valid (No bare HTML keys)
      // =========================================================================
      if (url.pathname === "/api/auth-verify") {
        let sentToken = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
          sentToken = authHeader.slice(7).trim();
        } else if (authHeader) {
          sentToken = authHeader.trim();
        } else if (urlToken) {
          sentToken = urlToken.trim();
        } else if (request.method === "POST") {
          try {
            const body = await request.clone().json();
            if (body && body.key) sentToken = body.key.trim();
          } catch (_) {}
        }

        if (sentToken === expectedToken) {
          return new Response(JSON.stringify({ ok: true, role: "admin", token: expectedToken }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }
        return new Response(JSON.stringify({ ok: false, error: "Invalid access key" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // 1b. Serve Static Assets (HTML/CSS/JS) if not an /api/ route
      if (!url.pathname.startsWith("/api/")) {
        if (env.ASSETS) {
          return env.ASSETS.fetch(request);
        }
      }

      // 2. Enforce Authentication Header for all /api/* routes
      const isAuthorized =
        (authHeader && (authHeader === `Bearer ${expectedToken}` || authHeader === expectedToken)) ||
        (urlToken && urlToken === expectedToken);

      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: "Unauthorized access" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      const fbSecret = env.FIREBASE_SECRET || "I1TjmOF25HJqMtcwtoVGGWvivr5MS3toT2yibcQV";
      const fbUrl = env.FIREBASE_URL || "https://ticketsqr1-default-rtdb.asia-southeast1.firebasedatabase.app";

      // =========================================================================
      // =========================================================================
      // POST /api/check -> Concurrency-Safe Atomic Multi-Day Ticket Validation
      // Uses Firebase X-Firebase-ETag and if-match header to prevent TOCTOU race conditions
      // Supports multi-day events up to 10 days with per-day scan tracking & re-entry
      // =========================================================================
      if (url.pathname === "/api/check" && request.method === "POST") {
        const { ticketId, scannerName, eventDay: rawEventDay, allowReEntry } = await request.json();
        const cleanTicketId = (ticketId || "").trim();
        const eventDay = Math.max(1, Math.min(10, parseInt(rawEventDay, 10) || 1));

        if (!cleanTicketId || !scannerName) {
          return new Response(JSON.stringify({ error: "Missing ticketId or scannerName" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // Fetch ticket from Firebase with ETag
        const res = await fetch(`${fbUrl}/tickets/${encodeURIComponent(cleanTicketId)}.json?auth=${fbSecret}`, {
          headers: { "X-Firebase-ETag": "true" }
        });

        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({ error: "Database error", details: errText }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const etag = res.headers.get("etag");
        const ticket = await res.json();

        if (!ticket) {
          return new Response(JSON.stringify({
            result: "notfound",
            message: "TICKET NOT FOUND\nNot in system.",
            ticket: { id: cleanTicketId }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const tier = ticket.tier || "General";
        const attendeeName = ticket.attendee_name || "";

        // Explicitly revoked
        if (ticket.status === "Revoked") {
          return new Response(JSON.stringify({
            result: "invalid",
            message: "REVOKED PASS\nDo not admit attendee.",
            ticket: {
              id: cleanTicketId,
              tier: tier,
              attendee_name: attendeeName,
              status: "Revoked"
            }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // Normalize multi-day configuration (backward-compatible with legacy single-day passes)
        const totalDays = Math.max(1, Math.min(10, parseInt(ticket.total_days, 10) || 1));
        let allowedDays = Array.isArray(ticket.allowed_days) && ticket.allowed_days.length > 0
          ? ticket.allowed_days.map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 10)
          : [];

        if (allowedDays.length === 0) {
          allowedDays = totalDays > 1
            ? Array.from({ length: totalDays }, (_, i) => i + 1)
            : [1];
        }

        const dailyScans = ticket.daily_scans && typeof ticket.daily_scans === "object"
          ? { ...ticket.daily_scans }
          : {};

        // Backwards compatibility for legacy tickets scanned on single-day event
        if (ticket.status === "Scanned" && !dailyScans["day_1"]) {
          dailyScans["day_1"] = {
            scanned: true,
            scanned_by: ticket.scanned_by || "Legacy Gate",
            scan_time: ticket.scan_time || "Earlier",
            scan_timestamp: ticket.scan_timestamp || null
          };
        }

        // 1. Check Day Access Authorization: Is this pass valid for today?
        if (!allowedDays.includes(eventDay)) {
          return new Response(JSON.stringify({
            result: "wrong_day",
            message: `WRONG EVENT DAY\nTicket valid for Day(s): ${allowedDays.join(", ")}\nCurrent scanner: Day ${eventDay}`,
            ticket: {
              id: cleanTicketId,
              tier: tier,
              attendee_name: attendeeName,
              total_days: totalDays,
              allowed_days: allowedDays,
              days_used: ticket.days_used || 0,
              status: ticket.status || "Valid",
              daily_scans: dailyScans
            },
            eventDay: eventDay,
            allowedDays: allowedDays
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // 2. Check Day Status: Has it already been scanned for today?
        const dayKey = `day_${eventDay}`;
        const dayScan = dailyScans[dayKey];
        const isAlreadyScannedToday = !!(dayScan && dayScan.scanned);

        if (isAlreadyScannedToday && !allowReEntry) {
          const usedDaysCount = allowedDays.filter(d => dailyScans[`day_${d}`] && dailyScans[`day_${d}`].scanned).length;
          return new Response(JSON.stringify({
            result: "duplicate",
            message: `ALREADY SCANNED TODAY (Day ${eventDay})`,
            ticket: {
              id: cleanTicketId,
              tier: tier,
              attendee_name: attendeeName,
              email: ticket.email || "",
              status: ticket.status || "Scanned",
              scanned_by: dayScan.scanned_by || ticket.scanned_by || "Unknown Gate",
              scan_time: dayScan.scan_time || ticket.scan_time || "Earlier",
              day_scanned: eventDay,
              total_days: totalDays,
              allowed_days: allowedDays,
              days_used: usedDaysCount,
              daily_scans: dailyScans
            },
            eventDay: eventDay,
            dailyScans: dailyScans
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // 3. Perform Concurrency-Safe Scan Check-In for this Day
        const now = new Date();
        const scanTime = now.toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "medium",
          timeStyle: "medium"
        });
        const isoTimestamp = now.toISOString();

        const isReEntry = isAlreadyScannedToday && allowReEntry;
        const reEntries = (dayScan && Array.isArray(dayScan.reentries)) ? [...dayScan.reentries] : [];
        if (isReEntry) {
          reEntries.push({
            scanned_by: scannerName,
            scan_time: scanTime,
            scan_timestamp: isoTimestamp
          });
        }

        dailyScans[dayKey] = {
          scanned: true,
          scanned_by: isReEntry ? dayScan.scanned_by : scannerName,
          scan_time: isReEntry ? dayScan.scan_time : scanTime,
          scan_timestamp: isReEntry ? dayScan.scan_timestamp : isoTimestamp,
          reentries: reEntries,
          last_reentry_by: isReEntry ? scannerName : undefined,
          last_reentry_time: isReEntry ? scanTime : undefined
        };

        const usedDaysCount = allowedDays.filter(d => dailyScans[`day_${d}`] && dailyScans[`day_${d}`].scanned).length;
        const allDaysUsed = usedDaysCount >= allowedDays.length;

        // Atomic conditional update using ETag
        const updatedTicket = {
          ...ticket,
          total_days: totalDays,
          allowed_days: allowedDays,
          daily_scans: dailyScans,
          days_used: usedDaysCount,
          status: allDaysUsed ? "Completed" : "Valid",
          scanned_by: scannerName,
          scan_time: scanTime,
          scan_timestamp: isoTimestamp
        };

        const updateHeaders = { "Content-Type": "application/json" };
        if (etag) updateHeaders["if-match"] = etag;

        const updateRes = await fetch(`${fbUrl}/tickets/${encodeURIComponent(cleanTicketId)}.json?auth=${fbSecret}`, {
          method: "PUT",
          headers: updateHeaders,
          body: JSON.stringify(updatedTicket)
        });

        // Check if another scanner grabbed this ticket simultaneously
        if (updateRes.status === 412) {
          return new Response(JSON.stringify({
            result: "duplicate",
            message: `ALREADY SCANNED TODAY (Day ${eventDay})\nSimultaneous double-entry prevented!`,
            ticket: {
              id: cleanTicketId,
              tier: tier,
              attendee_name: attendeeName,
              status: "Scanned",
              scanned_by: "Another Gate",
              scan_time: "Just now",
              daily_scans: dailyScans
            }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        if (!updateRes.ok) {
          const errDetail = await updateRes.text();
          return new Response(JSON.stringify({ error: "Check-in save failed", details: errDetail }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const passTypeName = ticket.pass_type_name || (totalDays > 1 ? `${totalDays}-Day Pass` : "Single Day Pass");

        return new Response(JSON.stringify({
          result: "valid",
          message: isReEntry
            ? `RE-ENTRY APPROVED (Day ${eventDay})`
            : allDaysUsed
              ? `ENTRY APPROVED • DAY ${eventDay} (Final Day)`
              : `ENTRY APPROVED • DAY ${eventDay} (${usedDaysCount}/${allowedDays.length} Days Used)`,
          isReEntry: !!isReEntry,
          ticket: {
            id: cleanTicketId,
            tier: tier,
            attendee_name: attendeeName,
            email: ticket.email || "",
            status: updatedTicket.status,
            scanned_by: scannerName,
            scan_time: scanTime,
            notes: ticket.notes || "",
            total_days: totalDays,
            allowed_days: allowedDays,
            days_used: usedDaysCount,
            pass_type_name: passTypeName
          },
          daily_scans: dailyScans,
          eventDay: eventDay,
          daysUsed: usedDaysCount,
          totalDays: totalDays,
          allDaysUsed: allDaysUsed
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // GET /api/tickets -> Query tickets
      // =========================================================================
      if (url.pathname === "/api/tickets" && request.method === "GET") {
        const res = await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`);
        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({ error: "Database error", details: errText }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const data = await res.json();
        return new Response(JSON.stringify(data || {}), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // GET /api/stats -> Live Metrics & Tier Breakdown
      // =========================================================================
      if (url.pathname === "/api/stats" && request.method === "GET") {
        const res = await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`);
        const data = await res.json();

        let total = 0;
        let scanned = 0;
        let valid = 0;
        let multiDayCount = 0;
        const tiers = {
          VIP: { total: 0, scanned: 0 },
          General: { total: 0, scanned: 0 },
          Guestlist: { total: 0, scanned: 0 }
        };
        const scansByDay = {};
        for (let d = 1; d <= 10; d++) scansByDay[`day_${d}`] = 0;
        const recentScans = [];

        if (data && typeof data === "object" && !data.error) {
          for (const [id, t] of Object.entries(data)) {
            total++;
            const tTier = t.tier || "General";
            if (!tiers[tTier]) tiers[tTier] = { total: 0, scanned: 0 };
            tiers[tTier].total++;

            const totalDays = t.total_days || 1;
            if (totalDays > 1) multiDayCount++;

            // Track daily scans
            if (t.daily_scans && typeof t.daily_scans === "object") {
              for (const [dKey, dRec] of Object.entries(t.daily_scans)) {
                if (dRec && dRec.scanned) {
                  scansByDay[dKey] = (scansByDay[dKey] || 0) + 1;
                }
              }
            } else if (t.status === "Scanned") {
              scansByDay["day_1"] = (scansByDay["day_1"] || 0) + 1;
            }

            const isScanned = t.status === "Scanned" || t.status === "Completed" || (t.days_used && t.days_used > 0);
            if (isScanned) {
              scanned++;
              tiers[tTier].scanned++;
              if (t.scan_time) {
                recentScans.push({
                  id,
                  tier: tTier,
                  attendee_name: t.attendee_name || "",
                  scanned_by: t.scanned_by || "Gate",
                  scan_time: t.scan_time,
                  scan_timestamp: t.scan_timestamp || "",
                  total_days: totalDays,
                  days_used: t.days_used || 1
                });
              }
            } else if (t.status === "Valid") {
              valid++;
            }
          }
        }

        recentScans.sort((a, b) => (b.scan_timestamp || "").localeCompare(a.scan_timestamp || ""));

        return new Response(JSON.stringify({
          total,
          scanned,
          valid,
          multiDayCount,
          scansByDay,
          tiers,
          recentScans: recentScans.slice(0, 15)
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // POST /api/generate -> Multi-Tier Batch Ticket Generation
      // =========================================================================
      if (url.pathname === "/api/generate" && request.method === "POST") {
        const body = await request.json();
        const batches = body.batches || [];
        
        if (batches.length === 0 && body.count) {
          batches.push({
            count: parseInt(body.count, 10),
            tier: body.tier || "General",
            total_days: body.total_days || 1,
            allowed_days: body.allowed_days || [1],
            pass_type_name: body.pass_type_name
          });
        }

        if (batches.length === 0) {
          return new Response(JSON.stringify({ error: "No ticket batches specified" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const generatedTickets = {};
        const createdList = [];
        const nowIso = new Date().toISOString();

        for (const batch of batches) {
          const count = parseInt(batch.count, 10);
          const tier = batch.tier || "General";
          const prefix = getTierPrefix(tier);

          if (isNaN(count) || count <= 0) continue;

          const totalDays = Math.max(1, Math.min(10, parseInt(batch.total_days, 10) || 1));
          let allowedDays = Array.isArray(batch.allowed_days) && batch.allowed_days.length > 0
            ? batch.allowed_days.map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 10)
            : [];

          if (allowedDays.length === 0) {
            allowedDays = totalDays > 1
              ? Array.from({ length: totalDays }, (_, i) => i + 1)
              : [1];
          }

          const passTypeName = batch.pass_type_name || (totalDays > 1 ? `${totalDays}-Day Pass` : "Single Day Pass");

          // Initialize daily_scans with false
          const initialDailyScans = {};
          for (const d of allowedDays) {
            initialDailyScans[`day_${d}`] = { scanned: false };
          }

          for (let i = 0; i < count; i++) {
            const randomPart = generateRandomCode(6);
            const ticketId = `${prefix}-${randomPart}`;

            generatedTickets[ticketId] = {
              tier: tier,
              status: "Valid",
              attendee_name: batch.attendee_name || "",
              email: batch.email || "",
              phone: batch.phone || "",
              scanned_by: "",
              scan_time: "",
              scan_timestamp: null,
              email_sent: false,
              created_at: nowIso,
              rendered: false,
              notes: batch.notes || "",
              total_days: totalDays,
              allowed_days: allowedDays,
              days_used: 0,
              daily_scans: initialDailyScans,
              pass_type_name: passTypeName,
              ticket_type: totalDays > 1 ? "multi_day" : "single_day"
            };

            createdList.push({
              id: ticketId,
              tier: tier,
              status: "Valid",
              total_days: totalDays,
              allowed_days: allowedDays,
              pass_type_name: passTypeName
            });
          }
        }

        if (Object.keys(generatedTickets).length === 0) {
          return new Response(JSON.stringify({ error: "Invalid ticket batch count" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // Bulk patch to Firebase
        const fbRes = await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(generatedTickets)
        });

        if (!fbRes.ok) {
          const errDetail = await fbRes.text();
          return new Response(JSON.stringify({
            error: "Firebase rejected database write",
            details: errDetail
          }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          count: createdList.length,
          tickets: createdList
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // POST /api/save-attendee -> Update attendee info & tier
      // =========================================================================
      if ((url.pathname === "/api/save-attendee" || url.pathname === "/api/save-email") && request.method === "POST") {
        const { ticketId, attendee_name, email, phone, tier, notes, rendered, total_days, allowed_days, pass_type_name } = await request.json();
        if (!ticketId) {
          return new Response(JSON.stringify({ error: "Missing ticketId" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const updateData = {};
        if (attendee_name !== undefined) updateData.attendee_name = attendee_name;
        if (email !== undefined) updateData.email = email;
        if (phone !== undefined) updateData.phone = phone;
        if (tier !== undefined) updateData.tier = tier;
        if (notes !== undefined) updateData.notes = notes;
        if (rendered !== undefined) updateData.rendered = rendered;
        if (total_days !== undefined) updateData.total_days = parseInt(total_days, 10);
        if (allowed_days !== undefined) updateData.allowed_days = allowed_days;
        if (pass_type_name !== undefined) updateData.pass_type_name = pass_type_name;

        const fbRes = await fetch(`${fbUrl}/tickets/${encodeURIComponent(ticketId)}.json?auth=${fbSecret}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateData)
        });

        if (!fbRes.ok) {
          const errDetail = await fbRes.text();
          return new Response(JSON.stringify({ error: "Database save error", details: errDetail }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // POST /api/mark-rendered -> Bulk mark tickets as rendered
      // =========================================================================
      if (url.pathname === "/api/mark-rendered" && request.method === "POST") {
        const { ticketIds } = await request.json();
        if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
          return new Response(JSON.stringify({ error: "Missing ticketIds array" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const updates = {};
        for (const id of ticketIds) {
          updates[`${id}/rendered`] = true;
        }

        await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates)
        });

        return new Response(JSON.stringify({ success: true, count: ticketIds.length }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // =========================================================================
      // POST /api/reset-db -> Wipe all records or Reset Scan Statuses
      // =========================================================================
      if (url.pathname === "/api/reset-db" && request.method === "POST") {
        const { mode, confirm } = await request.json();

        if (confirm !== "CONFIRM_RESET") {
          return new Response(JSON.stringify({
            error: "Safety check failed. Confirmation string 'CONFIRM_RESET' required."
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        if (mode === "wipe_all") {
          const fbRes = await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`, {
            method: "DELETE"
          });

          if (!fbRes.ok) {
            const errDetail = await fbRes.text();
            return new Response(JSON.stringify({ error: "Failed to wipe database", details: errDetail }), {
              status: 502,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
            });
          }

          return new Response(JSON.stringify({
            success: true,
            mode: "wipe_all",
            message: "Database completely wiped. Clean slate ready for new event."
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        } else if (mode === "reset_scans") {
          const res = await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`);
          const data = await res.json();
          let count = 0;

          if (data && typeof data === "object") {
            const updates = {};
            for (const [id, t] of Object.entries(data)) {
              updates[`${id}/status`] = "Valid";
              updates[`${id}/scanned_by`] = "";
              updates[`${id}/scan_time`] = "";
              updates[`${id}/scan_timestamp`] = null;
              updates[`${id}/days_used`] = 0;

              // Reset daily_scans if present
              if (t.daily_scans && typeof t.daily_scans === "object") {
                const resetDaily = {};
                for (const dKey of Object.keys(t.daily_scans)) {
                  resetDaily[dKey] = { scanned: false };
                }
                updates[`${id}/daily_scans`] = resetDaily;
              }

              count++;
            }
            await fetch(`${fbUrl}/tickets.json?auth=${fbSecret}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updates)
            });
          }

          return new Response(JSON.stringify({
            success: true,
            mode: "reset_scans",
            count: count,
            message: `Reset ${count} tickets back to 'Valid' status.`
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        } else {
          return new Response(JSON.stringify({ error: "Invalid mode. Use 'wipe_all' or 'reset_scans'." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }
      }

      // =========================================================================
      // POST /api/send-email -> Dispatch Visual Ticket Pass via Resend API
      // =========================================================================
      if (url.pathname === "/api/send-email" && request.method === "POST") {
        const { ticketId, email, attendee_name, tier, eventName, passImageData } = await request.json();

        if (!ticketId || !email) {
          return new Response(JSON.stringify({ error: "Missing ticketId or email" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const ticketTier = tier || "General";
        const displayName = attendee_name || "Event Guest";
        const displayEvent = eventName || "Official Event Admission";

        let badgeColor = "#10b981";
        let tierBg = "#064e3b";
        let tierLabel = "GENERAL ADMISSION";

        if (ticketTier === "VIP") {
          badgeColor = "#f59e0b";
          tierBg = "#78350f";
          tierLabel = "👑 VIP PASS";
        } else if (ticketTier === "Guestlist") {
          badgeColor = "#a855f7";
          tierBg = "#581c87";
          tierLabel = "⭐ GUESTLIST PASS";
        }

        let passContentHtml = "";
        if (passImageData && passImageData.startsWith("data:image")) {
          passContentHtml = `
            <div style="margin: 20px 0; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.25);">
              <img src="${passImageData}" alt="Your Official Ticket Pass" style="width: 100%; max-width: 480px; display: block; border-radius: 12px;" />
            </div>
          `;
        } else {
          passContentHtml = `
            <div style="background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 24px; margin: 20px 0; text-align: center;">
              <div style="display: inline-block; padding: 4px 14px; background: ${tierBg}; color: ${badgeColor}; border: 1px solid ${badgeColor}; border-radius: 20px; font-size: 13px; font-weight: 700; letter-spacing: 1.5px; margin-bottom: 16px;">
                ${tierLabel}
              </div>
              <div style="background: #ffffff; display: inline-block; padding: 14px; border-radius: 14px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); margin-bottom: 16px;">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(ticketId)}" alt="Entry QR Code" width="200" height="200" style="display: block;" />
              </div>
              <div style="font-family: monospace; font-size: 20px; font-weight: 700; color: #f4f4f5; letter-spacing: 3px; margin-bottom: 8px;">
                ${ticketId}
              </div>
              <div style="font-size: 14px; color: #a1a1aa;">
                Attendee: <strong style="color: #ffffff;">${displayName}</strong>
              </div>
            </div>
          `;
        }

        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"/></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #09090b; color: #f4f4f5; padding: 30px 15px; margin: 0;">
            <div style="max-width: 500px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 20px; padding: 28px; box-shadow: 0 15px 30px rgba(0,0,0,0.5);">
              <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 6px 0; letter-spacing: -0.5px;">${displayEvent}</h1>
                <p style="color: #71717a; font-size: 14px; margin: 0;">Your Official Entry Pass is Ready</p>
              </div>

              ${passContentHtml}

              <div style="background: #141416; border-radius: 12px; padding: 14px; font-size: 13px; color: #a1a1aa; line-height: 1.6; border: 1px solid #27272a;">
                • Present this QR code at the entrance gate on your phone.<br/>
                • Single-entry verification. Do not share or duplicate this pass.<br/>
                • Gate staff will scan this QR directly from your screen.
              </div>

              <div style="text-align: center; margin-top: 24px; font-size: 11px; color: #52525b;">
                Secured by TicketScanner Pro • Powered by Cloudflare Serverless
              </div>
            </div>
          </body>
          </html>
        `;

        const resendKey = env.RESEND_API_KEY;
        if (!resendKey) {
          return new Response(JSON.stringify({
            error: "RESEND_API_KEY is not configured",
            details: "Set RESEND_API_KEY in Cloudflare Worker secrets or .dev.vars"
          }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const emailBody = {
          from: "Ticket Service <tickets@updates.resend.dev>",
          to: [email],
          subject: `🎟️ Your ${ticketTier} Pass for ${displayEvent}`,
          html: emailHtml
        };

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${resendKey}`
          },
          body: JSON.stringify(emailBody)
        });

        if (!resendRes.ok) {
          const errText = await resendRes.text();
          return new Response(JSON.stringify({ error: "Failed to dispatch email", details: errText }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // Update Firebase email status
        await fetch(`${fbUrl}/tickets/${encodeURIComponent(ticketId)}.json?auth=${fbSecret}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email,
            email_sent: true
          })
        });

        return new Response(JSON.stringify({ success: true, message: "Email dispatched successfully" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // Fallback to static assets or 404
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
      });
    }
  }
};
