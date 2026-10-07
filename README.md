# 🎟️ TicketScanner Pro • Enterprise Event Ticketing & Scanner Platform (v3)

A high-performance, full-stack event ticket management and gate verification platform. Built on **Cloudflare Workers** (serverless edge API + asset hosting) and backed by **Firebase Realtime Database** with integrated email dispatch via **Resend**.

---

## ✨ Key Features & Capabilities

### 1. 👑 Multi-Tier Ticketing Engine
* **Three First-Class Tiers**:
  * 👑 **VIP**: Metallic gold badge, VIP fanfare chord chime, backstage/priority validation.
  * 🎟️ **General Admission**: Cyber emerald badge, crisp confirmation chime, general entry gate pass.
  * ⭐ **Guestlist**: Royal electric violet badge, melodic chime, honorary guest entry marker.
* **Smart Tier Prefixes**: Automatically generates human-readable, collision-resistant codes (e.g. `VIP-4A9B2C`, `GEN-8D1E3F`, `GST-7A2F0B`).

### 2. 📷 High-Velocity Gate Scanner (`index.html`)
* **Continuous "Scan Next" Workflow**:
  * Scanned ticket result modal **stays pinned** on screen showing Attendee Name, Tier Badge, Ticket ID, Gate Operator, and Timestamp.
  * Big primary **[Scan Next Ticket]** button to immediately open the camera for the next attendee (triggered by clicking, pressing `Spacebar`, `Enter`, or tapping anywhere).
  * Optional **Continuous Auto-Scan** toggle for hands-free 2.8s auto-resuming during high-volume rushes.
* **Gate Ergonomics**:
  * **Built-in Web Audio Synthesizer**: Generates distinct harmonic chimes offline without external audio files (VIP fanfare chord, General confirmation chime, Duplicate warning tone, Invalid buzzer).
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
  * `POST /api/reset-db` protected by master bearer key and explicit confirmation phrase (`CONFIRM_RESET`).
  * **Wipe All Records**: Clears the entire database for a fresh event.
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
    ├── src/index.js         # REST API (/api/*) — talks to Firebase + Resend
    └── public/              # High-performance static web app served from Cloudflare's edge
        ├── index.html       # Mobile-first Gate Scanner PWA
        └── admin.html       # Event Command Center & Visual Ticket Studio
```

---

## ⛅ Deployment & Cloudflare Workers

The frontend and API are deployed together as a **single Cloudflare Worker**. The static web apps in `worker/public/` are served from Cloudflare's global edge, while requests to `/api/*` route directly to `worker/src/index.js`.

### Environment Variables & Secrets

Set these in your Cloudflare dashboard or using Wrangler:
```bash
cd worker
npx wrangler secret put FIREBASE_SECRET   # Firebase Realtime Database Auth Secret
npx wrangler secret put RESEND_API_KEY    # Resend API Key for ticket emails
```

`FIREBASE_URL` is configured in `worker/wrangler.toml`:
```toml
[vars]
FIREBASE_URL = "https://ticketsqr1-default-rtdb.asia-southeast1.firebasedatabase.app"
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

Both the **Gate Scanner** (`index.html`) and the **Admin Panel** (`admin.html`) are protected by the master access token:
* **Access Token**: `Bearer Raghav@ticket`
* Passwords are saved in browser `localStorage` on successful login for frictionless session management on gate staff devices.
