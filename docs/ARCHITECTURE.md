# TixDesk architecture

A guide to what every part of the system does, how the parts talk, and what breaks when something changes. Backend references are `module → function/route`. Frontend line numbers drift as files change, so search for the quoted names if a number is off. For a slower, beginner-level walk through every file and every request, read [GUIDE.md](GUIDE.md).

Contents

1. The big picture
2. Repository map (every file)
3. Backend: `worker/src/index.js` section by section
4. Data model
5. Security model (tokens, passwords, lockouts, tenant scoping)
6. Frontend: each page and its internal parts
7. End-to-end flows
8. What breaks when… (troubleshooting table)
9. Config, secrets and tooling
10. Known weak spots

---

## 1. The big picture

```
                         Cloudflare edge (one Worker named "tixdesk")
 ┌──────────────┐        ┌───────────────────────────────────────────────┐
 │ Organizer    │ HTTPS  │  fetch() in worker/src/index.js               │
 │ browser      ├───────►│   ├─ path not /api/*  ─► env.ASSETS ─► worker/public/*.html
 │ admin.html   │        │   └─ path /api/*      ─► route handlers        │
 └──────────────┘        │                             │                 │
 ┌──────────────┐        │                             ▼                 │
 │ Gate phone   ├───────►│                       env.DB (D1 / SQLite)    │
 │ scanner.html │        │                             │                 │
 └──────────────┘        └─────────────┬───────────────┼─────────────────┘
                                       │ outbound fetch│
                       ┌───────────────┴──┐   ┌────────┴───────┐
                       │ Resend (email)   │   │ Razorpay (pay) │
                       └──────────────────┘   └────────────────┘
```

Three ideas explain almost everything:

1. **One Worker does two jobs.** It serves static HTML files and it answers the JSON API. The split is the very first `if` in `fetch()`: anything not starting with `/api/` is a file.
2. **The browser does the heavy work.** Pass design, QR drawing, PNG/PDF/ZIP export all run in `admin.html` with canvas and CDN libraries. The server only stores rows and checks tokens.
3. **The database is the source of truth for scanning.** Scanners never decide validity locally. Every scan is a round trip to D1, which is what stops two gates admitting the same screenshot. It is also why scanners need internet.

---

## 2. Repository map

### Live code (deployed)

| Path | What it is | If you break it |
|---|---|---|
| `worker/src/index.js` | Front door: page routing, rate limits, session + role checks, dispatch to route modules, queue entry point. | Everything. An import error means the Worker fails to deploy. |
| `worker/src/config.js` | Constants: tiers, batch size, session lifetimes, lockout numbers, PBKDF2 iterations, credit packs, default timezone, email regex. | Changing `CREDIT_PACKS` changes prices; changing TTLs changes how long people stay signed in. |
| `worker/src/lib/*.js` | Shared helpers: `http` (JSON/CORS/headers), `util` (codes, PINs, escaping, days), `crypto` (HMAC, PBKDF2), `session` (tokens), `limits` (lockouts, quotas), `eventday` (which day is it), `scope` (tenant SQL), `email` (pass email builder/sender). | A bug in `session`, `scope` or `limits` is a security bug for every route. |
| `worker/src/routes/*.js` | One file per area: `public-auth`, `scan`, `account`, `events`, `billing`, `stats`, `tickets`, `email`. Each exports `handle(ctx)`. | Only that area. |
| `worker/src/queue/email-consumer.js` | Background sender for the `tixdesk-email` queue. | "Send in background" emails stop going out. |
| `worker/public/landing.html` | Marketing homepage served at `/`. Static, no API calls. | Only the homepage. |
| `worker/public/admin.html` | Organizer app (sign-in, dashboard, ticket studio, generation, emailing, billing, settings). ~5,000 lines: CSS, markup and one big `<script>`. | Organizers can't manage events. Gates keep scanning (scanner is separate). |
| `worker/public/scanner.html` | Gate scanner app. Camera, QR decoding, calls `/api/check`, shows green/red result with sounds. | Gates can't admit people. **Highest-stakes file on event day.** |
| `worker/public/reset.html` | "Set a new password" page reached from the reset email. | Password reset only. |
| `worker/public/terms.html`, `privacy.html`, `cookies.html`, `refunds.html`, `contact.html` | Legal / policy pages. Static. | Nothing functional; Razorpay needs them to exist for merchant approval. |
| `worker/public/404.html` | Shown for unknown paths (the Worker substitutes it on asset 404s, `index.js` → `serve()`). | Unknown URLs show a bare 404. |
| `worker/public/site.css` | Shared styles for legal pages and landing. admin/scanner carry their own inline `<style>`. | Legal pages lose styling. |
| `worker/public/consent.js` | Storage notice bar on public pages; remembers dismissal in `localStorage`. | Notice bar disappears or repeats. |
| `worker/public/_headers` | Cloudflare static-asset headers: Content-Security-Policy, frame blocking, `no-store` on `/admin`, `/scanner`, `/reset`. | **Tightening CSP can silently break pages**: e.g. remove `cdnjs.cloudflare.com` and the scanner's QR library fails to load; remove the Razorpay domains and checkout won't open. |
| `worker/public/favicon.svg`, `robots.txt` | Icon and crawler rules. | Cosmetic / SEO. |
| `worker/schema.sql` | Creates all tables and indexes. Uses `IF NOT EXISTS`, so re-running is safe. | New installs get the wrong schema. |
| `worker/seed.sql` | Demo organizer `org_raghav`, event `evt_sunburn2026` (gate PIN `8421`), 5 tickets. Password is plaintext `demo123`. | Only local demos. **Never run it against the production DB** (see §10). |
| `worker/wrangler.toml` | The only Worker config (`npm` scripts pass `--cwd worker`). Names the Worker, points at `./public`, binds D1 as `DB`, the two rate limiters and the email queue. | Wrong `database_id` = Worker talks to the wrong or no DB. Deploy fails if the `tixdesk-email` queue doesn't exist yet. |
| `worker/.dev.vars` (gitignored) / `.dev.vars.example` | Local secrets for `wrangler dev`. | Local API returns "Server misconfigured" without `SESSION_SECRET`. |
| `package.json` | Only npm scripts wrapping `wrangler`. No dependencies. | — |

