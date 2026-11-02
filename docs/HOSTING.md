# Is Cloudflare Workers the right host for TixDesk?

Short answer: **yes, keep it on Workers**. While TixDesk is a demo, the Free plan is enough (see §5 for exactly how much it handles). Move to Workers Paid ($5/month) before the first paid customer event. The D1 database is already in APAC (`running_in_region: APAC`, checked 2 Nov 2026). The usual complaints about Workers mostly hit apps that do heavy server-side work. TixDesk does almost none: pass rendering, PDF/ZIP building and QR drawing all happen in the organizer's browser. The Worker is a thin JSON API in front of a small SQLite database, which is the shape Workers is best at.

---

## 1. What TixDesk actually asks of its host

Measured from `worker/src/index.js`:

| Workload | Where it runs | Server cost per call |
|---|---|---|
| Static pages (landing, admin, scanner, legal) | Cloudflare asset layer | ~0 (no Worker CPU for plain files; routed pages go through `env.ASSETS.fetch`) |
| Gate scan `/api/check` | Worker + D1 | 1 HMAC verify, 1 SELECT, 1 UPDATE, 1 INSERT |
| Login / register / password change | Worker | PBKDF2, 100,000 iterations (`PBKDF2_ITERATIONS`, line 14) |
| Ticket generation `/api/generate` | Worker + D1 | Up to 1,000 INSERTs in one `DB.batch` |
| Stats polling `/api/stats` | Worker + D1 | Aggregate over every ticket of the event, every 15 s per open admin tab |
| Pass email `/api/send-email` | Worker → Resend | 1 outbound fetch, request body up to ~7 MB (base64 PDF) |
| Payments | Worker → Razorpay | 1 outbound fetch + 2-statement batch |

No long jobs, no WebSockets, no file storage, no image processing on the server, no npm dependencies. That list is the key to the verdict.

---

## 2. The common arguments against Workers, checked against this app

### 2.1 "CPU time limits kill you" — **real on the Free plan, not on Paid**

- Free plan: **10 ms CPU per request**. Paid: 30 s default (configurable up to 5 min).
- PBKDF2 with 100k iterations of SHA-256 is deliberately slow. It is expected to cost tens of milliseconds of CPU, which exceeds 10 ms. On the Free plan, `/api/auth/register`, `/api/auth/login`, `/api/auth/password` and `/api/auth/reset` can fail intermittently with Cloudflare error 1102 ("Worker exceeded resource limits").
- Everything else (scan, stats, generate) is I/O-bound and well under 10 ms CPU.
- **Verdict:** the Free plan is fine for local demos but not for launch. The $5 Paid plan removes this problem. Do not "fix" it by lowering iterations.

### 2.2 "The database is far away, so it's slow" — **the one that matters most for scanning**

- A Worker runs in the Cloudflare data centre nearest the phone (Mumbai, Chennai, Delhi for Indian users).
- D1 is not everywhere. Every D1 database has **one primary location**. Every query travels from the Worker to that location and back. Read replicas exist but this code does not use the D1 Sessions API, so all reads go to the primary.
- `/api/check` runs its queries **one after another** (SELECT, then UPDATE, then INSERT). Each is one round trip.
  - Primary in APAC (e.g. Singapore) from India: roughly 40–80 ms per round trip, so a scan feels instant (~150–250 ms total).
  - Primary in North America or Europe: roughly 150–250 ms per round trip, so a scan takes 0.5–1 s. At a busy gate that queue is noticeable.
- D1 picks the primary location from where you created it unless you pass a hint. Check with `npx wrangler d1 info ticket-scanner-db`. If it is not APAC, the fix is to create a new DB with `--location apac`, export/import the data, and update `database_id` in both `wrangler.toml` files.
- Two extra levers:
  - **Smart Placement** (`[placement] mode = "smart"` in `wrangler.toml`) moves the Worker next to the database when it does several DB calls per request. Good fit for this app.
  - Merge the scan's UPDATE and INSERT into one `env.DB.batch([...])` to cut one round trip. The UPDATE's `changes` count still tells you whether the compare-and-set won.

### 2.3 "D1 is a toy / doesn't scale" — **fine for this scale, with one cost trap**

Limits that matter:

