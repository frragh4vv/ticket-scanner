# 🎟️ TicketScanner Pro • Enterprise Event Ticketing & Scanner Platform (v3)

A high-performance, full-stack event ticket management and gate verification platform. Built on **Cloudflare Workers** (serverless edge API + asset hosting) and backed by **Cloudflare D1** (SQLite at the edge) with integrated email dispatch via **Resend** and credit top-ups via **Razorpay**.

---

## ✨ Key Features & Capabilities

### 1. 👑 Multi-Tier Ticketing Engine
* **Three First-Class Tiers**:
  * 👑 **VIP**: Metallic gold badge, VIP fanfare chord chime, backstage/priority validation.
  * 🎟️ **General Admission**: Cyber emerald badge, crisp confirmation chime, general entry gate pass.
  * ⭐ **Guestlist**: Royal electric violet badge, melodic chime, honorary guest entry marker.
* **Smart Tier Prefixes**: Automatically generates human-readable, collision-resistant codes (e.g. `VIP-4A9B2C`, `GEN-8D1E3F`, `GST-7A2F0B`).

### 2. 📷 High-Velocity Gate Scanner (`scanner.html`)
* **Continuous "Scan Next" Workflow**:
  * Scanned ticket result modal **stays pinned** on screen showing Attendee Name, Tier Badge, Ticket ID, Gate Operator, and Timestamp.
  * Big primary **[Scan Next Ticket]** button to immediately open the camera for the next attendee (triggered by clicking, pressing `Spacebar`, `Enter`, or tapping anywhere).
  * Optional **Continuous Auto-Scan** toggle for hands-free 2.8s auto-resuming during high-volume rushes.
* **Gate Ergonomics**:
  * **Built-in Web Audio Synthesizer**: Generates distinct harmonic chimes in-browser without external audio files (VIP fanfare chord, General confirmation chime, Duplicate warning tone, Invalid buzzer).
  * **Torch / Flashlight Toggle**: Instantly illuminates camera flash for dimly lit night venues and clubs.
  * **Camera Switcher**: Flip between rear wide/macro lens and front selfie camera.
  * **Haptic Vibration**: Differentiated vibration pulses for verified entry vs duplicates.
  * **Manual Code Lookup**: Collapsible instant search fallback with keyboard support.

### 3. 🎨 Interactive Visual Ticket Studio (`admin.html`)
* **Upload Custom Ticket Templates**:
  * Upload any event flyer, poster, or pass background graphic (PNG/JPG).
  * In-browser HTML5 Canvas compositing engine burns the QR code, Attendee Name, Event Title, Date, and Tier Badge directly into the template.
* **Dual Output Modes**:
  1. **Bulk Pass ZIP Compiler**: Renders high-resolution printable passes for every ticket in the database, compressed into a `.zip` alongside an Excel-compatible `tickets_manifest.csv`.
  2. **Direct Visual Pass Email Dispatch**: Sends branded email passes directly to attendees' inboxes with rendered passes or embedded tier-styled HTML.

### 4. 📊 Command Center & Live Analytics (`admin.html`)
* **Live KPI Metric Cards**:
  * Total tickets, check-in attendance %, VIP check-in progress, General & Guestlist breakdown.
* **Attendee Directory**:
  * Filter pills (`All`, `👑 VIP`, `🎟️ General`, `⭐ Guestlist`, `○ Valid`, `✓ Scanned`, `✉ Unsent Email`).
  * Instant search by Ticket ID, Attendee Name, or Email address.
  * Inline editing of attendee names and emails with instant auto-save.
  * Export complete event database to CSV.

### 5. ⚠️ Database Clean Slate & Batch Creator
* **Safety-Gated Database Reset**:
  * `POST /api/reset-db` protected by an organizer session and an explicit confirmation phrase (`CONFIRM_RESET`).
  * **Wipe All Records**: Clears all tickets and scan logs for the selected event.
  * **Reset Scanned Statuses**: Keeps attendee names and tiers, but resets all tickets back to `Valid`.