### Not deployed

| Path | What it is |
|---|---|
| `local_dev_server.mjs` (untracked) | Runs the Worker on plain Node with a fake D1 over `node:sqlite`, storing data in `ticket_scanner_dev.sqlite`. Useful when wrangler isn't available. |
| `qrmaker.py` | Older standalone CLI: generates QR PNGs and a CSV. Not connected to the Worker or D1. |
| `main.py`, `pyproject.toml`, `uv.lock`, `.python-version` | Python project scaffolding for `qrmaker.py`. `main.py` is a hello-world stub. |
| `appsheet_database.csv` | Leftover data from the pre-Worker AppSheet version. Unused. |
| `launch-video/`, `stub-hyperframes/` | Marketing video assets. Not part of the app. |
| `README.md`, `LAUNCH.md`, `DESIGN.md`, `PRODUCT.md`, `CODEMAP.md`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md` | Docs and AI-agent notes (several are gitignored). |

---

## 3. Backend: `worker/src/`

```
worker/src/
├── index.js                 front door: pages, rate limits, session wall, dispatch, queue()
├── config.js                constants
├── lib/
│   ├── http.js              json(), CORS, security headers, lockedOutResponse()
│   ├── util.js              codes, PINs, tier prefix, escapeHtml, parseDays
│   ├── crypto.js            HMAC, constant-time compare, PBKDF2 hash/verify
│   ├── session.js           sign/verify tokens, admin session freshness
│   ├── limits.js            lockouts and quotas in auth_attempts
│   ├── eventday.js          which day of the event it is
│   ├── scope.js             eventScope() tenant filter
│   └── email.js             sendPassEmail(): build + send one pass email
├── routes/                  each exports handle(ctx) → Response | null
│   ├── public-auth.js       auth-verify, register, login, forgot, reset, gate/auth
│   ├── scan.js              /api/check
│   ├── account.js           me, export, password, delete
│   ├── events.js            list, create
│   ├── billing.js           create-order, verify-order
│   ├── stats.js             stats, tickets list
│   ├── tickets.js           generate, assign, save-attendee, mark-rendered, reset-db
│   └── email.js             send-email, send-email/queue
└── queue/
    └── email-consumer.js    background sender
