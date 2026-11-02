# Selling tickets through TixDesk: website integration + WhatsApp bot

Status: design proposal, nothing built yet. Prices for third-party services were checked in November 2026 and must be re-checked before launch.

## 0. The one idea that makes both fit

Today TixDesk starts *after* the sale: the organizer collects money "their own way", then generates passes. Both new features move TixDesk one step earlier, to the sale itself.

The website integration and the WhatsApp bot are not two systems. They are two **storefronts** in front of one shared **order pipeline**:

```
 STOREFRONTS (how a buyer arrives)          ORDER PIPELINE (shared, built once)
 ┌───────────────────────────────┐
 │ A. Hosted booking page        │──┐
 │    tixdesk.app/e/<event-slug> │  │     1. create order + hold inventory
 ├───────────────────────────────┤  │     2. create Razorpay Payment Link
 │ B. Organizer's own website    │  ├──►  3. buyer pays on Razorpay
 │    (button/embed or API)      │  │     4. Razorpay webhook → TixDesk
 ├───────────────────────────────┤  │     5. verify signature + fetch payment
 │ C. WhatsApp bot               │──┘     6. issue tickets (spend credits)
 │    list events → book → pay   │        7. deliver pass (WhatsApp / email / page)
 └───────────────────────────────┘        8. show in dashboard, scan at gate (exists)
```

The **payment link** is the common primitive you spotted. Every channel ends in "here is your Razorpay link", and every paid link comes back through the same webhook. Build the pipeline once. Each storefront is then a thin layer.

A hosted booking page (A) also removes the need for the organizer to own a website at all. It is the cheapest storefront to build and the one the WhatsApp bot and website buttons both link to anyway, so it comes first.

---

## 1. Who holds the money? (decide this first)

Everything else depends on this.

| | **Option 1: Organizer's own Razorpay (recommended)** | Option 2: TixDesk collects, splits with Razorpay Route |
|---|---|---|
| Money flow | Buyer → organizer's Razorpay account → organizer's bank | Buyer → TixDesk's Razorpay → split to organizer's linked account |
| Organizer setup | Has or creates a Razorpay account (KYC with Razorpay), pastes API key + webhook secret into TixDesk | Completes KYC as a linked account under TixDesk |
| TixDesk handles money? | **Never.** We only read payment status. | Yes. We are the platform of record: refunds, chargebacks, disputes and settlement delays land on us. |
| Tax / legal for you | Simple: you invoice your flat pass fee as today | Likely e-commerce operator obligations (GST TCS etc.). Needs a CA before launch. |
| Fits "never a cut of your sales" (your landing-page promise) | Yes, exactly | Only if you deliberately take no %. Still harder to explain. |
| Who it suits | Organizers who sell regularly | Tiny one-off organizers who will never open a Razorpay account |

**Recommendation:** ship Option 1. Revisit Route only if many organizers drop off at "create a Razorpay account". Option 1 also gives you the "verify" step for free. A payment is real only if Razorpay, called with *the organizer's* keys, says it is captured.

Key storage: the organizer's `key_secret` and webhook secret are stored encrypted (AES-GCM via WebCrypto, key from a new Worker secret `INTEGRATIONS_KEY`). They are never sent back to the browser after saving.

---

## 2. Storefront A: hosted booking page (build first)

`tixdesk.app/e/<slug>`: a public page per event. It shows ticket types, prices, remaining stock and a short form (name, phone, email, quantity), then **Pay**.

- New static file `worker/public/book.html` + public endpoints `GET /api/public/events/:slug` and `POST /api/public/orders`.
- No login for buyers. Abuse limits: per-IP quota on order creation (reuse `consumeQuota`), Turnstile on the form.
- The organizer shares the link on Instagram, in their bio, or in a QR on a poster. That alone covers "no website needed".

## 3. Storefront B: the organizer's existing website

Three levels, from no-code to full control. Most organizers only need level 1.

### Level 1: Button / embed (no code)
Organizer pastes one snippet:

```html
<script src="https://tixdesk.app/embed.js" data-event="sunburn-2026" async></script>
```

It renders a "Buy tickets" button that opens the hosted booking page in a popup or overlay. Everything else is Storefront A. Needs `frame-ancestors` relaxed for `/e/*` only. Today `_headers` sets `frame-ancestors 'none'` for all pages.

### Level 2: Orders API (their site, our payment link)
For sites with their own cart. Their **server** calls:

```
POST /api/v1/orders            Authorization: Bearer tdk_live_…  (organizer API key)
{ event, items: [{type:"vip", qty:2}], buyer: {name, phone, email}, return_url }
→ { order_id, payment_url, expires_at }
```

