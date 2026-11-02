import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, seed } from "./d1.js";
import { settleCreditOrder } from "../src/lib/credits.js";
import { handle as hooks } from "../src/routes/hooks.js";
import { hmac, bytesToHex } from "../src/lib/crypto.js";

const SECRET = "whsec_test";
const addOrder = (DB, id = "order_1", credits = 100, amount = 1000, status = "created") =>
  DB.raw.exec(`INSERT INTO credit_orders (order_id, organizer_id, credits_purchased, amount_inr, status) VALUES ('${id}', 'org1', ${credits}, ${amount}, '${status}')`);
const balance = (DB) => DB.raw.prepare("SELECT ticket_credits n FROM organizers WHERE id = 'org1'").get().n;
const order = (DB, id = "order_1") => DB.raw.prepare("SELECT * FROM credit_orders WHERE order_id = ?").get(id);

async function hook(DB, payload, { sig } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = sig ?? bytesToHex(await hmac(SECRET, raw));
  const request = new Request("https://x/api/hooks/razorpay", {
    method: "POST", body: raw,
    headers: { "X-Razorpay-Signature": signature, "X-Razorpay-Event-Id": "evt_1" }
  });
  const res = await hooks({ request, env: { DB, RAZORPAY_WEBHOOK_SECRET: SECRET }, url: new URL(request.url), origin: null });
  return { status: res.status, body: await res.json() };
}
const captured = (over = {}) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 100000, status: "captured", ...over } } }
});

test("settleCreditOrder credits once and ignores replays", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  assert.equal(await settleCreditOrder({ DB }, order(DB), "pay_1"), true);
  assert.equal(await settleCreditOrder({ DB }, order(DB), "pay_1"), false);
  assert.equal(balance(DB), 150);
  assert.equal(order(DB).status, "paid");
});

test("settleCreditOrder rescues an order a bad browser signature marked failed", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB, "order_1", 100, 1000, "failed");
  assert.equal(await settleCreditOrder({ DB }, order(DB), "pay_1"), true);
  assert.equal(balance(DB), 150);
});

test("webhook credits a captured payment once, even when delivered twice", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  assert.deepEqual((await hook(DB, captured())).body, { ok: true, credited: true });
  assert.deepEqual((await hook(DB, captured())).body, { ok: true, credited: false });
  assert.equal(balance(DB), 150);
});

test("webhook rejects a bad signature and credits nothing", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  assert.equal((await hook(DB, captured(), { sig: "deadbeef" })).status, 400);
  assert.equal(balance(DB), 50);
});

test("webhook with a tampered body fails the signature", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  const good = JSON.stringify(captured());
  const sig = bytesToHex(await hmac(SECRET, good));
  assert.equal((await hook(DB, good.replace("100000", "1"), { sig })).status, 400);
  assert.equal(balance(DB), 50);
});

test("webhook with a wrong amount leaves the order uncredited", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  const r = await hook(DB, captured({ amount: 100 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, "amount mismatch");
  assert.equal(balance(DB), 50);
});

test("webhook ignores unknown orders and non-captured events", async () => {
  const DB = makeDb(); seed(DB); addOrder(DB);
  assert.equal((await hook(DB, captured({ order_id: "order_zzz" }))).body.ignored, "unknown order");
  assert.equal((await hook(DB, { event: "payment.failed", payload: {} })).body.ignored, "payment.failed");
  assert.equal(balance(DB), 50);
});

test("webhook is refused when no secret is configured", async () => {
  const DB = makeDb(); seed(DB);
  const request = new Request("https://x/api/hooks/razorpay", { method: "POST", body: "{}" });
  const res = await hooks({ request, env: { DB }, url: new URL(request.url), origin: null });
  assert.equal(res.status, 503);
});