```

Dependencies only point downward: `index.js` → `routes/` → `lib/` → `config.js`. Nothing in `lib/` imports a route.

### 3.1 Constants and response helpers (`config.js`, `lib/http.js`, `lib/util.js`)

- `VALID_TIERS`, `MAX_TICKETS_PER_BATCH = 1000`, session lifetimes (`ADMIN_SESSION_TTL` 7 days, `GATE_SESSION_TTL` 14 days), lockout numbers, `PBKDF2_ITERATIONS`, `CREDIT_PACKS` (prices in INR).
- `getCorsHeaders` / `allowedOrigins` / `setAllowedOrigins`: CORS is only needed if another site calls the API. Same-origin pages don't need it. `localhost` is always allowed.
- `json()`: every API response goes through this. Adds `no-store`, security headers and CORS.
- `generateRandomCode`: ticket and event ids use the alphabet without `0/O/1/I` so humans can type them.
- `generatePin`: 6-digit gate PIN.
- `parseDays`: turns `"1,3"` or `"ALL"` into `[1,3]` / `[1..n]`. Used everywhere days are checked.

*Breaks when:* changing `CREDIT_PACKS` changes what customers pay. Changing the code alphabet doesn't affect existing tickets.

### 3.2 Crypto and sessions (`lib/crypto.js`, `lib/session.js`)

- `hmac`, `timingSafeEqual`: building blocks.
- `signSession` / `verifySession`: the app's own token format, `st.<base64url JSON>.<base64url HMAC-SHA256>`. The JSON holds `role`, `sub` (organizer id), `exp`, and for gates `evt` (event id). It is a homemade JWT. There is no session table; a token is valid if the signature checks and `exp` is in the future.
- `getSessionSecret`: uses `SESSION_SECRET`, falling back to `SCANNER_ACCESS_KEY`.
- `hashPassword` / `verifyPassword`: PBKDF2-SHA256, stored as `pbkdf2$100000$salt$hash`. Rows not starting with `pbkdf2$` are treated as legacy plaintext and upgraded on next login.

*Breaks when:* **rotating `SESSION_SECRET` logs out every organizer and every gate phone at once.** Never rotate it during an event.

### 3.3 Brute-force protection and quotas (`lib/limits.js` + rate limiters in `index.js`)

Two layers. First, Cloudflare's Rate Limiting bindings in `index.js` → `overRateLimit()`: `AUTH_LIMITER` allows 20 requests a minute per IP per auth endpoint, and `API_LIMITER` allows 300 a minute per session token. They are approximate and counted per Cloudflare location, and they cost nothing in D1. Second, the exact lockouts below, all stored in the `auth_attempts` table as `key → (failures, window_start)`.

- `isLockedOut` / `recordFailure` / `clearFailures`: 10 failures per key per 15 minutes.
- `consumeQuota`: same table, but counts every call. Used for sign-ups per IP, reset emails, and the daily email cap per organizer.
- Keys look like `login:<email>`, `gate:<event>:<ip>`, `gate:<event>` (100 failures from all IPs), `master:<ip>`, `email:<org>`, `forgot:<email>`.

*Breaks when:* many volunteers behind one venue Wi-Fi typing a wrong PIN share one IP, so they can lock each other out for 15 minutes. Fix it by deleting the `gate:...` rows in `auth_attempts`.

### 3.4 Session freshness (`lib/session.js`)

`passwordFingerprint` hashes the stored password hash into 16 hex chars, and admin tokens carry it as `pv`. `adminSessionIsCurrent` re-reads the organizer row on each admin request and compares. So changing your password or deleting the account kills all old admin tokens. Gate tokens don't carry it, so a password change does **not** log out gates.

### 3.5 Schema changes

`worker/schema.sql` is the single source of truth. The old runtime `ALTER TABLE` helper (`ensureTicketColumns`) was removed after confirming the production DB already has every column. If the schema ever changes again, run the `ALTER TABLE` once with `npx wrangler d1 execute ticket-scanner-db --remote --command "..." --cwd worker` and update `schema.sql` in the same commit.

### 3.6 Event-day clock (`lib/eventday.js`)

`eventDayNow(start_date, total_days, timezone)` answers "which day of the event is it right now?" in the event's own timezone. The day rolls over at **6 AM**, not midnight, so a 1 AM scan still counts as the previous night. Returns `{day, total, before, after}`.

*Breaks when:* the organizer enters the wrong `start_date` or timezone. Gates then see "EVENT HASN'T STARTED" or "EVENT HAS ENDED" for every pass. Fix the event row; no redeploy needed.

### 3.7 Tenant scoping (`lib/scope.js`)

`eventScope(eventId, organizerId)` returns a SQL fragment like `event_id IN (SELECT id FROM events WHERE id = ? AND organizer_id = ?)`. Every ticket/scan query uses it, so one organizer can never read another's data even with a guessed event id. **Any new query on `tickets` or `scan_logs` must use this or an equivalent `JOIN events ... organizer_id = ?`.**

### 3.8 `index.js` → `fetch()`: the request pipeline

Every request runs this sequence:

1. **CORS preflight** (`OPTIONS`) → empty response.
2. **Static routing**. Pretty URLs map to files:
   - `/scan`, `/scanner`, or `/?pin=…` → `scanner.html`
   - `/`, `/landing` → `landing.html`
   - `/admin`, `/login`, `/signup` → `admin.html` (`/signup` adds `?mode=signup`)
   - `/reset` → `reset.html`
   - Anything else → the file of that name, or `404.html`.
3. **Preconditions**: 500 if `env.DB` or the session secret is missing.
4. **Read the token** from `Authorization: Bearer …` and the client IP from `CF-Connecting-IP`.
5. **Rate limit** (`overRateLimit`) → 429 if over.
6. **Build `ctx`** = `{ request, env, url, origin, bearer, session, clientIp }`.
7. **Public endpoints** (`routes/public-auth.js`, no session needed):

| Route | Does |
|---|---|
| `/api/auth-verify` | Checks a token, or swaps the master key (`SCANNER_ACCESS_KEY`) for an owner admin session. |
| `POST /api/auth/register` | Creates an organizer (PBKDF2 hash, 50 starter credits, a first event), returns admin token. 5 sign-ups per IP per hour. |
| `POST /api/auth/login` | Email + password → admin token. Lockout per email. |
| `POST /api/auth/forgot` | Emails a 30-minute reset link via Resend. Always answers the same, so it doesn't reveal which emails exist. |
| `POST /api/auth/reset` | Reset token + new password → new hash + admin token. Token dies once the password changes, because of `pv`. |
| `POST /api/gate/auth` | Event id + gate PIN → gate token (role `gate`, scoped to one event). |

8. **Session wall**: everything below needs a valid admin or gate token. Adds `ctx.organizerId`, `ctx.isAdmin`.
9. **`POST /api/check`** (`routes/scan.js`): the scan. Works for gate and admin tokens. See §7.4 for the full logic.
10. **Role wall**: gate tokens get 403 for everything else.
11. **Organizer endpoints**, tried in the order of `ORGANIZER_ROUTES`:

| Route | Module | Does |
|---|---|---|
| `GET /api/auth/me` | account | Profile, credit balance, whether tour tickets were used. |
| `GET /api/auth/export` | account | Data export (privacy). |
| `POST /api/auth/password` | account | Change password (kills old sessions). |
| `POST /api/auth/delete` | account | Delete account (erases events, tickets, scans; keeps anonymised payment rows). |
| `GET /api/events` | events | List the organizer's events (includes gate PINs). |
| `POST /api/events` | events | Create an event: id `evt_<time>_<code>`, 6–8 digit PIN, days, start date, timezone, tiers on/off. |
| `POST /api/billing/create-order` | billing | Creates a Razorpay order (or a demo order if `DEMO_BILLING`), stores `credit_orders` row. |
| `POST /api/billing/verify-order` | billing | Checks Razorpay's HMAC signature, then adds credits + marks paid in one atomic batch. Replays are no-ops. |
| `GET /api/stats` | stats | Dashboard counts, per-day scans, recent scans. ETag-based 304. |
| `GET /api/tickets` | stats | Paginated, filterable ticket list (max 200 per page). |
| `POST /api/generate` | tickets | Spend credits, create up to 1,000 tickets (blank or with attendee list). Credits reserved first, refunded if the insert fails. Also the free guided-tour tickets. |
| `POST /api/assign` | tickets | Put names/emails onto existing blank tickets (no credits). `dry_run: true` previews. |
| `POST /api/save-attendee`, `/api/save-email` | tickets | Inline edit of a ticket's name/email/phone/tier. |
| `POST /api/mark-rendered` | tickets | Records that pass images were exported. |
| `POST /api/reset-db` | tickets | `reset_scans` (un-scan everything) or `wipe_all` (delete tickets) for one event. Needs `confirm: "CONFIRM_RESET"`. |
| `POST /api/send-email` | email | Calls `lib/email.js` `sendPassEmail`: builds the pass email HTML, attaches the PDF/JPG the browser rendered, sends via Resend, sets `email_sent_at`. Daily cap per organizer. |
| `POST /api/send-email/queue` | email | Puts every unsent ticket of one event on the `tixdesk-email` queue (max 1,000 per call, once per 10 min per event). |

12. **Fallback**: 404 JSON. Any thrown error → logged, 500 JSON "Internal Server Error".
13. **`queue(batch, env)`**: not an HTTP request. Cloudflare calls it with up to 10 queued messages; `queue/email-consumer.js` sends each one via `sendPassEmail(..., { onlyIfUnsent: true })` and acks or retries.

---

## 4. Data model (`worker/schema.sql`)

```
organizers 1──* events 1──* tickets 1──* scan_logs
     │                          (ON DELETE CASCADE down the chain)
     ├──* credit_orders
     └──1 tour_grants
