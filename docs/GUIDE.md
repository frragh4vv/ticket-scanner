# TixDesk from zero: a beginner's guide to every file and every request

This guide assumes you know a little JavaScript and nothing else. It explains what each file does, who talks to whom, and exactly what data travels in each direction. Read it top to bottom once. After that, use it as a lookup.

Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (the compact map and troubleshooting table), [HOSTING.md](HOSTING.md) (why Cloudflare, limits, costs), [INTEGRATIONS.md](INTEGRATIONS.md) (future selling features).

---

## Part 1. Words you need first

| Word | Meaning in this project |
|---|---|
| **Client** | The program that asks for something. Here: a browser running `admin.html` or `scanner.html`. |
| **Server** | The program that answers. Here: the Cloudflare Worker in `worker/src/`. |
| **Request** | A message from client to server. It has a **method** (`GET` = read, `POST` = do something), a **path** (`/api/check`), **headers** (labels like `Authorization`), and sometimes a **body** (the data, as JSON). |
| **Response** | The server's answer: a **status code** (200 OK, 400 bad input, 401 not signed in, 403 not allowed, 404 not found, 429 too many, 500 server broke) plus headers and a body. |
| **JSON** | Text format for data: `{"ticketId": "VIP-7K2P9QXA", "eventDay": 1}`. Both sides use it. |
| **Endpoint / route** | One path the server understands, like `POST /api/check`. |
| **Database (DB)** | Where data lives permanently. Here: **D1**, Cloudflare's hosted **SQLite**. Data sits in **tables** (like spreadsheets) made of **rows** (one record) and **columns** (fields). |
| **SQL** | The language for talking to the DB: `SELECT` reads, `INSERT` adds, `UPDATE` changes, `DELETE` removes. |
| **Worker** | A small program Cloudflare runs in its data centres for every request. Our whole backend is one Worker named `tixdesk`. |
| **Binding / `env`** | How the Worker reaches things Cloudflare gives it. `env.DB` is the database, `env.ASSETS` is the HTML files, `env.EMAIL_QUEUE` is the queue, `env.AUTH_LIMITER` is a rate limiter, and `env.SESSION_SECRET` etc. are secrets. Configured in `worker/wrangler.toml`. |
| **Token / session** | A signed string the server gives you after you prove who you are. You send it back on every request in the `Authorization: Bearer <token>` header so the server knows it's you. |
| **Hash** | A one-way scramble. We store a hash of each password, never the password. |
| **HMAC** | A hash mixed with a secret key. Only someone with the key can produce a matching one. Used to sign tokens and to check Razorpay payments. |
| **localStorage** | A small key-value store inside each browser. Pages keep the token and settings there. It never leaves that browser. |
| **Queue** | A to-do list on Cloudflare. One part of the code adds jobs, another part processes them later, in the background. |
| **Rate limit** | A cap like "at most 20 tries a minute" that stops floods and password guessing. |
| **Tenant** | One organizer's private slice of the data. "Tenant scoping" means organizer A can never see organizer B's tickets. |

---

## Part 2. The life of one request

Say a gate volunteer scans a QR code. Here is everything that happens, in order.

1. **Phone camera** sees the QR. The QR holds only the ticket id, e.g. `VIP-7K2P9QXA`.
2. **`scanner.html` → `handleDetectedCode()`** sends:
   ```
   POST https://tixdesk.app/api/check
   Content-Type: application/json
   Authorization: Bearer st.eyJyb2xlIjoiZ2F0ZSIs....AbC123

   {"ticketId":"VIP-7K2P9QXA","scannerName":"Gate 1","eventDay":1,"allowReEntry":false}
   ```
