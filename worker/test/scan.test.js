import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, seed } from "./d1.js";
import { handle } from "../src/routes/scan.js";

async function check(DB, body, { role = "admin", evt } = {}) {
  const request = new Request("https://x/api/check", { method: "POST", body: JSON.stringify(body) });
  const res = await handle({
    request, env: { DB }, url: new URL(request.url), origin: null,
    session: { role, evt }, organizerId: "org1"
  });
  return res.json();
}

test("first scan admits, second same-day scan is a duplicate", async () => {
  const DB = makeDb(); seed(DB);
  const a = await check(DB, { ticketId: "T-1", eventDay: 1 });
  assert.equal(a.result, "valid");
  assert.equal(a.daysUsed, 1);
  assert.equal((await check(DB, { ticketId: "T-1", eventDay: 1 })).result, "duplicate");
});

test("a multi-day pass is valid again on the next day", async () => {
  const DB = makeDb(); seed(DB);
  await check(DB, { ticketId: "T-1", eventDay: 1 });
  const d2 = await check(DB, { ticketId: "T-1", eventDay: 2 });
  assert.equal(d2.result, "valid");
  assert.equal(d2.daysUsed, 2);
});

test("allowReEntry admits a duplicate without changing the day count", async () => {
  const DB = makeDb(); seed(DB);
  await check(DB, { ticketId: "T-1", eventDay: 1 });
  const r = await check(DB, { ticketId: "T-1", eventDay: 1, allowReEntry: true });
  assert.equal(r.result, "valid");
  assert.equal(r.isReEntry, true);
  assert.equal(r.daysUsed, 1);
});

test("pass limited to day 2 is refused on day 1", async () => {
  const DB = makeDb(); seed(DB);
  assert.equal((await check(DB, { ticketId: "T-2", eventDay: 1 })).result, "wrong_day");
  assert.equal((await check(DB, { ticketId: "T-2", eventDay: 2 })).result, "valid");
});

test("revoked, unknown and other organizers' tickets are never admitted", async () => {
  const DB = makeDb(); seed(DB);
  assert.equal((await check(DB, { ticketId: "T-3" })).result, "invalid");
  assert.equal((await check(DB, { ticketId: "NOPE" })).result, "notfound");
  assert.equal((await check(DB, { ticketId: "T-OTHER" })).result, "notfound");
});

test("a gate session cannot scan another event, nor outside event dates", async () => {
  const DB = makeDb(); seed(DB);
  assert.equal((await check(DB, { ticketId: "T-1" }, { role: "gate", evt: "other" })).result, "notfound");
  // evt1 started in 2020 and has ended, so a gate is turned away
  assert.equal((await check(DB, { ticketId: "T-1" }, { role: "gate", evt: "evt1" })).result, "wrong_day");
});

test("empty ticket id is a 400", async () => {
  const DB = makeDb(); seed(DB);
  const request = new Request("https://x/api/check", { method: "POST", body: JSON.stringify({ ticketId: " " }) });
  const res = await handle({ request, env: { DB }, url: new URL(request.url), origin: null, session: { role: "admin" }, organizerId: "org1" });
  assert.equal(res.status, 400);
});