auth_attempts  (standalone key/value counters)
```

| Table | Key columns | Written by | Read by |
|---|---|---|---|
| `organizers` | `id`, `email` (unique), `password_hash`, `ticket_credits` | register, login (hash upgrade), password, delete, billing verify, generate | almost every admin route (session freshness) |
| `events` | `id`, `organizer_id`, `start_date`, `total_days` (1–10), `gate_pin`, `use_tiers`, `timezone` | `POST /api/events` | gate auth, check, generate, assign, stats |
| `tickets` | `id` (e.g. `VIP-7K2P9QXA`, this **is** the QR content), `event_id`, `tier`, `allowed_days`, `scanned_days`, `status` (`valid`/`scanned`/`revoked`), `email_sent_at`, `rendered_at` | generate, assign, save-attendee, check, reset-db, send-email, mark-rendered | tickets, stats, check |
| `scan_logs` | auto `id`, `ticket_id`, `event_id`, `scanned_day`, `gate_device_id`, timestamp | check | stats |
| `credit_orders` | `order_id`, `credits_purchased`, `amount_inr`, `status` | create-order, verify-order | verify-order |
| `auth_attempts` | `key`, `failures`, `window_start` | lockout + quota helpers | same |
| `tour_grants` | `organizer_id` | generate (tour) | me, generate |

Notes:

- `scanned_days` is a comma string, not a table. The scan's compare-and-set depends on comparing the old string exactly.
- `status = 'scanned'` means *all* allowed days are used. A 3-day pass scanned on day 1 is still `valid`.
- The QR code holds only the ticket id. There is no signature in the QR, so security relies on ids being unguessable (8 chars from a 32-letter alphabet ≈ 10¹² combinations) and on scanning needing a gate token.
- The schema comment says gate PIN is 4 digits; the code generates 6.

---

## 5. Security model

| Credential | How you get it | Lives in | Lifetime | Can do |
|---|---|---|---|---|
| Admin token (`role: admin`) | login / register / reset / master key | `localStorage.admin_key` in admin.html | 7 days, or until password change | Everything for that organizer |
| Gate token (`role: gate`, `evt`) | event id + gate PIN | `localStorage.scanner_key` in scanner.html | 14 days | Only `/api/check` for that one event |
| Reset token (`role: reset`) | emailed link, in the URL `#fragment` | the email | 30 min, single use via `pv` | Only `/api/auth/reset` |
| Master key `SCANNER_ACCESS_KEY` | Worker secret | you | forever | Becomes owner admin (`OWNER_ORG_ID`, default `org_raghav`) |

