// Dashboard reads: live stats (ETag) and the paginated ticket list.
// handle(ctx) returns a Response when it owns the route, or null to let the next module try.

import { json, getCorsHeaders } from "../lib/http.js";
import { parseDays } from "../lib/util.js";
import { eventScope } from "../lib/scope.js";

export async function handle(ctx) {
  const { request, env, url, origin, organizerId } = ctx;

  // -----------------------------------------------------------------------
  // GET /api/stats -> Aggregation with ETag (scoped to the organizer's events)
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/stats" && request.method === "GET") {
    const eventId = url.searchParams.get("event_id") || "ALL";
    const scope = eventScope(eventId, organizerId);

    const statsQuery = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'scanned' THEN 1 ELSE 0 END) as scanned,
        SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END) as valid,
        SUM(CASE WHEN total_days > 1 THEN 1 ELSE 0 END) as multiDayCount,
        SUM(CASE WHEN tier = 'VIP' THEN 1 ELSE 0 END) as vip_total,
        SUM(CASE WHEN tier = 'VIP' AND status = 'scanned' THEN 1 ELSE 0 END) as vip_scanned,
        SUM(CASE WHEN tier = 'General' THEN 1 ELSE 0 END) as gen_total,
        SUM(CASE WHEN tier = 'General' AND status = 'scanned' THEN 1 ELSE 0 END) as gen_scanned,
        SUM(CASE WHEN tier = 'Guestlist' THEN 1 ELSE 0 END) as gst_total,
        SUM(CASE WHEN tier = 'Guestlist' AND status = 'scanned' THEN 1 ELSE 0 END) as gst_scanned
      FROM tickets
      WHERE ${scope.sql}
    `).bind(...scope.params).first();

    const scanCount = await env.DB.prepare(`SELECT COUNT(*) as n, MAX(id) as last FROM scan_logs WHERE ${scope.sql}`)
      .bind(...scope.params).first();

    const total = statsQuery?.total || 0;
    const scanned = statsQuery?.scanned || 0;
    const valid = statsQuery?.valid || 0;
    const multiDayCount = statsQuery?.multiDayCount || 0;

    // ETag includes the scan log head so day-2+ scans (which don't change status) still bust the cache
    const etag = `W/"stats-${eventId}-${total}-${scanned}-${scanCount?.n || 0}-${scanCount?.last || 0}"`;
    const rawIfNoneMatch = request.headers.get("If-None-Match") || "";
    const ifNoneMatchClean = rawIfNoneMatch.replace(/["'\sW\/]/g, "");
    const etagClean = etag.replace(/["'\sW\/]/g, "");
    const cacheHeaders = { ETag: etag, "Cache-Control": "private, max-age=10" };

    if (rawIfNoneMatch && (rawIfNoneMatch === etag || ifNoneMatchClean === etagClean)) {
      return new Response(null, { status: 304, headers: { ...cacheHeaders, ...getCorsHeaders(origin) } });
    }

    // Daily scans breakdown
    const dailyRows = await env.DB.prepare(`
      SELECT scanned_day, COUNT(*) as count
      FROM scan_logs
      WHERE ${scope.sql}
      GROUP BY scanned_day
    `).bind(...scope.params).all();

    const scansByDay = {};
    for (let d = 1; d <= 10; d++) scansByDay[`day_${d}`] = 0;
    for (const row of (dailyRows.results || [])) {
      scansByDay[`day_${row.scanned_day}`] = row.count;
    }

    // Recent 15 scans
    const recentRows = await env.DB.prepare(`
      SELECT s.ticket_id as id, t.tier, t.attendee_name, s.gate_device_id as scanned_by, s.scan_timestamp as scan_time, s.scanned_day
      FROM scan_logs s
      LEFT JOIN tickets t ON s.ticket_id = t.id
      WHERE s.${scope.sql}
      ORDER BY s.id DESC
      LIMIT 15
    `).bind(...scope.params).all();

    return json({
      total,
      scanned,
      valid,
      multiDayCount,
      scansByDay,
      tiers: {
        VIP: { total: statsQuery?.vip_total || 0, scanned: statsQuery?.vip_scanned || 0 },
        General: { total: statsQuery?.gen_total || 0, scanned: statsQuery?.gen_scanned || 0 },
        Guestlist: { total: statsQuery?.gst_total || 0, scanned: statsQuery?.gst_scanned || 0 }
      },
      recentScans: recentRows.results || []
    }, 200, origin, cacheHeaders);
  }

  // -----------------------------------------------------------------------
  // GET /api/tickets -> Server-Side Pagination & Filter
  // -----------------------------------------------------------------------
  if (url.pathname === "/api/tickets" && request.method === "GET") {
    const eventId = url.searchParams.get("event_id") || "ALL";
    const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get("limit"), 10) || 50));
    const offset = (page - 1) * limit;
    const tier = (url.searchParams.get("tier") || "").trim();
    const status = (url.searchParams.get("status") || "").trim().toLowerCase();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    const scope = eventScope(eventId, organizerId);
    let where = scope.sql;
    const params = [...scope.params];

    if (tier && tier !== "All") {
      where += " AND tier = ?";
      params.push(tier);
    }
    if (status && status !== "all") {
      where += " AND LOWER(status) = ?";
      params.push(status);
    }
    if (q) {
      where += " AND (LOWER(id) LIKE ? OR LOWER(attendee_name) LIKE ? OR LOWER(email) LIKE ?)";
      const wild = `%${q}%`;
      params.push(wild, wild, wild);
    }
    if (url.searchParams.get("unsent") === "1") where += " AND email_sent_at IS NULL AND COALESCE(email, '') != ''";
    if (url.searchParams.get("unrendered") === "1") where += " AND rendered_at IS NULL";
    if (url.searchParams.get("multiday") === "1") where += " AND total_days > 1";

    const countRes = await env.DB.prepare(`SELECT COUNT(*) as total FROM tickets WHERE ${where}`).bind(...params).first();
    const totalCount = countRes ? countRes.total : 0;

    const rows = await env.DB.prepare(`SELECT * FROM tickets WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset).all();

    // Normalize format for frontend
    const ticketsList = (rows.results || []).map(t => {
      const allowedDaysArr = parseDays(t.allowed_days || "1", t.total_days);
      const scannedDaysArr = parseDays(t.scanned_days, t.total_days);
      const dailyScans = {};
      for (const d of allowedDaysArr) {
        dailyScans[`day_${d}`] = { scanned: scannedDaysArr.includes(d) };
      }

      return {
        id: t.id,
        attendee_name: t.attendee_name || "",
        email: t.email || "",
        phone: t.phone || "",
        tier: t.tier,
        total_days: t.total_days || 1,
        allowed_days: allowedDaysArr,
        scanned_days: scannedDaysArr,
        days_used: scannedDaysArr.length,
        status: t.status === "scanned" ? "Scanned" : "Valid",
        daily_scans: dailyScans,
        pass_type_name: (t.total_days || 1) > 1 ? `${t.total_days}-Day Pass` : "Single Day Pass",
        email_sent: !!t.email_sent_at,
        rendered: !!t.rendered_at,
        created_at: t.created_at
      };
    });

    return json({
      tickets: ticketsList,
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit) || 1
    }, 200, origin);
  }

  return null;
}
