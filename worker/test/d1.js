// Minimal D1 stand-in on node:sqlite so route modules run against the real schema.sql in tests.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...params).changes } }),
    _exec: () => ({ meta: { changes: db.prepare(sql).run(...params).changes } })
  });

  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map(s => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
  };
}

export function seed(DB, { credits = 50 } = {}) {
  DB.raw.exec(`
    INSERT INTO organizers (id, email, company_name, password_hash, ticket_credits) VALUES
      ('org1', 'a@x.com', 'A', 'h', ${credits}), ('org2', 'b@x.com', 'B', 'h', 50);
    INSERT INTO events (id, organizer_id, title, total_days, start_date, gate_pin) VALUES
      ('evt1', 'org1', 'E1', 3, '2020-01-01', '1111'), ('evt2', 'org2', 'E2', 1, '2020-01-01', '2222');
    INSERT INTO tickets (id, event_id, attendee_name, tier, total_days, allowed_days) VALUES
      ('T-1', 'evt1', 'Ann', 'General', 3, 'ALL'),
      ('T-2', 'evt1', 'Bob', 'VIP', 3, '2'),
      ('T-3', 'evt1', 'Cy', 'General', 3, 'ALL'),
      ('T-OTHER', 'evt2', 'Zed', 'General', 1, '1');
    UPDATE tickets SET status = 'revoked' WHERE id = 'T-3';
  `);
}