Layers, outside in:

1. `_headers` CSP: restricts which domains pages can load scripts from or send data to.
2. Lockouts and quotas in `auth_attempts`.
3. HMAC-signed tokens checked on every API call.
4. Role wall: gate tokens can only scan.
5. Tenant scoping: every query filtered by `organizer_id`.
6. Atomic SQL: credit spend (`ticket_credits >= ?`), scan compare-and-set, payment idempotency.

---

## 6. Frontend

All pages are plain HTML with inline CSS and JS. No framework, no build step. Edit and refresh. External libraries come from `cdnjs.cloudflare.com`, so the CSP must allow it.

### 6.1 `scanner.html` (gate app)

| Part | Line | Does |
|---|---|---|
| html5-qrcode CDN script | 12 | Camera QR decoding. If the CDN is down, scanning stops (manual entry still works). |
| State + `API_URL` | ~1068 | Reads saved token, event, gate name, day from `localStorage`. |
| Day UI (`updateEventDayUI`, `setEventDay`, day picker) | 1088–1130 | Shows the current day. The server's `eventDay` overrides it after each scan. |
| Sounds (`playTone`, `playSoundForTier`, `toggleMute`) | 1131–1180 | Web Audio beeps per result/tier. |
| `verifyKey` | 1181 | Login: tries `/api/gate/auth` with event + PIN, falls back to `/api/auth-verify` for an admin token or master key. Saves the token. |
| `startScanning`, `changeName` | 1244, 1268 | Enter scan mode; set the gate name logged as `gate_device_id`. |
| `initCamera`, `switchCamera`, `toggleTorch` | 1279–1397 | Camera lifecycle. Needs HTTPS (or localhost) and `camera=(self)` in `Permissions-Policy`. |
| `handleDetectedCode` | 1398 | Debounces repeat reads, pauses the camera, POSTs `/api/check`, reloads on 401, shows "Network Error" on fetch failure. |
| `showScanResult` | 1448 | Big coloured overlay: valid / duplicate / wrong_day / invalid / notfound. |
| Re-entry, next, auto-scan, manual check | 1609–1660 | Operator controls. Re-entry sends `allowReEntry: true`. |
| Boot | ~1660 | Reads `?event=` / `?pin=` from the gate link, auto-logs in if a token is saved. |