They redirect the buyer to `payment_url`. The rest is the shared pipeline. API keys are a new credential type (hashed in D1, scoped to one organizer, revocable).

### Level 3: "Connect your Razorpay webhook" (their checkout, our tickets)
This is the "add our webhook to their site" idea. The organizer keeps their existing Razorpay checkout and adds TixDesk as a webhook in their Razorpay dashboard:

```
URL:    https://tixdesk.app/api/hooks/razorpay/<organizer_public_id>
Events: payment.captured, refund.processed
Secret: (TixDesk generates it, organizer pastes it into Razorpay)
```

Their checkout must put the event in the payment's `notes`, e.g. `notes: { tixdesk_event: "sunburn-2026", tixdesk_type: "vip", qty: "2", name: "...", email: "..." }`. When `payment.captured` arrives, TixDesk:

1. Verifies `X-Razorpay-Signature` over the **raw body** with that organizer's webhook secret.
2. Re-fetches the payment from Razorpay with the organizer's key. This catches forged notes and amounts.
3. Checks the amount matches `price × qty` for that ticket type. If not, the order is flagged `needs_review` instead of issuing tickets.
4. Issues tickets and delivers passes.

Payments without `tixdesk_event` notes are ignored, so the organizer's other sales are unaffected.

### Outbound webhooks (all levels)
Their site can subscribe to our events: `order.paid`, `ticket.issued`, `ticket.scanned`, `order.refunded`. These are signed with a per-organizer secret (same `st.`-style HMAC we already use) and retried with backoff through Cloudflare Queues.

---

## 4. Storefront C: WhatsApp bot

### Which WhatsApp number?

| | **Shared TixDesk number (start here)** | Organizer's own number |
|---|---|---|
| Setup for organizer | Nothing | Meta Business verification + display-name approval, via Meta Embedded Signup |
| How buyers find the event | Deep link `wa.me/91XXXXXXXXXX?text=SUNBURN` on posters/Instagram. The first word picks the organizer and event. | Organizer's own number, all their events |
| Branding | "TixDesk" in the chat header | Organizer's brand |
| Product | Included in a plan | Premium add-on |

### Conversation flow (buyer-initiated, so the messages are cheap)

```
Buyer:  "SUNBURN"            (from the deep link)
Bot:    [List message] Sunburn Arena 2026 — 15–17 Nov
          • VIP 3-Day  ₹4,999  (12 left)
          • General Day 1  ₹999
Buyer:  taps "VIP 3-Day"
Bot:    [Buttons] How many?  1 · 2 · 3+
Buyer:  2
Bot:    [WhatsApp Flow form] name, email (phone already known)
Bot:    "Hold for 15 min. Pay here:" [CTA button → Razorpay Payment Link]
        ... buyer pays ...
Bot:    "Paid ✓  Here are your 2 passes" + pass image/PDF per ticket + link to pass page
        (later) utility template: "Doors open at 6 PM tomorrow, show this QR"
```

Commands: `MY TICKETS` re-sends passes for this phone number. `EVENTS` lists the organizer's open events. Anything unknown gets a help menu.

### How it runs on Workers
- `GET /api/hooks/whatsapp`: Meta's `hub.challenge` verification.
- `POST /api/hooks/whatsapp`: verify `X-Hub-Signature-256` (HMAC with the Meta app secret), return 200 quickly, then process in `ctx.waitUntil` or a Queue. Meta retries slow responses, which would create duplicate replies, so store message ids in `webhook_events` and skip repeats.
- Conversation state: one `wa_sessions` row per phone (`step`, `event_id`, `type`, `qty`, `updated_at`). A Durable Object per phone is cleaner, but D1 is enough at this scale.
- Outbound: `POST graph.facebook.com/v{N}/{phone_number_id}/messages` with a long-lived system-user token stored as a Worker secret.

---

## 5. The shared order pipeline (what actually gets built)

### New tables

```sql
ticket_types   (id, event_id, name, tier, price_paise, quantity, held, sold,
                allowed_days, sales_start, sales_end, active)
orders         (id, organizer_id, event_id, channel  -- 'page'|'embed'|'api'|'rzp_hook'|'whatsapp'
                , buyer_name, buyer_phone, buyer_email, items_json, amount_paise,
                status  -- 'pending'|'paid'|'issued'|'expired'|'needs_review'|'refunded'
                , rzp_link_id, rzp_payment_id, expires_at, created_at, paid_at)
integrations   (organizer_id, kind, config_enc, webhook_secret_enc, public_id, created_at)
api_keys       (id, organizer_id, key_hash, label, last_used_at, revoked_at)
webhook_events (source, event_id PRIMARY KEY, received_at)   -- idempotency for Razorpay + Meta
wa_sessions    (phone, step, state_json, updated_at)
```

