// Tenant isolation: every tickets / scan_logs query goes through this.

// SQL fragment restricting a tickets/scan_logs query to the organizer's own events.
// `eventId === "ALL"` means every event this organizer owns (never other organizers').
export function eventScope(eventId, organizerId) {
  if (eventId === "ALL") {
    return { sql: "event_id IN (SELECT id FROM events WHERE organizer_id = ?)", params: [organizerId] };
  }
  return { sql: "event_id IN (SELECT id FROM events WHERE id = ? AND organizer_id = ?)", params: [eventId, organizerId] };
}