| Limit | Free | Paid | TixDesk usage |
|---|---|---|---|
| DB size | 500 MB per DB | 10 GB per DB | A ticket row is ~200 bytes. 10 GB ≈ tens of millions of tickets. |
| Rows read | 5 M / day | 25 B / month included | See the stats trap below. |
| Rows written | 100 K / day | 50 M / month included | A scan writes 2 rows. A 10k-person 3-day event ≈ 60k writes. |
| Write concurrency | single writer per DB | same | A gate scan is a ~1 ms write. Hundreds of scans per second before this hurts. |

**The stats trap.** `/api/stats` (`index.js:930`) runs its aggregate over every ticket of the event *before* it compares the ETag. So a `304 Not Modified` saves bandwidth but **not rows read**. The admin page polls every 15 s (`admin.html:2154`). One admin tab on a 10,000-ticket event for 8 hours is about 1,900 polls × 10,000+ rows ≈ 20 M rows read per day. That alone blows the Free plan's 5 M/day and is a large slice of the Paid allowance once several organizers do it. Fix: compute the ETag from something cheap first (e.g. `MAX(scan_logs.id)` plus a ticket count kept in a small counters table), return 304 before running the heavy aggregate, and back off polling when nothing changes.

### 2.4 "It's not Node, half of npm doesn't work" — **doesn't apply**

The Worker uses only Web-standard APIs (`fetch`, `Request`, `Response`, `crypto.subtle`, `Intl`). Zero dependencies. `local_dev_server.mjs` proves the same `index.js` runs unchanged on plain Node with a 100-line D1 shim over `node:sqlite`.

### 2.5 "Vendor lock-in" — **low**

The only Cloudflare-specific pieces are the `env.DB` binding (D1) and `env.ASSETS` binding. Moving to a VPS means: serve `worker/public/` with any static server, run the `fetch` handler under Node, and back `env.DB` with SQLite (the shim already exists) or Postgres (swap SQL dialect bits like `INSERT OR IGNORE`). A weekend of work, not a rewrite.

### 2.6 "No background jobs" — **real gap, but Workers has the answer**

Two features currently depend on a browser tab staying open:

1. **Bulk email.** `bulkDispatchPasses` (`admin.html:4919`) loops in the browser and calls `/api/send-email` once per ticket. Close the tab and sending stops halfway. The Workers fix is **Cloudflare Queues**: the API enqueues "send pass for ticket X", a queue consumer Worker sends with retries. Caveat: the PDF is rendered in the browser today, so either the browser uploads rendered passes to R2 first, or the queue sends the QR-in-body email variant (already supported when no attachment is present).
2. **Payment confirmation.** Credits are added only when the browser calls `/api/billing/verify-order` after Razorpay's checkout callback. If the organizer pays and the tab dies, money is taken and no credits arrive. Add a **Razorpay webhook** endpoint (`payment.captured`, verified with the webhook secret) that runs the same idempotent credit batch. This is a correctness bug independent of the host.

### 2.7 "Debugging is painful" — **partly true**

There is one `console.error(err)` in the global catch (`index.js:1547`) and no structured logging. Turn on Workers Logs with `[observability] enabled = true` in `wrangler.toml`, then use `npx wrangler tail` live during an event. Add a request id and route name to the error log so you can tell which endpoint failed.

### 2.8 "Cold starts" — **non-issue**

Workers isolates start in ~5 ms. The only per-isolate work is `ensureTicketColumns` (2 `PRAGMA` reads the first time an isolate handles an API call).

---

## 3. What the alternatives would buy you

| Option | Monthly cost at launch | Gains vs Workers | Losses vs Workers |
|---|---|---|---|
| **Workers Paid + D1** (current) | $5 | — | — |
| VPS (Hetzner/DigitalOcean) + Node + SQLite | $5–7 | Unlimited CPU, local DB = sub-ms queries, easy cron | You patch the OS, handle TLS, backups, uptime, DDoS. A single box in one region. If it dies on event day, gates stop. |
| Fly.io / Render + Postgres | $10–25 | Real Postgres, background workers | More moving parts, cold starts on cheap tiers |
| Vercel/Netlify functions + Supabase/Neon | $0–25 | Familiar Node, managed Postgres | Same "DB far from function" problem, function cold starts, two vendors |

For an app whose critical moment is "hundreds of phones at a gate must get an answer in under a second, and the server must not be down", a managed edge platform with no box to babysit is the right call. A VPS only wins if you start doing heavy server work (server-side PDF rendering, image processing, ML) or need long-running processes.

**When to revisit:** if you move pass rendering to the server, need real-time push to scanners (use Durable Objects first), or a single organizer outgrows 10 GB.