`tickets` gets an `order_id` column. Ticket issuing reuses the existing `/api/generate` insert logic, moved into a function both the dashboard and the pipeline call.

### Order lifecycle

```
pending ──(payment_link.paid / payment.captured, verified)──► paid ──(tickets inserted, credits spent)──► issued
   │                                                                │
   └──(link expired, cron)──► expired (hold released)                └──(amount mismatch / no credits)──► needs_review
issued ──(refund.processed)──► refunded (tickets → status 'revoked', scanner shows REVOKED)
```

### Rules that stop real money bugs
1. **Overselling.** Holding stock is a conditional update: `UPDATE ticket_types SET held = held + ? WHERE id = ? AND sold + held + ? <= quantity`. 0 rows changed means sold out. This is the same pattern as the credit reservation in `/api/generate`.
2. **Hold expiry.** Payment links get `expire_by` = now + 15 min. A Workers **Cron Trigger** every 5 min releases holds on expired `pending` orders. The `payment_link.expired` webhook also releases them.
3. **Idempotency.** Every webhook is recorded in `webhook_events` before acting. Razorpay and Meta both retry. A second delivery must not issue tickets twice.
4. **Paid after expiry.** A buyer pays at minute 14:59 and the webhook arrives after the cron released the hold. Re-try the hold. If stock is gone, mark `needs_review` and alert the organizer to refund. Never silently drop a paid order.
5. **Credits run out.** Passes still cost credits. If an organizer hits 0 mid-sale, buyers who already paid must not be stuck. Check the balance when the order is *created* and reserve 1 credit per ticket then, refunding the credits on expiry. Show "sales paused, top up credits" on the dashboard when the balance is below 20.
6. **Amounts come from our DB**, never from the client or from `notes`.

### Pass delivery (needs one change to the current architecture)
Passes are currently drawn in the organizer's browser (studio canvas), and the server can't render them. For buyer-triggered sales nobody's browser is open. Fix:

