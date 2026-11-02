-- 🎟️ TicketScanner Pro Relational Schema (Cloudflare D1 / SQLite Edge Engine)

-- 1. ORGANIZERS (Platform accounts)
CREATE TABLE IF NOT EXISTS organizers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    company_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    ticket_credits INTEGER DEFAULT 50,         -- 50 free credits; the tour's sample tickets are free (tour_grants)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. EVENTS (Multi-event workspace per organizer)
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    organizer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    total_days INTEGER DEFAULT 1,              -- 1 to 10 days
    start_date DATE NOT NULL,                  -- day 1; scans compute the current day from this
    gate_pin TEXT NOT NULL,                    -- 4-digit PIN for volunteer bouncers (e.g. '8421')
    use_tiers INTEGER DEFAULT 0,               -- 1 = VIP/General/Guestlist tiers shown for this event
    timezone TEXT DEFAULT 'Asia/Kolkata',      -- IANA zone the event day is counted in
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);

-- 3. TICKETS (Relational table replacing monolithic JSON dumps)
CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,                       -- e.g. 'VIP-849201'
    event_id TEXT NOT NULL,
    attendee_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    tier TEXT NOT NULL CHECK(tier IN ('VIP', 'General', 'Guestlist')),
    total_days INTEGER DEFAULT 1,
    allowed_days TEXT DEFAULT '1',             -- Comma-separated: '1,2,3' or 'ALL'
    scanned_days TEXT DEFAULT '',              -- Comma-separated days scanned: '1'
    status TEXT DEFAULT 'valid' CHECK(status IN ('valid', 'scanned', 'revoked')),
    email_sent_at DATETIME,                    -- set when the pass email is accepted by Resend
    rendered_at DATETIME,                      -- set when the pass image is exported from the studio
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- 4. SCAN AUDIT LOGS (Immutable turnstile security trail)
CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    scanned_day INTEGER NOT NULL,
    gate_device_id TEXT DEFAULT 'Gate-1',
    scan_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- 5. CREDIT ORDERS & RECHARGES (Razorpay / Cashfree UPI ledger)
CREATE TABLE IF NOT EXISTS credit_orders (
    order_id TEXT PRIMARY KEY,                 -- Razorpay order id 'order_xxx'
    organizer_id TEXT NOT NULL,
    credits_purchased INTEGER NOT NULL,
    amount_inr REAL NOT NULL,
    currency TEXT DEFAULT 'INR',
    payment_id TEXT,                           -- Razorpay payment id 'pay_xxx'
    status TEXT DEFAULT 'created' CHECK(status IN ('created', 'paid', 'failed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organizer_id) REFERENCES organizers(id)
);

-- 6. FAILED AUTH ATTEMPTS (Brute-force lockout for gate PINs, logins & master key)
CREATE TABLE IF NOT EXISTS auth_attempts (
    key TEXT PRIMARY KEY,                      -- e.g. 'gate:evt_123', 'login:a@b.com', 'master:<ip>'
    failures INTEGER NOT NULL,
    window_start INTEGER NOT NULL              -- unix seconds
);

-- 7. TOUR GRANTS (One free sample set per organizer during the guided tour: max 1 ticket per tier)
-- A separate table, not a column, so re-running this file upgrades existing databases without an ALTER
CREATE TABLE IF NOT EXISTS tour_grants (
    organizer_id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- HIGH-SPEED QUERY INDEXES
CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event_id ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tier ON tickets(tier);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_scan_logs_ticket ON scan_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_event ON scan_logs(event_id);
