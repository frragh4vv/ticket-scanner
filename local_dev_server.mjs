import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "./worker/src/index.js";

const PORT = 8787;
const DB_PATH = "ticket_scanner_dev.sqlite";

// Create SQLite DB
const db = new DatabaseSync(DB_PATH);
const schema = fs.readFileSync("worker/schema.sql", "utf8");
db.exec(schema);

// Optional seed
try {
  const seed = fs.readFileSync("worker/seed.sql", "utf8");
  db.exec(seed);
} catch (e) {
  console.log("Seed note:", e.message);
}

function createD1(db) {
  return {
    prepare(query) {
      let boundParams = [];
      return {
        bind(...params) {
          boundParams = params;
          return this;
        },
        async first() {
          const stmt = db.prepare(query);
          return stmt.get(...boundParams) || null;
        },
        async all() {
          const stmt = db.prepare(query);
          const results = stmt.all(...boundParams);
          return { results };
        },
        async run() {
          const stmt = db.prepare(query);
          const info = stmt.run(...boundParams);
          return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
        }
      };
    },
    async batch(statements) {
      const results = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) {
          results.push(await s.run());
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return results;
    }
  };
}

const mockAssets = {
  async fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname;
    if (p === "/" || p === "") p = "/landing.html";
    if (p === "/landing") p = "/landing.html";
    if (p === "/scan" || p === "/scanner") p = "/scanner.html";
    if (p === "/admin" || p === "/login" || p === "/signup") p = "/admin.html";
    if (p === "/reset") p = "/reset.html";
    if (!path.extname(p)) p += ".html";

    const localPath = path.join("worker", "public", p.replace(/^\//, ""));
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath);
      let contentType = "text/html; charset=utf-8";
      if (p.endsWith(".css")) contentType = "text/css";
      if (p.endsWith(".js")) contentType = "application/javascript";
      if (p.endsWith(".svg")) contentType = "image/svg+xml";
      if (p.endsWith(".jpg") || p.endsWith(".jpeg")) contentType = "image/jpeg";
      if (p.endsWith(".png")) contentType = "image/png";
      return new Response(content, { status: 200, headers: { "Content-Type": contentType } });
    }
    return new Response("Not found", { status: 404 });
  }
};

const env = {
  DB: createD1(db),
  ASSETS: mockAssets,
  SESSION_SECRET: "development-super-secret-key-32-chars-long",
  SCANNER_ACCESS_KEY: "admin_dev_passkey_999",
  DEMO_BILLING: "true"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Static routing
  if (!pathname.startsWith("/api/")) {
    let filePath = "";
    if (pathname === "/" || pathname === "/landing") filePath = "worker/public/landing.html";
    else if (pathname === "/scan" || pathname === "/scanner") filePath = "worker/public/scanner.html";
    else if (pathname === "/admin" || pathname === "/login" || pathname === "/signup") filePath = "worker/public/admin.html";
    else if (pathname === "/reset") filePath = "worker/public/reset.html";
    else {
      const possible = path.join("worker/public", pathname.replace(/^\//, ""));
      if (fs.existsSync(possible) && fs.statSync(possible).isFile()) {
        filePath = possible;
      } else if (fs.existsSync(possible + ".html")) {
        filePath = possible + ".html";
      }
    }

    if (filePath && fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // API routing via Worker fetch
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const body = Buffer.concat(buffers);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      v.forEach(val => headers.append(k, val));
    } else if (v) {
      headers.set(k, v);
    }
  }

  const webReq = new Request(url.toString(), {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body
  });

  try {
    const webRes = await worker.fetch(webReq, env);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const resBody = await webRes.arrayBuffer();
    res.end(Buffer.from(resBody));
  } catch (err) {
    console.error("Worker fetch error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error", message: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n======================================================`);
  console.log(`🎟️ TicketScanner Pro Dev Server Running!`);
  console.log(`👉 Landing Page: http://localhost:${PORT}/`);
  console.log(`👉 Organizer Sign-up: http://localhost:${PORT}/signup`);
  console.log(`👉 Organizer Dashboard: http://localhost:${PORT}/admin`);
  console.log(`👉 Gate Scanner: http://localhost:${PORT}/scan`);
  console.log(`======================================================\n`);
});

