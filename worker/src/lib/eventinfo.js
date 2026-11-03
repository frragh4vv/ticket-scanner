// Booking page details (event_info): shared by the organizer routes, the public API and the
// server-side share tags on /e/<slug>.

export const INFO_FIELDS = ["start_time", "end_time", "venue", "address", "map_url", "about", "host_name", "contact_email", "contact_phone"];

// Everything a buyer may see for an enabled booking page, or null. No cover bytes, only whether one exists.
export async function publicPage(env, slug) {
  return env.DB.prepare(`
    SELECT p.event_id, p.organizer_id, p.slug, e.title, e.start_date, e.total_days, e.timezone,
      ${INFO_FIELDS.map(f => "i." + f).join(", ")}, i.cover IS NOT NULL AS has_cover, i.updated_at
    FROM event_pages p JOIN events e ON e.id = p.event_id
    LEFT JOIN event_info i ON i.event_id = p.event_id
    WHERE p.slug = ? AND p.enabled = 1
  `).bind(String(slug || "").toLowerCase()).first();
}

export function coverPath(page) {
  return page.has_cover ? `/api/public/events/${page.slug}/cover?v=${encodeURIComponent(page.updated_at || "")}` : "";
}

// Fields the booking page renders. Organizer-entered text is returned as plain strings; the page uses textContent.
export function publicInfo(page) {
  const info = {};
  for (const f of INFO_FIELDS) info[f] = page[f] || "";
  info.cover_url = coverPath(page);
  return info;
}

function dateLabel(page) {
  const d = new Date(page.start_date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return page.start_date;
  const s = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return s + (page.start_time ? `, ${page.start_time}` : "") + (page.total_days > 1 ? ` · ${page.total_days} days` : "");
}

// One-line summary for <meta name="description"> and link previews.
export function shareDescription(page) {
  const where = [page.venue, page.address].filter(Boolean).join(", ");
  const lead = [dateLabel(page), where].filter(Boolean).join(" · ");
  const about = (page.about || "").replace(/\s+/g, " ").trim();
  const text = lead + (about ? ". " + about : ". Book tickets online, pass delivered by email.");
  return text.length > 200 ? text.slice(0, 197).trimEnd() + "…" : text;
}

// Rewrites the static book.html head so WhatsApp, Instagram and search engines see this event, not a generic page.
export function withShareTags(res, page, origin) {
  const title = `${page.title} · Tickets`;
  const desc = shareDescription(page);
  const url = `${origin}/e/${page.slug}`;
  const image = page.has_cover ? origin + coverPath(page) : `${origin}/ticket_hero.jpg`;
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="TixDesk">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(eventJsonLd(page, url, image)).replace(/</g, "\\u003c")}</script>`
  ].join("\n");
  return new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", desc); } })
    .on("head", { element(el) { el.append(tags, { html: true }); } })
    .transform(res);
}

function eventJsonLd(page, url, image) {
  const start = page.start_date + (page.start_time ? `T${page.start_time}` : "");
  const ld = {
    "@context": "https://schema.org", "@type": "Event", name: page.title, url, image: [image],
    startDate: start, eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    offers: { "@type": "Offer", url, priceCurrency: "INR" }
  };
  if (page.about) ld.description = page.about.slice(0, 500);
  if (page.venue || page.address) ld.location = { "@type": "Place", name: page.venue || page.address, address: page.address || page.venue };
  if (page.host_name) ld.organizer = { "@type": "Organization", name: page.host_name };
  return ld;
}
