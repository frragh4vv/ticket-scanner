import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb, seed } from "./d1.js";
import { handle } from "../src/routes/designs.js";

async function call(DB, method, path, body, organizerId = "org1") {
  const request = new Request("https://x" + path, { method, body: body ? JSON.stringify(body) : undefined });
  const res = await handle({ request, env: { DB }, url: new URL(request.url), origin: null, organizerId });
  return { status: res.status, body: await res.json() };
}
const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

test("empty event has no design", async () => {
  const DB = makeDb(); seed(DB);
  assert.deepEqual((await call(DB, "GET", "/api/designs?event_id=evt1")).body, { ok: true, layout: null, has_artwork: false });
});

test("layout and artwork round-trip, and saving one does not wipe the other", async () => {
  const DB = makeDb(); seed(DB);
  await call(DB, "PUT", "/api/designs/artwork?event_id=evt1", { image: JPEG });
  await call(DB, "PUT", "/api/designs?event_id=evt1", { layout: { qrX: 10, nameColor: "#fff" } });
  const g = (await call(DB, "GET", "/api/designs?event_id=evt1")).body;
  assert.equal(g.layout.qrX, 10);
  assert.equal(g.has_artwork, true);
  assert.equal((await call(DB, "GET", "/api/designs/artwork?event_id=evt1")).body.image, JPEG);
  await call(DB, "DELETE", "/api/designs/artwork?event_id=evt1");
  const after = (await call(DB, "GET", "/api/designs?event_id=evt1")).body;
  assert.equal(after.has_artwork, false);
  assert.equal(after.layout.qrX, 10);
});

test("another organizer's event is a 404", async () => {
  const DB = makeDb(); seed(DB);
  assert.equal((await call(DB, "GET", "/api/designs?event_id=evt2")).status, 404);
  assert.equal((await call(DB, "PUT", "/api/designs?event_id=evt2", { layout: { a: 1 } })).status, 404);
});

test("rejects non-JPEG, oversized artwork and junk layouts", async () => {
  const DB = makeDb(); seed(DB);
  assert.equal((await call(DB, "PUT", "/api/designs/artwork?event_id=evt1", { image: "data:text/html;base64,AAA" })).status, 400);
  assert.equal((await call(DB, "PUT", "/api/designs/artwork?event_id=evt1", { image: "data:image/jpeg;base64," + "A".repeat(1_700_000) })).status, 400);
  assert.equal((await call(DB, "PUT", "/api/designs?event_id=evt1", { layout: "nope" })).status, 400);
  assert.equal((await call(DB, "PUT", "/api/designs?event_id=evt1", { layout: { big: "x".repeat(9000) } })).status, 400);
});
