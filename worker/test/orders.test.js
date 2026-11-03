import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, seed } from "./d1.js";
import { encryptSecret } from "../src/lib/secrets.js";
import { reserve, releaseExpired, fulfillOrder } from "../src/lib/orders.js";
import { handle as publicSales } from "../src/routes/public-sales.js";
import { handle as hooks } from "../src/routes/hooks.js";
import { hmac, bytesToHex } from "../src/lib/crypto.js";

const KEY_SECRET = "keysecret_1234567890";
const WH_SECRET = "whsecret_abc";
const ENV_BASE = { INTEGRATIONS_KEY: "test-integrations-key" };

async function setup({ quantity = 5, credits = 50 } = {}) {
  const DB = makeDb(); seed(DB, { credits });
  const env = { ...ENV_BASE, DB };
  DB.raw.exec(`
    INSERT INTO event_pages (event_id, organizer_id, slug) VALUES ('evt1', 'org1', 'summer');
    INSERT INTO ticket_types (id, event_id, organizer_id, name, tier, price_paise, quantity)
      VALUES ('tt1', 'evt1', 'org1', 'General', 'General', 50000, ${quantity});
  `);
  DB.raw.prepare("INSERT INTO integrations (organizer_id, public_id, key_id, key_secret_enc, webhook_secret_enc) VALUES (?, ?, ?, ?, ?)")
    .run("org1", "pubid1", "rzp_test_abcdefgh12", await encryptSecret(env, KEY_SECRET), await encryptSecret(env, WH_SECRET));
  return { DB, env };
}
const type = (DB) => DB.raw.prepare("SELECT * FROM ticket_types WHERE id = 'tt1'").get();
const credits = (DB) => DB.raw.prepare("SELECT ticket_credits n FROM organizers WHERE id = 'org1'").get().n;
const orderRow = (DB, id) => DB.raw.prepare("SELECT * FROM orders WHERE id = ?").get(id);
const addOrder = (DB, id = "ord_1", { status = "pending", qty = 2, expires = Math.floor(Date.now() / 1000) + 900 } = {}) =>
  DB.raw.prepare(`INSERT INTO orders (id, organizer_id, event_id, ticket_type_id, qty, buyer_name, buyer_email, amount_paise, status, rzp_order_id, expires_at)
                  VALUES (?, 'org1', 'evt1', 'tt1', ?, 'Buyer', 'b@x.com', ?, ?, ?, ?)`).run(id, qty, qty * 50000, status, `order_${id}`, expires);

test("reserve never oversells or overdraws credits", async () => {
  const { DB, env } = await setup({ quantity: 3, credits: 10 });
  assert.equal(await reserve(env, type(DB), 2), "ok");
  assert.equal(await reserve(env, type(DB), 2), "sold_out");
  assert.equal(type(DB).held, 2);
  assert.equal(credits(DB), 8);
  const poor = await setup({ credits: 1 });
  assert.equal(await reserve(poor.env, type(poor.DB), 2), "no_credits");
  assert.equal(type(poor.DB).held, 0);
});

test("expired holds give stock and credits back", async () => {
  const { DB, env } = await setup();
  await reserve(env, type(DB), 2); addOrder(DB, "ord_old", { expires: 1 });
  await releaseExpired(env, "tt1");
  assert.equal(orderRow(DB, "ord_old").status, "expired");
  assert.equal(type(DB).held, 0);
  assert.equal(credits(DB), 50);
  await releaseExpired(env, "tt1");           // second pass changes nothing
  assert.equal(credits(DB), 50);
});

test("fulfillOrder issues tickets once, even when called twice", async () => {
  const { DB, env } = await setup();
  await reserve(env, type(DB), 2); addOrder(DB);
  const first = await fulfillOrder(env, orderRow(DB, "ord_1"), "pay_1");
  assert.equal(first.status, "issued");
  assert.equal(first.ticketIds.length, 2);
  assert.equal((await fulfillOrder(env, orderRow(DB, "ord_1"), "pay_1")).status, "already");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM order_tickets").get().n, 2);
  assert.equal(type(DB).sold, 2); assert.equal(type(DB).held, 0);
  assert.equal(credits(DB), 48);
});

test("a payment after the hold expired re-takes stock, or parks the order for review", async () => {
  const { DB, env } = await setup({ quantity: 2 });
  addOrder(DB, "ord_late", { status: "expired" });
  assert.equal((await fulfillOrder(env, orderRow(DB, "ord_late"), "pay_9")).status, "issued");

  const gone = await setup({ quantity: 2 });
  gone.DB.raw.exec("UPDATE ticket_types SET sold = 2 WHERE id = 'tt1'");
  addOrder(gone.DB, "ord_late", { status: "expired" });
  assert.equal((await fulfillOrder(gone.env, orderRow(gone.DB, "ord_late"), "pay_9")).status, "needs_review");
  assert.equal(orderRow(gone.DB, "ord_late").rzp_payment_id, "pay_9");
});

async function orgHook(env, payload, sig) {
  const raw = JSON.stringify(payload);
  const request = new Request("https://x/api/hooks/razorpay/org/pubid1", {
    method: "POST", body: raw, headers: { "X-Razorpay-Signature": sig ?? bytesToHex(await hmac(WH_SECRET, raw)) }
  });
  const res = await hooks({ request, env, url: new URL(request.url), origin: null });
  return { status: res.status, body: await res.json() };
}
const captured = (over = {}) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_ord_1", amount: 100000, status: "captured", ...over } } }
});