- Move the studio layout (`studio_layout_v3`) and artwork from `localStorage` into D1 (layout JSON per event) + R2 (artwork). This was already weak spot #9 in ARCHITECTURE.md.
- Add a public pass page `tixdesk.app/t/<ticketId>.<sig>` (HMAC-signed so ids can't be enumerated). It runs the same compositor code in the **buyer's** browser and offers "Save image" / "Add to wallet" later.
- WhatsApp and email send that link plus a server-generated QR PNG (pure-JS QR + PNG encode is cheap in a Worker). The fully designed pass is one tap away.
- This also removes the dependency on `api.qrserver.com` in the current email.

### Dashboard additions
- **Ticket types** editor per event (price, stock, sale window).
- **Orders** tab: channel, buyer, amount, status, Razorpay payment id with a link to the Razorpay dashboard, and a `needs_review` queue with "Issue anyway" / "Mark refunded".
- **Integrations** page: connect Razorpay (keys + generated webhook URL/secret + "Send test" button), API keys, embed snippet, WhatsApp deep link + QR poster.
- **Verification**: an order counts as "Verified" only when the webhook signature matched **and** the payment re-fetch confirmed `captured` with the right amount. Show that badge per order.

---

## 6. Pricing

### What each sale costs (₹500 ticket, Option 1)

| Cost | Who pays | Amount |
|---|---|---|
| Razorpay gateway (~2% + 18% GST on the fee; verify current rate) | Organizer (their account), or passed to buyer as a convenience fee | ~₹11.80 |
| WhatsApp: replies inside a buyer-started chat (service window) | TixDesk | ₹0 |
| WhatsApp: ticket delivery as a utility template inside the open window | TixDesk | ₹0 |
| WhatsApp: reminder the day before (utility template, outside window) | TixDesk | ~₹0.115 + 18% GST ≈ ₹0.14 |
| WhatsApp: promo blast to past buyers (marketing template) | TixDesk, passed to organizer | ~₹0.86 + GST ≈ ₹1.02 |
| Email (Resend) | TixDesk | ~₹0 to ₹0.03 |
| Workers + D1 | TixDesk | negligible |

TixDesk's real variable cost per sold pass via WhatsApp is roughly **₹0.15**, and less via the web page. Your existing ₹5–10 flat pass fee already covers it with a wide margin.

### Recommended model: keep the flat fee, sell the channels as plans

Keep the brand promise "a flat fee per pass, never a cut of your sales". Don't add a percentage.

| Plan | Price | Includes |
|---|---|---|
| **Free** | ₹0 | 50 passes, gate scanner, manual generation (as today) |
| **Pay-as-you-go passes** | ₹10 → ₹5 per pass (existing packs) | Every pass, however it was sold, costs one credit |
| **Sell** (new) | ₹0/month, passes still cost credits | Hosted booking page, embed button, connect-your-Razorpay webhook, orders dashboard |
| **Sell + WhatsApp** (new) | ~₹999/month per organizer | Shared-number bot, ticket delivery + 1 reminder per ticket included |
| **Own WhatsApp number** (add-on) | ~₹2,499/month + marketing messages at cost +10% | Bot on organizer's number and brand, broadcasts |
| **API & outbound webhooks** | Included in Sell | For developers. Keep it free to win agencies. |

Why this shape:
- **"Sell" free with credits** means an organizer who sells 500 tickets at ₹500 (₹2.5 lakh) pays TixDesk ₹2,500–5,000. A 2–10% commission platform would take ₹5,000–25,000 from the same sales. That gap is the pitch, and it reuses the landing page's existing comparison table.
- **WhatsApp as a subscription** turns the one feature with real per-message cost into predictable revenue, and covers Meta costs even for heavy users.
- Leave room for a 1–2% optional "TixDesk handles payments for you" tier later if you adopt Route. Price it clearly as a different product.

Numbers marked ~ are starting points to test with 5–10 real organizers, not final prices.

---

## 7. Hosting fit

All of this stays on Cloudflare and needs the **Workers Paid** plan (already recommended in HOSTING.md):

| Need | Cloudflare piece |
|---|---|
| Razorpay + Meta webhooks | Worker routes (verify raw body before `JSON.parse`) |
| Respond to Meta fast, process later | `ctx.waitUntil` now, **Queues** when volume grows |
| Release expired holds | **Cron Triggers** |
| Outbound webhooks with retries | **Queues** |
| Pass artwork | **R2** |
| Bot form spam / order abuse | **Turnstile** + existing quotas |

`index.js` is already 1,550 lines. Before this work, split it into route modules (`routes/orders.js`, `routes/hooks.js`, `routes/whatsapp.js`, `lib/razorpay.js`, `lib/pipeline.js`). Otherwise the payment code becomes impossible to review.

---

## 8. Build order

| Phase | Ships | Rough size |
|---|---|---|
| 0 | Split `index.js` into modules; tests for `/api/check` + credit logic; studio layout → D1/R2; Razorpay webhook for the existing credit purchase (fixes the lost-credits bug and is the first webhook handler) | 1–2 weeks |
| 1 | Ticket types, orders, Connect Razorpay, Payment Links, the webhook pipeline, hosted booking page, pass page, orders dashboard | 2–3 weeks |
| 2 | Embed button, Orders API + API keys, connect-your-webhook (Level 3), outbound webhooks | 1–2 weeks |
| 3 | WhatsApp bot on a shared number (Meta app, business verification, templates approval: start the paperwork during phase 1, approval takes days) | 2–3 weeks |
| 4 | Own-number WhatsApp via Embedded Signup, broadcasts, refunds UI, optionally Route | later |

---

## 9. Decisions needed from you

1. **Money flow:** organizer's own Razorpay (recommended) or TixDesk collects via Route?
2. **WhatsApp number:** start with one shared TixDesk number?
3. **Pricing:** keep flat per-pass credits + WhatsApp subscription, or add a per-sale %?
4. **Scope of phase 1:** hosted page first (recommended), or website integration first because a specific customer is waiting for it?

Sources for third-party prices:
- [Meta WhatsApp Business Platform pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [WhatsApp API cost in India 2026 (ecorpit)](https://ecorpit.com/whatsapp-business-api-cost-india-d2c-2026/)
- [AiSensy: WhatsApp per-message pricing update, Jan 2026](https://m.aisensy.com/blog/whatsapp-api-new-pricing/)
- [Razorpay Payment Links webhooks](https://razorpay.com/docs/webhooks/payment-links.md)
- [Razorpay Payment Links entity](https://razorpay.com/docs/us/api/payments/payment-links/entity.md)
- [Razorpay Route](https://razorpay.com/docs/payments/route.md)

Meta announced a revision to India WhatsApp pricing effective 1 Oct 2026 whose details weren't confirmed in these sources. Re-check the rate card before fixing prices.
