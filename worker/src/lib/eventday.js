import { DEFAULT_EVENT_TZ, DAY_ROLLOVER_HOUR } from "../config.js";

// Which day of a multi-day event it is, in the event's own timezone.

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch (_) { return false; }
}

// Which day of the event it is right now in the event's own timezone (1 = start date).
// Gates no longer pick a day by hand, so a day-1 scan never blocks the same pass on day 2.
// Returns null when the event has no usable start date.
export function eventDayNow(startDate, totalDays, timeZone) {
  const tz = validTimeZone(timeZone) ? timeZone : DEFAULT_EVENT_TZ;
  const [y, m, d] = String(startDate || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  let today = Date.UTC(get("year"), get("month") - 1, get("day"));
  if (get("hour") < DAY_ROLLOVER_HOUR) today -= 86400000;
  const total = Math.max(1, totalDays || 1);
  const day = Math.round((today - Date.UTC(y, m - 1, d)) / 86400000) + 1;
  return { day, total, before: day < 1, after: day > total };
}