test("organizer webhook issues tickets once and rejects bad signatures", async () => {
  const { DB, env } = await setup();
  await reserve(env, type(DB), 2); addOrder(DB);
  assert.equal((await orgHook(env, captured(), "deadbeef")).status, 400);
  assert.equal(orderRow(DB, "ord_1").status, "pending");
  assert.equal((await orgHook(env, captured())).body.status, "issued");
  assert.equal((await orgHook(env, captured())).body.status, "already");
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM tickets WHERE event_id = 'evt1' AND attendee_name = 'Buyer'").get().n, 2);
});

test("organizer webhook parks a wrong amount for review and ignores unknown orders", async () => {
  const { DB, env } = await setup();
  await reserve(env, type(DB), 2); addOrder(DB);
  assert.equal((await orgHook(env, captured({ order_id: "order_nope" }))).body.ignored, "unknown order");
  assert.equal(orderRow(DB, "ord_1").status, "pending");
  assert.equal((await orgHook(env, captured({ amount: 100 }))).body.ignored, "amount mismatch");
  assert.equal(orderRow(DB, "ord_1").status, "needs_review");
  assert.equal(type(DB).held, 0);               // hold released, no tickets issued
  assert.equal(credits(DB), 50);
});

test("an issued order queues one pass email per ticket, once", async () => {
  const { DB, env } = await setup();
  const sent = [];
  env.EMAIL_QUEUE = { sendBatch: async (msgs) => { sent.push(...msgs); } };
  await reserve(env, type(DB), 2); addOrder(DB);
  const { ticketIds } = await fulfillOrder(env, orderRow(DB, "ord_1"), "pay_1");
  await fulfillOrder(env, orderRow(DB, "ord_1"), "pay_1");
  assert.deepEqual(sent.map(m => m.body), ticketIds.map(ticketId => ({ ticketId, organizerId: "org1" })));
});

test("deleting an account with buyer orders removes orders and stored Razorpay keys", async () => {
  const { DB, env } = await setup();
  const { hashPassword } = await import("../src/lib/crypto.js");
  const { handle: account } = await import("../src/routes/account.js");
  DB.raw.prepare("UPDATE organizers SET password_hash = ? WHERE id = 'org1'").run(await hashPassword("pw-123456"));
  await reserve(env, type(DB), 2); addOrder(DB);
  await fulfillOrder(env, orderRow(DB, "ord_1"), "pay_1");
  const request = new Request("https://x/api/auth/delete", { method: "POST", body: JSON.stringify({ password: "pw-123456", confirm: "DELETE" }) });
  const res = await account({ request, env, url: new URL(request.url), origin: null, organizerId: "org1" });
  assert.equal(res.status, 200);
  for (const t of ["orders", "order_tickets", "integrations", "ticket_types", "event_pages"]) {
    assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  }
});

test("public order flow: create, verify with the organizer's secret, tickets issued", async () => {
  const { DB, env } = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "order_RZP1" }), { status: 200 });
  try {
    const call = async (path, body) => {
      const request = new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body) });
      const res = await publicSales({ request, env, url: new URL(request.url), origin: null, clientIp: "1.1.1.1" });
      return { status: res.status, body: await res.json() };
    };
    const created = await call("/api/public/orders", { slug: "summer", type_id: "tt1", qty: 2, name: "Asha", email: "asha@x.com" });
    assert.equal(created.status, 200);
    assert.equal(created.body.amount, 100000);          // from our DB: 2 x 50000
    assert.equal(type(DB).held, 2);

    const bad = await call("/api/public/orders/verify", { rzp_order_id: "order_RZP1", payment_id: "pay_1", signature: "nope" });
    assert.equal(bad.status, 400);

    const sig = bytesToHex(await hmac(KEY_SECRET, "order_RZP1|pay_1"));
    const ok = await call("/api/public/orders/verify", { rzp_order_id: "order_RZP1", payment_id: "pay_1", signature: sig });
    assert.equal(ok.body.status, "issued");
    assert.equal(ok.body.ticket_ids.length, 2);
  } finally { globalThis.fetch = realFetch; }
});

test("public order refuses quantity beyond stock", async () => {
  const { env } = await setup({ quantity: 1 });
  const request = new Request("https://x/api/public/orders", { method: "POST", body: JSON.stringify({ slug: "summer", type_id: "tt1", qty: 2, name: "A", email: "a@x.com" }) });
  const res = await publicSales({ request, env, url: new URL(request.url), origin: null, clientIp: "2.2.2.2" });
  assert.equal(res.status, 409);
});

test("organizer can edit a type's price and description, but not drop quantity below sold + held", async () => {
  const { DB, env } = await setup({ quantity: 5 });
  const { handle: sales } = await import("../src/routes/sales.js");
  const put = async (body) => {
    const request = new Request("https://x/api/ticket-types", { method: "PUT", body: JSON.stringify({ event_id: "evt1", id: "tt1", name: "General", tier: "General", ...body }) });
    const res = await sales({ request, env, url: new URL(request.url), origin: null, organizerId: "org1" });
    return { status: res.status, body: await res.json() };
  };
  await reserve(env, type(DB), 3);
  assert.equal((await put({ price_inr: 750, quantity: 5, description: "Entry + drink" })).status, 200);
  assert.equal(type(DB).price_paise, 75000);
  assert.equal(type(DB).description, "Entry + drink");
  assert.equal((await put({ price_inr: 750, quantity: 2 })).status, 409);
});