### 6.2 `admin.html` (organizer app)

Lines 20–964 are CSS. Lines ~965–1988 are markup: the auth screen, then tabs `tab-directory` (home: KPIs + ticket table, line 1120), `tab-studio` (pass designer, 1208), `tab-assign` (1480) and `tab-settings` (1522), plus modals. Lines 1989–5005 are one `<script>`, split by banner comments:

| Banner (search for it) | Line | Does |
|---|---|---|
| STEP 1: AUTHENTICATION & MULTI-TENANT INITIALIZATION | 2035 | Sign-in / sign-up forms, `verifyAdminKey`, `enterApp` (starts the 15 s stats poll), `apiFetch`-style helper at ~2097. |
| GUIDED TOUR | 2168 | Spotlight tour; done-state in `localStorage`. Uses free tour tickets. |
| HELP MODE | 2385 | "?" badges. Also sign-out, password change, export, delete account (~2484–2560). |
| EVENT SELECTOR & GATE PIN SHARING | 2617 | `loadEvents`, event switcher, `copyGateLink` (builds the scanner URL with event + PIN), new-event modal. |
| STEP 2: LOAD TICKETS & SERVER-SIDE PAGINATION | 2769 | `loadAllTickets` → `/api/tickets`. |
| STEP 3: EDGE STATS POLLING | 2844 | `pollStats` with `If-None-Match`, `applyStatsToKPIs`. |
| STEP 4: RECHARGE & BILLING | 2901 | Credit pack modal, lazy-loads Razorpay checkout, then create-order → checkout → verify-order. Also table filters, `renderTable`, inline `saveAttendeeField`. |
| STEP 3: TICKET STUDIO & MOVABLE CANVAS | 3162 | Template upload (stored as a data URL in `localStorage`), per-element size/colour controls, layout saved under `studio_layout_v3`. |
| HIT TESTING | 3600 | Dragging elements on the canvas. |
| CANVAS COMPOSITOR ENGINE | 3758 | `renderStudioCanvas`: draws artwork + QR + name + tier + header into a canvas. Every pass image comes from here. |
| STEP 4: BATCH PASS COMPILER | 4082 | Renders many passes, zips them with JSZip, saves with FileSaver; pause/resume/cancel; warns before unload. |
| STEP 5: MULTI-TIER & MULTI-DAY GENERATION | 4316 | Generate modal → `/api/generate`; CSV/XLSX import (SheetJS lazy-loaded); assign flow → `/api/assign` with dry-run preview. |
| STEP 6: DATABASE MAINTENANCE & RESET | 4804 | Reset-scans / wipe modal → `/api/reset-db`. |
| STEP 7: EMAIL DISPATCHER & CSV EXPORT | 4861 | `renderPassForEmail` (canvas → jsPDF), `dispatchSinglePass`, `bulkDispatchPasses` (browser loop, backs off on 429), `exportCSV`. |

