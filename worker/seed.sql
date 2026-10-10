-- 🎟️ Seed Initial Demo Data for TicketScanner Pro
INSERT OR IGNORE INTO organizers (id, email, company_name, password_hash, ticket_credits)
VALUES (
    'org_raghav',
    'raghav@ticketscanner.pro',
    'Raghav Events & Productions',
    'demo123', -- In production, SHA-256 hashed
    500
);

INSERT OR IGNORE INTO events (id, organizer_id, title, total_days, start_date, gate_pin)
VALUES (
    'evt_sunburn2026',
    'org_raghav',
    'Sunburn Arena Festival 2026 (3-Day)',
    3,
    '2026-11-15',
    '8421'
);

-- Seed Sample Tickets
INSERT OR IGNORE INTO tickets (id, event_id, attendee_name, phone, email, tier, total_days, allowed_days, scanned_days, status)
VALUES
    ('VIP-78102', 'evt_sunburn2026', 'Kabir Malhotra', '+91 98765 43210', 'kabir@example.com', 'VIP', 3, 'ALL', '', 'valid'),
    ('VIP-78103', 'evt_sunburn2026', 'Ananya Sen', '+91 98111 22334', 'ananya@example.com', 'VIP', 3, 'ALL', '', 'valid'),
    ('GEN-29101', 'evt_sunburn2026', 'Rohan Sharma', '+91 99887 76655', 'rohan@example.com', 'General', 3, '1,2', '', 'valid'),
    ('GEN-29102', 'evt_sunburn2026', 'Simran Kaur', '+91 97766 55443', 'simran@example.com', 'General', 1, '1', '', 'valid'),
    ('GST-90112', 'evt_sunburn2026', 'Vikramaditya Roy', '+91 96655 44332', 'vikram@example.com', 'Guestlist', 3, 'ALL', '', 'valid');