3. **Cloudflare** receives it at the data centre nearest the phone and starts our Worker: `worker/src/index.js` → `fetch(request, env)`.
4. **`index.js`** checks, in order:
   - Is it `OPTIONS`? (No.)
   - Is the path outside `/api/`? (No, so it's not a page request.)
   - Do `env.DB` and the session secret exist? (Yes.)
   - Pulls the token out of `Authorization` and the phone's IP out of `CF-Connecting-IP`.
   - **Rate limit:** `API_LIMITER` allows 300 calls a minute for this token. (Fine.)
   - **Verify token:** `lib/session.js` → `verifySession()` checks the HMAC signature and expiry. Result: `{ role: "gate", sub: "org_ab12…", evt: "evt_17…", exp: … }`.
   - Builds `ctx` = `{ request, env, url, origin, bearer, session, clientIp }`.
   - Asks `routes/public-auth.js` → `handle(ctx)`. It's not a public path, so the answer is `null` and we move on.
   - **Session wall:** the token is valid and is a gate token, so continue. Sets `ctx.organizerId` and `ctx.isAdmin = false`.
   - Asks `routes/scan.js` → `handle(ctx)`. The path matches, so this module takes over.
5. **`routes/scan.js`** talks to D1:
   - `SELECT` the ticket joined with its event, **only if the event belongs to this organizer**.
   - Works out today's event day with `lib/eventday.js`.
   - Checks revoked / wrong day / already scanned.
   - `UPDATE tickets SET scanned_days = '1', status = … WHERE id = ? AND scanned_days = ''` (only succeeds if nobody else scanned it in the same instant).
   - `INSERT INTO scan_logs (…)`.
6. **Response** back to the phone:
   ```json
   {
     "result": "valid",
     "message": "ENTRY APPROVED • DAY 1 (1/3 Days Used)",
     "isReEntry": false,
     "ticket": { "id": "VIP-7K2P9QXA", "tier": "VIP", "attendee_name": "Ann", "status": "valid",
                 "total_days": 3, "allowed_days": [1,2,3], "days_used": 1, "pass_type_name": "3-Day Pass" },
     "eventDay": 1, "daysUsed": 1, "totalDays": 3, "allDaysUsed": false
   }
   ```
7. **`scanner.html` → `showScanResult()`** paints the screen green and plays the VIP tone.
8. Up to 15 seconds later, the organizer's **`admin.html` → `pollStats()`** asks `/api/stats`, sees the new scan, and updates the dashboard.

Every other feature follows this same shape: page → request → `index.js` → one route module → D1 (and maybe an outside service) → response → page updates.

---

## Part 3. The repository, folder by folder

```
ticket-scanner/
├── package.json            shortcuts for wrangler commands (npm run dev / deploy / …)
├── local_dev_server.mjs    run the Worker on plain Node with a local SQLite file
├── qrmaker.py, main.py     old Python QR tool (not connected to the app)
├── docs/                   these guides
└── worker/                 everything that gets deployed
    ├── wrangler.toml       Cloudflare config: name, files, database, limiters, queue
    ├── schema.sql          creates the database tables
    ├── seed.sql            demo data, local only
    ├── .dev.vars           local secrets (never committed)
    ├── src/                the backend (server code)
    └── public/             the frontend (pages the browser downloads)
```

### 3.1 Config files

**`worker/wrangler.toml`**: Cloudflare reads this when you run `npm run dev` or `npm run deploy`.
- `name = "tixdesk"`: the Worker's name.
- `main = "src/index.js"`: the file Cloudflare starts.
- `[assets] directory = "./public"`: upload these files as the website. `binding = "ASSETS"` lets code fetch them as `env.ASSETS`.
- `[[d1_databases]]`: connects `env.DB` to the database `ticket-scanner-db` (id `5bf577bf-…`).
- `[[ratelimits]]` ×2: creates `env.AUTH_LIMITER` (20/min) and `env.API_LIMITER` (300/min).
- `[[queues.producers]]`: lets code put jobs on the `tixdesk-email` queue as `env.EMAIL_QUEUE`.
- `[[queues.consumers]]`: tells Cloudflare to deliver that queue's jobs to our Worker's `queue()` function, 10 at a time, retrying up to 3 times.

**`worker/.dev.vars`**: secrets for local runs, one `NAME=value` per line. In production the same names are stored with `npx wrangler secret put NAME --cwd worker`. They all appear in code as `env.NAME`.

**`package.json`**: only `scripts`. `npm run dev` = `npx wrangler dev --cwd worker` (local server at `http://localhost:8787`). `npm run deploy` uploads to Cloudflare.

### 3.2 `worker/schema.sql`: the tables

Run once to create the database. Every `CREATE TABLE IF NOT EXISTS` is safe to re-run.

| Table | One row is… | Example row |
|---|---|---|
| `organizers` | an account | `id=org_k2j…, email=a@b.co, company_name=Co, password_hash=pbkdf2$100000$…, ticket_credits=45` |
| `events` | one event | `id=evt_1793…_vvj8, organizer_id=org_k2j…, title=Fest, total_days=2, start_date=2026-11-15, gate_pin=482913, use_tiers=1, timezone=Asia/Kolkata` |
| `tickets` | one pass | `id=VIP-7K2P9QXA, event_id=evt_…, attendee_name=Ann, email=ann@x.co, tier=VIP, allowed_days=ALL, scanned_days=1, status=valid, email_sent_at=NULL` |
| `scan_logs` | one admitted scan | `id=17, ticket_id=VIP-7K2P9QXA, event_id=evt_…, scanned_day=1, gate_device_id=Gate 1, scan_timestamp=2026-11-15 18:02:11` |
| `credit_orders` | one credit purchase | `order_id=order_Nx…, organizer_id=org_k2j…, credits_purchased=500, amount_inr=5000, status=paid` |
| `auth_attempts` | a counter | `key=login:a@b.co, failures=3, window_start=1793644051` |
| `tour_grants` | "this organizer used the free tour tickets" | `organizer_id=org_k2j…` |

The arrows: an organizer has many events; an event has many tickets; a ticket has many scan logs. Deleting an event deletes its tickets and their scan logs (`ON DELETE CASCADE`). The `CREATE INDEX` lines at the bottom make lookups by event, tier and status fast.

### 3.3 `worker/seed.sql`
Inserts a demo organizer (`org_raghav`, password `demo123` in plain text), an event with gate PIN `8421`, and 5 tickets. Use only with `npm run db:seed:local`. On first login, the plain password is automatically re-hashed.

---

## Part 4. The backend, file by file (`worker/src/`)

The import direction is always: `index.js` → `routes/*` → `lib/*` → `config.js`. Lower files never import higher ones. So a bug in `lib/session.js` can affect every route, but a bug in `routes/billing.js` only affects billing.

### 4.1 `index.js`: the front door

**Exports** `{ fetch, queue }`. Cloudflare calls `fetch(request, env)` for every web request and `queue(batch, env)` when queued jobs are ready.

**`fetch` does:**
1. `setAllowedOrigins(env)`: refreshes the list of other websites allowed to call the API (from `ALLOWED_ORIGINS`).
2. `OPTIONS` requests (browsers' "may I?" check before cross-site calls) get an empty reply with CORS headers.
3. **Pages:** if the path doesn't start with `/api/`, it serves a file from `env.ASSETS`:
   - `/scan`, `/scanner`, `/?pin=…` → `scanner.html`
   - `/`, `/landing` → `landing.html`
   - `/admin`, `/login`, `/signup` → `admin.html` (`/signup` adds `?mode=signup` so the page opens on the sign-up tab)
   - `/reset` → `reset.html`
   - anything else → that file, or `404.html`
   It also adds security headers to every page.
4. **API:** checks `env.DB` and the session secret exist, reads the token and IP, runs `overRateLimit()`, verifies the token, builds `ctx`, then:
   - `routes/public-auth.js` first (no sign-in needed),
   - session wall (401 if no valid token),
   - `routes/scan.js` (gate and organizer tokens),
   - role wall (403 for gate tokens on anything else),
   - then each of `ORGANIZER_ROUTES` in order: `account`, `events`, `billing`, `stats`, `tickets`, `email`.
   - Nobody claimed it? `404 {"error":"Endpoint not found"}`.
   - Anything threw an error? Log it, `500 {"error":"Internal Server Error"}`.

**`overRateLimit(env, request, url, bearer, clientIp)`**: for the 6 sign-in-type paths, it keys by `IP + path` with `AUTH_LIMITER`. For other `/api/` paths, it keys by the last 24 characters of the token with `API_LIMITER`. Gates share venue Wi-Fi, so keying by token stops one busy gate from blocking the others. If the binding doesn't exist (e.g. `local_dev_server.mjs`), there's no limit.

**`queue(batch, env)`**: passes `tixdesk-email` batches to `queue/email-consumer.js`.

### 4.2 `config.js`: numbers in one place

| Name | Value | Used by |
|---|---|---|
| `ALLOWED_HEADERS`, `ALLOWED_METHODS` | CORS lists | `lib/http.js` |
| `VALID_TIERS` | `VIP`, `General`, `Guestlist` | tickets routes |
| `MAX_TICKETS_PER_BATCH` | 1000 | generate, assign, mark-rendered |
| `ADMIN_SESSION_TTL` | 7 days | organizer tokens |
| `GATE_SESSION_TTL` | 14 days | gate tokens |
| `MAX_FAILED_ATTEMPTS`, `ATTEMPT_WINDOW_SECONDS` | 10 per 15 min | lockouts |
| `GATE_EVENT_MAX_FAILURES` | 100 | all-IP cap per event |
| `PBKDF2_ITERATIONS` | 100,000 | password hashing |
| `CREDIT_PACKS` | starter 500/₹5,000, pro 2,500/₹20,000, enterprise 10,000/₹50,000 | billing |
| `DEFAULT_EVENT_TZ`, `DAY_ROLLOVER_HOUR` | Asia/Kolkata, 6 | event-day clock |
| `EMAIL_RE` | basic email pattern | register, generate, assign |

Change a number here and every file using it changes behaviour.

### 4.3 `lib/http.js`: building responses
- `json(data, status, origin, extraHeaders)` → a `Response` with the JSON body, `Content-Type: application/json`, `Cache-Control: no-store`, security headers and CORS headers. **Every API answer** is made with this.
- `getCorsHeaders(origin)`: adds `Access-Control-Allow-Origin` only for origins in `ALLOWED_ORIGINS` or `localhost`.
- `setAllowedOrigins(env)`: see Part 9.
- `SECURITY_HEADERS`: `nosniff`, `Referrer-Policy`, `Strict-Transport-Security`.
- `lockedOutResponse(origin)` → `429 {"ok":false,"error":"Too many failed attempts. Try again in 15 minutes."}`.

### 4.4 `lib/util.js`: small helpers
- `generateRandomCode(8)` → e.g. `7K2P9QXA`, from 32 letters/digits with no `0 O 1 I`.
- `generatePin()` → `482913` (6 digits).
- `getTierPrefix("Guestlist")` → `GST` (VIP → `VIP`, General → `GEN`).
- `escapeHtml("<b>")` → `&lt;b&gt;`, so names can't inject HTML into emails.
- `parseDays("1,3", 3)` → `[1, 3]`; `parseDays("ALL", 3)` → `[1, 2, 3]`.

### 4.5 `lib/crypto.js`: secrets maths
- `hmac(secret, data)` → bytes of HMAC-SHA256.
- `timingSafeEqual(a, b)`: compares strings in constant time, so attackers can't guess a PIN character by character from response speed.
- `hashPassword("password123")` → `pbkdf2$100000$<salt>$<hash>`. Slow on purpose (~16 ms) so stolen hashes are expensive to crack.
- `verifyPassword(password, stored)` → `true/false`. Accepts old plain-text rows (seed data) too.
- `bytesToB64url`, `b64urlToBytes`, `bytesToHex`, `encoder`: format converters.

### 4.6 `lib/session.js`: tokens
- `signSession(env, { role, sub, … }, ttl)` → `st.<payload>.<signature>`. Payload is base64url JSON like `{"role":"admin","sub":"org_k2j…","pv":"a1b2…","exp":1794248851}`.
- `verifySession(env, token)` → the payload object, or `null` if the signature is wrong, it's expired, or it isn't an `st.` token.
- `getSessionSecret(env)` → `SESSION_SECRET` (or `SCANNER_ACCESS_KEY` as fallback).
- `passwordFingerprint(hash)` → 16 hex characters derived from the stored password hash.
- `adminSession(env, org)` → a 7-day admin token that includes `pv` = the fingerprint.
- `adminSessionIsCurrent(env, session)` → reads the organizer's current hash and checks `pv` still matches. If the password changed, old tokens fail here.

### 4.7 `lib/limits.js`: counting failures and quotas
All counters live in the `auth_attempts` table.
- `isLockedOut(env, key, limit=10)` → `true` if `key` has ≥ limit failures inside the 15-minute window.
- `recordFailure(env, key)` → +1 (starts a new window if the old one expired).
- `clearFailures(env, key)` → deletes the counter (after a success).
- `consumeQuota(env, key, limit, seconds)` → counts every call; returns `false` once the limit is reached. Used for: 5 sign-ups/hour per IP, 3 reset emails/hour per email, 10/hour per IP, the daily email cap, and "queue once per 10 minutes".

### 4.8 `lib/eventday.js`: what day is it?
- `validTimeZone("Asia/Kolkata")` → `true`.
- `eventDayNow("2026-11-15", 3, "Asia/Kolkata")` at 1 AM on 16 Nov IST → `{ day: 1, total: 3, before: false, after: false }`. It's still day 1 because days roll over at 6 AM.

### 4.9 `lib/scope.js`: never leak another organizer's data
- `eventScope("evt_1", "org_A")` → `{ sql: "event_id IN (SELECT id FROM events WHERE id = ? AND organizer_id = ?)", params: ["evt_1","org_A"] }`.
- `eventScope("ALL", "org_A")` → every event owned by `org_A`.
Routes paste `scope.sql` into their `WHERE` and pass `scope.params` to `.bind()`.

### 4.10 `lib/email.js`: one pass email
`sendPassEmail(env, organizerId, { ticketId, email, eventName, passImageData, passPdfData, onlyIfUnsent })`:
1. Loads the ticket (only if it belongs to this organizer). Missing → `{status:404}`.
2. If `onlyIfUnsent` and the ticket was already emailed or revoked → `{status:200, body:{skipped:true}}`.
3. Picks the recipient (`email` argument, else the ticket's email). Invalid → `{status:400}`.
4. Builds the HTML email: event title, greeting with first name, ticket id, tier chip.
5. Attachment: `passPdfData` (a `data:application/pdf;base64,…` string under ~7 MB) or `passImageData` (PNG/JPEG under ~5 MB). Without one, the QR image goes in the email body (drawn by `api.qrserver.com`).
6. No `RESEND_API_KEY` → `{status:500}`. Daily cap reached → `{status:429}`.
7. Sends to Resend:
   ```
   POST https://api.resend.com/emails
   Authorization: Bearer <RESEND_API_KEY>
   {"from":"Tickets <…>","to":["ann@x.co"],"subject":"Your ticket for Fest","html":"<!DOCTYPE html>…","attachments":[{"filename":"VIP-7K2P9QXA.pdf","content":"JVBERi0…"}]}
   ```
8. Resend failed → `{status:502}` (or 429 if Resend is throttling). Success → sets `tickets.email_sent_at = now`, returns `{status:200, body:{success:true, message:"Email dispatched successfully"}}`.

It returns `{status, body}` instead of a `Response` so both the web route and the queue consumer can use it.

### 4.11 `queue/email-consumer.js`
`consumeEmailBatch(batch, env)`: for each message `{ ticketId, organizerId }`, call `sendPassEmail(…, { onlyIfUnsent: true })`, then:
- 200/400/404/500/daily-cap → `message.ack()` (done; retrying wouldn't help).
- Resend throttled (429) → `message.retry({ delaySeconds: 60 })`.
- Resend error (502) or a crash → retry in 30 s. After 3 retries Cloudflare drops it, and the ticket stays "unsent" in the dashboard.

---

## Part 5. Every API endpoint: who calls it, what goes in, what comes out

Format for each: **caller** → request → what the server does → response. "Token" means the `Authorization: Bearer …` header. ⚠ marks the important errors.

### 5.1 Public (`routes/public-auth.js`, no token needed)

**`POST /api/auth/register`**: `admin.html` → `submitAuth()` (sign-up tab)
- In: `{"email":"a@b.co","password":"password123","company_name":"Co","accept_terms":true}`
- Server: validates email/password length (8–200) and terms; quota 5/hour per IP; checks the email is unused; `hashPassword`; one batch inserts the organizer (50 credits) and a starter event "My First Event" with a random PIN.
- Out 200: `{"ok":true,"token":"st.…","organizer":{"id":"org_…","email":"a@b.co","company_name":"Co","ticket_credits":50}}`
- ⚠ 400 email exists / bad input; 429 too many sign-ups.

**`POST /api/auth/login`**: `admin.html` → `submitAuth()`
- In: `{"email":"a@b.co","password":"password123"}`
- Server: lockout check on `login:<email>`; loads the organizer; `verifyPassword`; on failure `recordFailure`; on success clears failures and upgrades a plain-text hash.
- Out 200: `{"ok":true,"token":"st.…","organizer":{…,"ticket_credits":45}}`
- ⚠ 401 wrong email/password; 429 locked out (10 failures in 15 min).

**`POST /api/auth/forgot`**: `admin.html` "Forgot password"
- In: `{"email":"a@b.co"}`
- Server: quotas; if the account exists, signs a `reset` token (30 min) and emails `https://…/reset#token=…` via Resend.
- Out 200 **always**: `{"ok":true,"message":"If an account exists for that email, a reset link is on its way."}` (same answer either way, so nobody can test which emails have accounts).

**`POST /api/auth/reset`**: `reset.html`
- In: `{"token":"st.…","password":"newpassword1"}`
- Server: verifies the token is a `reset` token; checks its `pv` still matches (so each link works once); saves the new hash.
- Out 200: `{"ok":true,"token":"st.…"}` (an admin token, so the page logs you straight in).
- ⚠ 400 invalid / used / expired link.

**`POST /api/gate/auth`**: `scanner.html` → `verifyKey()`
- In: `{"event_id":"evt_…","pin":"482913"}`
- Server: lockouts per IP+event (10) and per event (100); loads the event; constant-time PIN compare.
- Out 200: `{"ok":true,"role":"gate","token":"st.…","event":{"id":"evt_…","title":"Fest","total_days":2,"start_date":"2026-11-15","timezone":"Asia/Kolkata"},"today":{"day":1,"total":2,"before":false,"after":false}}`. The PIN and organizer id are removed from `event` before sending.
- ⚠ 401 wrong PIN; 429 locked out.

**`POST /api/auth-verify`**: both pages on load, and the master-key login
- In: either just the token header, or `{"key":"<SCANNER_ACCESS_KEY>"}`
- Server: valid gate/admin token → echo it back. Otherwise, if the key equals the master key → admin token for `OWNER_ORG_ID`.
- Out 200: `{"ok":true,"role":"admin","token":"st.…"}`; ⚠ 401 `{"ok":false,"error":"Invalid access key"}`.

### 5.2 Scan (`routes/scan.js`, gate or organizer token)

**`POST /api/check`**: `scanner.html` → `handleDetectedCode()` / `manualCheck()`
- In: `{"ticketId":"VIP-7K2P9QXA","scannerName":"Gate 1","eventDay":1,"allowReEntry":false}`
- Server, step by step:
  1. Empty id → 400 `Missing ticketId`.
  2. Load the ticket + its event, only for this organizer. A gate token for a different event counts as not found.
  3. `status = revoked` → `result: "invalid"`.
  4. Event day from the event's start date and timezone. Gate token outside event dates → `result: "wrong_day"` ("EVENT HASN'T STARTED" / "EVENT HAS ENDED"). Organizer tokens may scan anytime (rehearsals) using the `eventDay` they send.
  5. Day not in `allowed_days` → `wrong_day`.
  6. Already scanned today and no `allowReEntry` → `duplicate`.
  7. Compare-and-set `UPDATE`. If 0 rows changed, another gate just scanned it → `duplicate`.
  8. Insert a `scan_logs` row. (Re-entries are logged too, but don't change the ticket.)
- Out 200 (always 200; look at `result`): `valid` | `duplicate` | `wrong_day` | `invalid` | `notfound`, plus `message`, `ticket{…}`, `eventDay`. A full example is in Part 2.

### 5.3 Account (`routes/account.js`, organizer token)

| Endpoint | Caller | In | Out |
|---|---|---|---|
| `GET /api/auth/me` | `initOrganizerSession()` | nothing | `{"ok":true,"organizer":{"id","email","company_name","ticket_credits","tour_tickets_used":false}}` |
| `GET /api/auth/export` | Settings → `exportAccount()` | nothing | A JSON file download: `{exported_at, organizer, events[], tickets[], scan_logs[], credit_orders[]}` |
| `POST /api/auth/password` | Settings → `changePassword()` | `{"current_password","new_password"}` | `{"ok":true,"token":"st.…"}`. The old token stops working everywhere. ⚠ 400 wrong current password |
| `POST /api/auth/delete` | Settings → `deleteAccount()` | `{"password","confirm":"DELETE"}` | `{"ok":true,…}`. Deletes scans, tickets and events; blanks the organizer row; keeps payment rows (tax records) |

### 5.4 Events (`routes/events.js`)

**`GET /api/events`**: `loadEvents()` → `{"ok":true,"events":[{id,title,total_days,start_date,gate_pin,use_tiers,timezone,created_at,…}]}` (newest first).

**`POST /api/events`**: `submitNewEvent()`
- In: `{"title":"Fest","total_days":2,"start_date":"2026-11-15","gate_pin":"","use_tiers":true,"timezone":"Asia/Kolkata"}`
- Server: title required; PIN = yours if 6–8 digits, else random; days clamped to 1–10; the start date can't be in the past (in the event's timezone); no duplicate titles per organizer.
- Out: `{"ok":true,"event":{…including gate_pin}}`. ⚠ 409 duplicate title.

### 5.5 Billing (`routes/billing.js`)

**`POST /api/billing/create-order`**: `executeCreditRecharge()`
- In: `{"pack":"starter"}`
- Server: if Razorpay keys exist, `POST https://api.razorpay.com/v1/orders` with `{"amount":500000,"currency":"INR","notes":{organizer_id,credits}}` (amount in paise) using Basic auth `key_id:key_secret`; else (local `DEMO_BILLING=true`) a fake `demo_…` id. Saves a `credit_orders` row with status `created`.
- Out: `{"ok":true,"order_id":"order_…","credits":500,"amount_inr":5000,"currency":"INR","razorpay_key_id":"rzp_…","demo":false}`
- The page then opens the Razorpay popup with that order id.

**`POST /api/billing/verify-order`**: after the popup succeeds
- In: `{"order_id":"order_…","razorpay_payment_id":"pay_…","razorpay_signature":"9f2c…"}`
- Server: recomputes `HMAC(key_secret, order_id + "|" + payment_id)`. Mismatch → order `failed`, 400. Match → one batch: add credits **only if** the order is still `created`, then mark it `paid`. Credits come from the saved order, never from the browser.
- Out: `{"ok":true,"success":true,"message":"Successfully credited 500 passes!","new_balance":545}`. ⚠ 409 already processed (safe replay).

### 5.6 Dashboard reads (`routes/stats.js`)

**`GET /api/stats?event_id=evt_…`** (or `ALL`): `pollStats()` every 15 s while the tab is visible
- Sends `If-None-Match: <last ETag>`.
- Server: counts totals per status and tier, counts scan logs, builds an ETag like `W/"stats-evt_…-6-1-1-17"`. If it matches what the browser has → **304** with no body (saves data). Else also loads scans per day and the last 15 scans.
- Out 200: `{"total":6,"scanned":1,"valid":5,"multiDayCount":3,"scansByDay":{"day_1":1,"day_2":0,…},"tiers":{"VIP":{"total":4,"scanned":1},…},"recentScans":[{"id","tier","attendee_name","scanned_by","scan_time","scanned_day"}]}`

**`GET /api/tickets?event_id=…&page=1&limit=50&tier=VIP&status=valid&q=ann&unsent=1`**: `loadAllTickets()`, `refreshUnsentCount()`, bulk email
- Out: `{"tickets":[{"id","attendee_name","email","phone","tier","total_days","allowed_days":[1,2],"scanned_days":[1],"days_used":1,"status":"Valid",…}],"total":6,"page":1,"limit":50,"totalPages":1}`

### 5.7 Ticket writes (`routes/tickets.js`)

**`POST /api/generate`**: Generate modal → `generateBlankTickets()`, and the tour
- In: `{"event_id":"evt_…","batches":[{"count":3,"tier":"VIP","allowed_days":"ALL"},{"tier":"General","allowed_days":[1],"attendees":[{"name":"Ann","email":"ann@x.co","phone":""}]}],"tour":false}`
- Server:
  1. Event must be yours.
  2. Attendee rows are cleaned. Each bad email → 400 with the row number.
  3. Total count 1–1,000.
  4. Tour mode: max 1 blank per tier, claimed once via `tour_grants` (no credits).
  5. **Reserve credits:** `UPDATE organizers SET ticket_credits = ticket_credits - N WHERE … AND ticket_credits >= N`. If 0 rows changed → 402 not enough credits.
  6. Insert all tickets in one batch (`VIP-xxxxxxxx`, etc.). If that fails, the credits are refunded.
- Out: `{"success":true,"count":4,"tickets":[{id,attendee_name,email,tier,total_days,allowed_days,status}],"remaining_credits":41}`. ⚠ 402 `INSUFFICIENT_CREDITS` with `current_credits` / `needed_credits`.

**`POST /api/assign`**: Assign tab → `assignRows()`
- In: `{"event_id":"evt_…","tier":"VIP","allowed_days":"ALL","rows":[{"name":"Ann","email":"ann@x.co"}],"dry_run":true}`
- Server: matches each row to an unused blank ticket of the same tier and days. With `dry_run` it only reports; otherwise it writes names/emails (only onto still-blank tickets).
- Out: `{"ok":true,"assigned":1,"tickets":[{"id","tier","attendee_name","email"}]}` (plus `"dry_run":true` on preview). No credits used.

**`POST /api/save-attendee`** (alias `/api/save-email`): clicking a table cell → `saveAttendeeField()`
- In: `{"ticketId":"VIP-…","attendee_name":"Ann B","email":"…","phone":"…","tier":"VIP"}` (any subset)
- Out: `{"success":true}`. ⚠ 404 not your ticket.

**`POST /api/mark-rendered`**: after studio downloads → `{"ticketIds":["VIP-…",…]}` → sets `rendered_at`. Out `{"success":true}`.

**`POST /api/reset-db`**: Settings → `executeDatabaseReset()`
- In: `{"mode":"reset_scans"|"wipe_all","confirm":"CONFIRM_RESET","event_id":"evt_…"}`
- `reset_scans`: deletes scan logs and makes tickets valid again (except revoked). `wipe_all`: deletes scan logs **and tickets**. Credits are not refunded.

### 5.8 Email (`routes/email.js`)

**`POST /api/send-email`**: `dispatchSinglePass()` and the "Email unsent" loop (`sendPassEmails()`)
- In: `{"ticketId":"VIP-…","email":"ann@x.co","eventName":"Fest","passPdfData":"data:application/pdf;base64,JVBER…"}`. The browser draws the pass with the studio design, turns it into a PDF with jsPDF, and sends it as text.
- Server: `lib/email.js` → `sendPassEmail` (see 4.10).
- Out: `{"success":true,"message":"Email dispatched successfully"}`. ⚠ 400 bad email, 429 daily cap / Resend throttling (the page waits and retries), 500 no Resend key, 502 Resend error.

**`POST /api/send-email/queue`**: "Send in background" → `queuePassEmails()`
- In: `{"event_id":"evt_…"}`
- Server: refuses `ALL` and refuses twice within 10 minutes per event; selects up to 1,000 unsent, non-revoked tickets that have an email; puts `{ticketId, organizerId}` messages on `env.EMAIL_QUEUE` in groups of 100.
- Out: `{"ok":true,"queued":37,"more":false}`. Emails then go out within minutes, **without** the studio PDF (QR in the body), because no browser is around to draw it.

---

## Part 6. The frontend, page by page (`worker/public/`)

All pages are single HTML files: styles in `<style>`, layout in HTML, behaviour in one `<script>`. No React, no build step. Edit the file, refresh the browser.

### 6.1 `scanner.html`: the gate app
Screens: **login** (event + PIN) → **camera** → **result overlay**.

| Function | Does | Talks to |
|---|---|---|
| boot code (bottom) | Reads `?event=` and `?pin=` from the gate link, or the saved token from `localStorage.scanner_key`, and logs in automatically | `verifyKey()` |
| `verifyKey()` | Tries `POST /api/gate/auth`; if that's not a PIN login, tries `POST /api/auth-verify` (organizer token or master key). Saves the token, last event and gate name to `localStorage` | server |
| `initCamera()`, `switchCamera()`, `toggleTorch()` | Starts the html5-qrcode library from cdnjs; picks the back camera; flashlight | browser camera |
| `handleDetectedCode(code)` | Ignores repeats, pauses the camera, `POST /api/check`. A 401 reloads the page (re-login); a network failure shows "Network Error" | server |
| `showScanResult(data)` | Big coloured overlay and text by `result`; plays a tone | Web Audio |
| `playTone()`, `playSoundForTier()`, `toggleMute()` | Beeps | — |
| `setEventDay()`, day picker | Shows the day; the server's `eventDay` overrides it | `localStorage.scanner_event_day` |
| `triggerReEntryScan()` | Re-sends the last ticket with `allowReEntry: true` | server |
| `manualCheck()` | Type an id when the QR won't read | server |

Stored in `localStorage`: `scanner_key` (token or PIN), `scanner_last_event`, `scanner_name`, `scanner_event_day`.

### 6.2 `admin.html`: the organizer app
Layout: login/sign-up screen, then four tabs: **Home** (`tab-directory`: numbers + ticket table), **Ticket studio** (`tab-studio`: pass designer), **Assign** (`tab-assign`: paste names), **Settings** (`tab-settings`). Plus modals (new event, generate, recharge, reset, delete).

Script sections (search the banner text):

| Section | Key functions | Calls |
|---|---|---|
| STEP 1 Authentication | `submitAuth`, `verifyAdminKey`, `enterApp` (starts 15 s polling), `signOut`, `changePassword`, `exportAccount`, `deleteAccount` | register, login, auth-verify, password, export, delete |
| Guided tour / Help mode | `startTour`, `showTourStep`, `toggleHelpMode` | `generate` with `tour:true` |
| Event selector & gate PIN | `loadEvents`, `onEventSelectChanged`, `copyGateLink` (builds `/scan?event=…&pin=…`), `submitNewEvent` | events GET/POST |
| STEP 2 Tickets & pagination | `loadAllTickets`, `changePage`, `renderTable`, `filterTable`, `saveAttendeeField` | tickets, save-attendee |
| STEP 3 Stats polling | `pollStats`, `applyStatsToKPIs` | stats (with ETag) |
| STEP 4 Billing | `openRechargeModal`, `selectCreditPack`, `loadRazorpayScript`, `openRazorpayCheckout`, `executeCreditRecharge` | create-order → Razorpay popup → verify-order |
| Ticket studio, hit testing, compositor | `handleTemplateUpload`, `renderStudioCanvas`, `saveStudioLayout`, drag handlers | none (all in the browser; design saved to `localStorage`) |
| STEP 4 Batch pass compiler | `startBatchRenderPipeline`, `finalizeAndDownloadBatch` (JSZip + FileSaver) | tickets, mark-rendered |
| STEP 5 Generation & assign | `openGenModal`, `generateBlankTickets`, `importSpreadsheet` (loads SheetJS on demand), `assignRows`, `confirmAssign` | generate, assign |
| STEP 6 Reset | `executeDatabaseReset` | reset-db |
| STEP 7 Email & CSV | `renderPassForEmail` (canvas → jsPDF), `dispatchSinglePass`, `bulkDispatchPasses` (browser loop, keep tab open), `queuePassEmails` (background queue), `exportCSV` | send-email, send-email/queue |

Stored in `localStorage`: `admin_key` (token), `current_event_id`, the studio artwork (as a data URL), `studio_layout_v3` (element positions), and tour-done flags.

Outside libraries (from `cdnjs.cloudflare.com`): JSZip, FileSaver, jsPDF, qrcodejs. Razorpay checkout (`checkout.razorpay.com`) and SheetJS are loaded only when needed.

### 6.3 Other pages
- **`landing.html`**: marketing page. No API calls. Buttons go to `/signup` and `/login`.
- **`reset.html`**: reads `#token=` from the address bar, asks for a new password, `POST /api/auth/reset`, saves the returned token as `admin_key`, sends you to `/admin`.
- **`terms.html`, `privacy.html`, `cookies.html`, `refunds.html`, `contact.html`**: text pages with `site.css`.
- **`404.html`**: "page not found".
- **`consent.js`**: shows the storage notice bar once on public pages.
- **`_headers`**: security rules Cloudflare adds to every page. The important line is `Content-Security-Policy`: it lists the only outside domains pages may load scripts from (cdnjs, Razorpay) or talk to. Add a new CDN without updating it, and that script silently fails to load.

---

## Part 7. Outside services and what we send them

| Service | Who calls it | What we send | What we get |
|---|---|---|---|
| **Cloudflare D1** | every route, via `env.DB` | SQL + values | rows / change counts |
| **Cloudflare Queues** | `routes/email.js` sends; Cloudflare calls `queue()` | `{ticketId, organizerId}` | batches of those messages |
| **Cloudflare Rate Limiting** | `index.js` | a key string | `{ success: true/false }` |
| **Resend** | `lib/email.js`, forgot-password | from, to, subject, HTML, optional PDF/JPG attachment | email id, or an error |
| **Razorpay API** | `routes/billing.js` | create order: amount, currency, notes | order id |
| **Razorpay Checkout** (popup) | `admin.html` | order id, key id | payment id + signature, which go back to us |
| **api.qrserver.com** | the email recipient's mail app (an `<img>` in emails without an attachment) | ticket id in the URL | a QR PNG |
| **cdnjs.cloudflare.com** | the browser | — | JavaScript libraries |

---

## Part 8. Whole stories, start to finish

**A. A new organizer runs their first event**
1. `/signup` → `admin.html?mode=signup` → `POST /api/auth/register` → token saved → dashboard loads with `me`, `events`, `stats`, `tickets`.
2. New event → `POST /api/events` → gets PIN `482913`.
3. Generate 200 General tickets → `POST /api/generate` → credits go 50 → 0? No: 200 > 50, so **402**. They recharge: `create-order` → Razorpay popup → `verify-order` → 550 credits → generate succeeds → 350 left.
4. Paste a guest list in Assign → `POST /api/assign` (`dry_run` preview, then real).
5. Design the pass in Ticket studio (browser only).
6. Click **Email unsent** (PDF attached, keep the tab open) or **Send in background** (QR in the body, close the tab).
7. Event day: Copy gate link → volunteers open `/scan?event=…&pin=482913` → `POST /api/gate/auth` → scan, scan, scan (`POST /api/check`).
8. The dashboard updates every 15 s from `/api/stats`.

**B. Two gates scan the same screenshot at the same moment**
Both run `SELECT` and both see `scanned_days = ''`. Both run `UPDATE … WHERE scanned_days = ''`. SQLite runs writes one at a time, so the first changes 1 row → **valid**. The second changes 0 rows (because `scanned_days` is now `'1'`) → **duplicate**.

**C. A volunteer guesses PINs**
Each wrong PIN: `recordFailure` on `gate:<event>:<ip>` and `gate:<event>`. After 10 from one IP → locked 15 min. After 100 from all IPs → the whole event's PIN login is locked 15 min. Before any of that, `AUTH_LIMITER` caps them at ~20 attempts a minute without touching D1.

**D. Organizer changes their password**
`POST /api/auth/password` → new hash → new fingerprint. Every old admin token carries the old `pv`, so `adminSessionIsCurrent` fails → 401 → those browsers must log in again. Gate tokens don't carry `pv`, so gates keep working.

---

## Part 9. Two small mechanisms worth understanding

**Why `allowedOrigins` is "module-level"**
In `lib/http.js`, `let allowedOrigins = new Set()` sits outside any function. Cloudflare keeps one copy of our code loaded (an "isolate") and reuses it for many requests, sometimes several at once. So that variable is **shared by every request the isolate handles**. `index.js` calls `setAllowedOrigins(env)` at the start of each request, which overwrites it from `env.ALLOWED_ORIGINS`. That's safe today, because every request writes the exact same value. It would become a bug if someone made it depend on the request (say, per-organizer allowed sites). Request A could set it, then request B overwrite it while A is still waiting on the database, so A answers with B's list. Rule: anything that differs per request belongs in `ctx` or a function argument, never in a top-level `let`.

**Why responses are always JSON with a status**
The pages always do `const data = await res.json()` and then check `res.ok` / `data.error`. If the server ever returned HTML or nothing (for example, a crash outside the `try`), the page would show "Network Error" even though the network is fine. That's why every route goes through `json()` and why `index.js` wraps everything in `try … catch`.

---

## Part 10. Running it yourself

```bash
npm run dev
```
Starts a local copy at `http://localhost:8787` using a local D1 file (inside `worker/.wrangler/`), local rate limiters and a local queue.

```bash
npm run db:migrate:local
```
Creates the tables in that local D1.

```bash
npm run db:seed:local
```
Adds the demo organizer, event (PIN `8421`) and 5 tickets.

```bash
npx wrangler deploy --dry-run --cwd worker
```
Bundles everything and lists bindings without uploading. Run it before every deploy to catch broken imports.

```bash
npx wrangler tail --cwd worker
```
Live log of the deployed Worker. Keep it open on event day.

Without wrangler: `node local_dev_server.mjs` runs the same `worker/src/index.js` on Node with `ticket_scanner_dev.sqlite` (no rate limits, no queue: "Send in background" answers 503).