The banner numbers repeat (two "STEP 3", two "STEP 4") because the file grew in pieces. Search by banner text, not number.

### 6.3 Other pages

- `landing.html`: static marketing page plus FAQ. Links to `/signup` and `/login`.
- `reset.html`: reads `#token=` from the URL fragment (fragments are never sent to the server or logged), posts `/api/auth/reset`, saves the returned admin token, redirects to `/admin`.

---

## 7. End-to-end flows

### 7.1 Organizer onboarding
`/signup` → `admin.html?mode=signup` → `POST /api/auth/register` → token in `localStorage` → `enterApp` → `/api/auth/me`, `/api/events`, `/api/stats`, `/api/tickets`.

### 7.2 Making tickets
Create event (`POST /api/events`) → Generate (`POST /api/generate`): credits reserved with a conditional UPDATE, then all INSERTs in one batch → optional Assign (`POST /api/assign`) to name blank tickets.

### 7.3 Getting passes to attendees
Studio renders each pass in the browser → either download a ZIP (`/api/mark-rendered`) or email: browser renders PDF → `POST /api/send-email` with base64 PDF → Worker → Resend → `email_sent_at` set.

### 7.4 Event day: a gate scan
1. Organizer copies the gate link (`/scan?event=…&pin=…`) and sends it to volunteers.
2. Scanner calls `POST /api/gate/auth` → gate token (14 days).
3. Camera reads a QR → `POST /api/check { ticketId, scannerName, eventDay, allowReEntry }`.
4. Worker:
   1. Loads the ticket joined to its event, filtered by organizer. A gate token for another event → "not found".
   2. `revoked` → red.
   3. `eventDayNow` → before/after event dates → "wrong day" (gates only; organizers may scan anytime for rehearsal).
   4. Day not in `allowed_days` → "wrong day".
   5. Already in `scanned_days` and not re-entry → "duplicate".
   6. **Compare-and-set**: `UPDATE … WHERE id = ? AND scanned_days = <old value>`. If 0 rows changed, another gate won the race → "duplicate".
   7. Insert `scan_logs` row → green "ENTRY APPROVED".
5. The organizer dashboard sees the new scan on its next 15 s poll (ETag changes because `MAX(scan_logs.id)` changed).

### 7.5 Buying credits
Choose pack → `POST /api/billing/create-order` (Worker calls Razorpay, stores `created` order) → Razorpay checkout popup → browser receives `payment_id` + `signature` → `POST /api/billing/verify-order` → HMAC check → batch: add credits only `WHERE … status = 'created'`, mark `paid`.

---

## 8. What breaks when…

