# Launch checklist

Everything stub needs before real organizers and attendees use it. Items are in order: do the blocking ones first.

## 1. Legal details (blocking)

The legal pages are written for India (DPDP Act 2023, IT Act 2000) but contain placeholders, highlighted in orange on the pages. Replace them in `worker/public/privacy.html`, `terms.html`, `refunds.html` and `contact.html`:

| Placeholder | What to put |
| --- | --- |
| `[LEGAL ENTITY NAME]` | Your registered business name (sole proprietorship, LLP or Pvt Ltd) |
| `[REGISTERED ADDRESS]` | Registered business address |
| `[SUPPORT EMAIL]` | A support inbox you actually read, e.g. `support@yourdomain.in` |
| `[GRIEVANCE OFFICER NAME]` / `[GRIEVANCE EMAIL]` | The person who handles privacy complaints (required) |
| `[CITY]` | City whose courts have jurisdiction |

Then remove the `.fill` highlight by deleting the `<span class="fill">` wrappers.

**Get a lawyer to review the policies.** They are a solid starting template that matches how the product actually works, not legal advice. In particular confirm: the refund policy terms (7-day refund on unused packs is a choice, not a requirement), GST treatment of credit packs, and data-transfer rules for Cloudflare storage outside India.

## 2. Accounts and secrets (blocking)

```bash
cd worker
npx wrangler d1 create ticket-scanner-db                   # paste database_id into BOTH wrangler.toml files
npx wrangler d1 execute ticket-scanner-db --remote --file=schema.sql
npx wrangler secret put SESSION_SECRET                     # 32+ random characters, never reuse
npx wrangler secret put SCANNER_ACCESS_KEY                 # owner master key, long and random
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
```

Do **not** run `seed.sql` in production: it creates a demo owner account with a known password (`demo123`). Instead, sign up normally, then set `OWNER_ORG_ID` to your organizer id if you want the master key to sign in as you.

Vars to set in `wrangler.toml` `[vars]` or the dashboard:

| Var | Purpose |
| --- | --- |
| `APP_URL` | Public site URL, e.g. `https://stub.example.in`. Used in password-reset links |
| `EMAIL_FROM` | Sender on your verified Resend domain, e.g. `stub <passes@stub.example.in>` |
| `OWNER_ORG_ID` | Organizer the master key signs in as (optional) |
| `EMAIL_DAILY_CAP` | Pass emails per organizer per day (default 1000) |
| `ALLOWED_ORIGINS` | Extra origins allowed to call the API cross-origin (normally leave empty) |

Never set `DEMO_BILLING` in production. It grants credits without payment when Razorpay keys are missing.

## 3. Payments: Razorpay (blocking for paid packs)

- Complete Razorpay KYC. Their reviewers check that the live site shows: Contact, Terms, Privacy, Refund & Cancellation, and delivery information. All are linked in the site footer; delivery is covered on `/refunds`.
- Switch from test to live keys, then buy the Starter pack once with a real card and refund it, to confirm credits arrive and the signature check passes.

## 4. Email: Resend

- Add and verify your sending domain (SPF, DKIM, DMARC records) so passes don't land in spam.
- Send a test pass to Gmail and Outlook addresses.

## 5. Domain and Cloudflare

- Attach a custom domain to the Worker. HTTPS is automatic.
- Add `Sitemap: https://YOUR-DOMAIN/sitemap.xml` to `robots.txt` once you publish a sitemap (not included because it needs the final domain).
- Turn on Cloudflare **Bot Fight Mode** and a **rate-limiting rule** for `/api/auth/*` as an extra layer on top of the app's own limits.
- Set up Cloudflare notifications for Worker errors.

## 6. Before the first real event

- Run one full rehearsal: generate passes, email them, scan them on 2 phones at once, confirm duplicates are rejected.
- Give gate staff the gate link + PIN, and a hotspot per gate (scanning is online-only by design).
- Export the attendee CSV as a paper backup.

## What's built in

- Organizer sign-up, sign-in, password reset by email, change password (signs out other devices), data export, account deletion
- Per-organizer data isolation; gate PINs only unlock scanning for one event
- Rate limits: sign-ins and PINs (10 tries / 15 min), sign-ups (5 per IP per hour), reset emails (3 per email per hour), pass emails (daily cap)
- Atomic scans: two gates can't admit the same pass
- Security headers and a Content Security Policy on every page (`worker/public/_headers`)
- Privacy, Terms, Refund, Cookie and Contact pages; storage notice; 404 page; favicon; robots.txt

## Known gaps worth doing after launch

- **Email verification on sign-up.** Anyone can register with any address right now (rate-limited).
- **CSP still allows inline scripts.** The admin and scanner pages use inline `onclick` handlers; moving them to `addEventListener` would let the CSP drop `'unsafe-inline'` and block most XSS outright.
- **Sessions live in `localStorage`.** Fine while the CSP and output escaping hold. HttpOnly cookies would be stronger.
- **QR images in emails come from `api.qrserver.com`.** Self-generate them to drop that third party.
- **No automated tests.** At minimum, cover `/api/check` (duplicate scans) and the auth endpoints.
- **Shared networks:** 5 sign-ups per IP per hour may be tight if a whole college signs up from one Wi-Fi. Raise it in `src/index.js` if needed.