* **Multi-Tier Generator**:
  * Create custom quantities of VIP, General, and Guestlist passes in a single batch.

---

## 📂 Project Structure

```bash
├── README.md                # Project documentation
├── pyproject.toml           # Python dependencies
├── qrmaker.py               # Local multi-tier QR & CSV generator script
└── worker/                  # Cloudflare Worker serverless full-stack app
    ├── wrangler.toml        # Cloudflare configuration & static asset directory
    ├── schema.sql / seed.sql # D1 schema and demo data
    ├── src/index.js         # REST API (/api/*) — talks to D1, Resend and Razorpay
    └── public/              # High-performance static web app served from Cloudflare's edge
        ├── landing.html     # Marketing page (served at /)
        ├── scanner.html     # Mobile-first Gate Scanner (served at /scan)
        └── admin.html       # Event Command Center & Visual Ticket Studio (served at /admin)
```

---

## ⛅ Deployment & Cloudflare Workers

The frontend and API are deployed together as a **single Cloudflare Worker**. The static web apps in `worker/public/` are served from Cloudflare's global edge, while requests to `/api/*` route directly to `worker/src/index.js`.

### Environment Variables & Secrets

Set these in your Cloudflare dashboard or using Wrangler (for local dev, put them in `worker/.dev.vars`):
```bash
cd worker
npx wrangler secret put SCANNER_ACCESS_KEY   # Master key for the owner account (admin login)
npx wrangler secret put SESSION_SECRET       # Long random string used to sign session tokens
npx wrangler secret put RESEND_API_KEY       # Resend API key for ticket emails
npx wrangler secret put RAZORPAY_KEY_ID      # Razorpay key id (credit top-ups)
npx wrangler secret put RAZORPAY_KEY_SECRET  # Razorpay key secret (payment signature checks)
```

Optional vars: `APP_URL` (public URL used in password-reset links), `EMAIL_FROM` (a sender on your verified Resend domain), `OWNER_ORG_ID` (organizer the master key signs in as, default `org_raghav`), `EMAIL_DAILY_CAP` (pass emails per organizer per day, default 1000), `ALLOWED_ORIGINS` (extra cross-origin callers), and `DEMO_BILLING="true"` to grant credits without a payment gateway — **local testing only**; it is ignored when Razorpay keys are set.

See [LAUNCH.md](LAUNCH.md) for the full go-live checklist (legal placeholders, Razorpay KYC, email domain, security settings).

The D1 database is bound as `DB` in `worker/wrangler.toml`. Create it and apply the schema:
```bash
npx wrangler d1 create ticket-scanner-db          # paste the database_id into wrangler.toml
npx wrangler d1 execute ticket-scanner-db --remote --file=schema.sql
npx wrangler d1 execute ticket-scanner-db --remote --file=seed.sql   # optional demo data
```

### Local Development

```bash
cd worker
npx wrangler dev               # Runs local dev server at http://localhost:8787
```

### Production Deployment

Deploy directly via Wrangler or connect your GitHub repository to Cloudflare Workers for continuous deployment on push to `main`:
```bash
cd worker
npx wrangler deploy
```

---

## 🔑 Authentication

All `/api/*` routes except sign-in require a signed session token (`Authorization: Bearer st....`), and every query is scoped to the signed-in organizer's own events.

* **Organizers**: sign up at `/signup` and sign in at `/admin` with email + password (PBKDF2-hashed). Password reset by email (`/reset`), change password, data export and account deletion are in Settings. Sessions last 7 days and end on every device when the password changes. The platform owner can also sign in with the master key (`SCANNER_ACCESS_KEY`).
* **Gate volunteers**: open the gate link shared from the admin panel (`/scanner.html?event=<id>&pin=<pin>`). The PIN only unlocks scanning for that one event — no ticket lists, stats or settings. Sessions last 14 days.
* **Brute-force protection**: 10 failed attempts per event PIN, email, or IP locks that key out for 15 minutes.
* **Scans are atomic**: two gates scanning the same pass at the same instant can't both admit it.