| Symptom | Most likely cause | Where to look |
|---|---|---|
| Every API call: `"Server misconfigured" … DB` | D1 binding missing / wrong `database_id` | `worker/wrangler.toml` |
| Every API call: `"Server misconfigured" … SESSION_SECRET` | Secret not set in prod | `npx wrangler secret put SESSION_SECRET --cwd worker` |
| Everyone suddenly logged out, gates too | `SESSION_SECRET` changed | §3.2 |
| Login/register randomly fail with Cloudflare 1102 | Free-plan 10 ms CPU limit vs PBKDF2 | `docs/HOSTING.md` §2.1 |
| Gate shows "EVENT HASN'T STARTED/HAS ENDED" for all | Wrong `start_date`/`timezone` on event | `eventDayNow`, `events` row |
| Gate "Too many failed attempts" | Shared venue IP hit lockout | `auth_attempts` rows `gate:<event>:<ip>` |
| Scanner camera black / never starts | Not HTTPS, permission denied, CSP/Permissions-Policy changed, html5-qrcode CDN failed | `_headers`, browser console |
| Scanner "Network Error" | Phone offline, or Worker returned non-JSON (crash) | `wrangler tail` |
| Scans slow (>1 s) | D1 primary far away | `docs/HOSTING.md` §2.2 |
| "Ticket not found" for a real ticket | Gate link is for another event, or ticket belongs to another organizer, or QR has extra whitespace/prefix | `routes/scan.js`, the first SELECT |
| Same pass admitted twice | Shouldn't happen (compare-and-set). Check `allowReEntry` usage and `scan_logs`. | `routes/scan.js`, step 3 compare-and-set |
| Generate: "Insufficient Ticket Credits" | Balance < tickets requested | `organizers.ticket_credits` |
| Paid but no credits | Tab closed before `verify-order`; no webhook exists | `credit_orders` row stuck in `created`; credit manually after checking Razorpay dashboard |
| Emails not arriving | `RESEND_API_KEY` missing, `EMAIL_FROM` domain not verified in Resend, daily cap hit, or landed in spam | `lib/email.js` → `sendPassEmail`; queue failures show in `wrangler tail` as "email queue: not sent" |
| Bulk email stopped halfway | Organizer closed the tab during "Email unsent" (a browser loop) | Re-run sends only unsent, or use "Send in background" (queue) |
| "Send in background" does nothing | Queue `tixdesk-email` not created, consumer erroring, or Resend daily limit | `npx wrangler queues list`, `wrangler tail` |
| Sudden 429 "Too many requests" | Rate limiter: 20 auth calls/min per IP or 300 API calls/min per token | `index.js` → `overRateLimit`, `[[ratelimits]]` in `worker/wrangler.toml` |
| Pass design lost | It lives in that browser's `localStorage` only | Studio section; different browser/device = blank studio |
| Razorpay popup won't open | CSP missing Razorpay domains, or keys unset | `_headers`, `RAZORPAY_KEY_ID` |
| Dashboard numbers stale | Poll paused while tab hidden; or ETag bug | `pollStats`, `/api/stats` |

---

## 9. Config, secrets and tooling

Secrets (set with `npx wrangler secret put NAME --cwd worker`, locally in `worker/.dev.vars`):

| Name | Required | Used for |
|---|---|---|
| `SESSION_SECRET` | yes | Signing every token |
| `SCANNER_ACCESS_KEY` | optional | Master key → owner admin; session secret fallback |
| `OWNER_ORG_ID` | optional | Which organizer the master key logs in as (default `org_raghav`) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_DAILY_CAP` | for email | Pass + reset emails |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | for payments | Orders + signature check |
| `DEMO_BILLING` | optional | Fake payments when Razorpay isn't configured. **Must be off in production**: it gives free credits. |
| `APP_URL` | optional | Base URL in reset emails |
| `ALLOWED_ORIGINS` | optional | Extra CORS origins |

Commands:

```bash
npm run dev
```
```bash
npm run db:migrate:local
```
```bash
npm run db:seed:local
```
```bash
npx wrangler deploy --dry-run --cwd worker
```
(bundles every module and lists bindings without deploying; catches missing files and broken imports)
```bash
npx wrangler queues create tixdesk-email
```
(once, before the first deploy with the queue)
```bash
npm run deploy
```
```bash
npx wrangler tail --cwd worker
```

---

## 10. Known weak spots

Ranked by how much they can hurt on a real event.

1. **No tests.** The scan logic, credit logic and tenant scoping have no automated checks. A small edit in `/api/check` can admit duplicates or reject valid passes, and nothing catches it before an event. Add Vitest with Cloudflare's Workers pool, starting with `/api/check` cases.
2. **No payment webhook** (§7.5). Paid credits can go missing.
3. **`seed.sql` has a plaintext password and a known gate PIN.** Checked 2 Nov 2026: `org_raghav` does not exist in the remote DB, so it was never seeded there. Keep it that way: only ever run `seed.sql` with `--local`.
4. **Scanner stores the raw gate PIN in `localStorage`** when logged in with a PIN (`scanner.html:1224`). Accepted: the PIN is already shared with every volunteer, and the phone is in trusted hands.
5. **One 5,000-line admin file.** The backend is now split into modules. For the frontend, each banner section of `admin.html` could move into its own `.js` file under `public/js/` (no build step needed).
6. **Module-level `allowedOrigins`** in `lib/http.js` is reset on every request by `setAllowedOrigins(env)`. Harmless today, because every request sets the same value from `env`. It becomes a bug if it ever starts depending on the request.
7. **Studio design is per-browser** (`localStorage`). Organizers switching laptops lose their template. Store it per event in D1 (layout JSON) and R2 (artwork).

Hosting-specific findings are in [HOSTING.md](HOSTING.md).