---

## 4. What to change (in priority order)

1. **Upgrade to Workers Paid** before the first real (paying) event. Fixes PBKDF2 CPU limits and raises D1 quotas. Fine to stay Free while it is a demo.
2. ~~Check D1 location~~ Done: APAC.
3. **Razorpay webhook** for `payment.captured` so paid credits never get lost.
4. **Cheap ETag check first in `/api/stats`** so idle polling stops reading every row. This is the first thing that breaks on the Free plan (§5).
5. **Turn on observability** and keep `wrangler tail` open on event day.
6. **Batch the scan's UPDATE + INSERT** into one round trip.
7. ~~Replace runtime `ALTER TABLE`~~ Done: removed; `schema.sql` is the source of truth.
8. ~~Queues and rate limiting~~ Done: `tixdesk-email` queue + "Send in background" button; `AUTH_LIMITER` and `API_LIMITER` bindings in front of the D1 lockouts.
9. **Backups:** D1 Time Travel restores to any minute in the last 30 days (Paid). Also export before each event: `npx wrangler d1 export ticket-scanner-db --remote --output=backup.sql`.

---

## 5. How much the Free plan handles (demo phase)

Free plan limits (Cloudflare docs, Nov 2026). Since 1 Sep 2026, D1 queries fail once a daily limit is hit, until 00:00 UTC (05:30 IST).

| Resource | Free limit per day |
|---|---|
| Worker requests | 100,000 (plain static files served without running the Worker don't count) |
| Worker CPU | 10 ms per request |
| D1 rows read | 5,000,000 |
| D1 rows written | 100,000 (each index on a changed column counts as another row) |
| D1 storage | 500 MB per database |
| D1 queries per request | 50 |
| Queues | 10,000 operations (~3 per message, so ~3,300 emails) |
| Resend (email, free tier) | 100 emails/day, 3,000/month |

What each action costs (estimates from the queries in `worker/src/`):

| Action | Rows written | Rows read |
|---|---|---|
| One gate scan | ~5 (ticket update + status index, scan log + 2 indexes) | ~3 |
| One ticket generated | ~5 (row + id, event, tier, status indexes) | ~1 |
| One dashboard stats poll (every 15 s while the tab is visible) | 0 | every ticket + every scan of the event, even when nothing changed |
| One ticket-list page | 0 | every ticket of the event (for the total count) |

What that means for a demo:

- **Scanning:** ~20,000 scans a day before writes run out. Not the bottleneck.
- **Generating:** ~20,000 tickets a day. Not the bottleneck either.
- **Dashboard polling is the bottleneck.** With 1,000 tickets and 1,000 scans, each poll reads ~2,000 rows, so one open dashboard tab uses up the 5 M daily reads in about 10 hours. With 5,000 tickets, about 2 hours. Two organizers watching at once halve that. Fix: §4 item 4.
- **Email:** Resend's free 100/day runs out long before Queues does.
- **Login CPU:** one 100k-iteration PBKDF2 hash took 16 ms on a laptop. That's above the 10 ms limit, so sign-in, sign-up and password changes may fail now and then with error 1102. Log in ~10 times on the deployed site to see if it happens. If it does, the honest fix is the Paid plan. Lowering iterations weakens every stored password.
- **Big batches:** generating 1,000 tickets sends 1,000 INSERTs in one `DB.batch`. Check that this doesn't trip the 50-queries-per-request limit by generating 100+ tickets once on the deployed demo.

Rule of thumb: a demo event of up to ~1,000–2,000 tickets, a few thousand scans and a dashboard open for a few hours fits the Free plan, once the stats poll is fixed.

### Can a local copy of the database replace the paid plan?

Not for the reasons the Paid plan exists. The 10 ms CPU limit is about the Worker, not the database. A Worker running on Cloudflare also can't reach a SQLite file on your laptop. What a local copy *is* good for:

- **Backups:** `npx wrangler d1 export ticket-scanner-db --remote --output=backup.sql --cwd worker` before each event.
- **Running the whole demo off your own machine:** `node local_dev_server.mjs` runs the same Worker code on Node with a local SQLite file and no limits. Put it online with a free Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`). Trade-off: your laptop is the server, and if it sleeps or loses Wi-Fi, gates stop.

---

Pricing and limits above are from Cloudflare's published plans as of late 2026. Check the current numbers on the Workers and D1 pricing pages before deciding.
