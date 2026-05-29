// Secure Cloudflare Workers API for Ticket Scanner & Generator

const ALLOWED_HEADERS = "Content-Type, Authorization";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    // 1. Handle CORS Preflight OPTIONS request
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: getCorsHeaders(origin),
      });
    }

    try {
      const url = new URL(request.url);

      // 2. Enforce Authentication Header (Raghav@ticket)
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== "Bearer Raghav@ticket") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // 3. API Routing
      // ----------------------------------------------------
      // POST /api/check -> Scan and Validate a Ticket
      if (url.pathname === "/api/check" && request.method === "POST") {
        const { ticketId, scannerName } = await request.json();
        if (!ticketId || !scannerName) {
          return new Response(JSON.stringify({ error: "Missing parameters" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // Query Firebase
        const res = await fetch(`${env.FIREBASE_URL}/tickets/${ticketId}.json?auth=${env.FIREBASE_SECRET}`);
        const ticket = await res.json();

        if (!ticket) {
          return new Response(JSON.stringify({ result: "notfound", message: "TICKET NOT FOUND\nNot in system." }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        if (ticket.status === "Valid") {
          // Mark as scanned
          const scanTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
          await fetch(`${env.FIREBASE_URL}/tickets/${ticketId}.json?auth=${env.FIREBASE_SECRET}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "Scanned",
              scanned_by: scannerName,
              scan_time: scanTime
            })
          });

          return new Response(JSON.stringify({ result: "valid", message: "VALID TICKET\nEntry Approved!" }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        } else if (ticket.status === "Scanned") {
          return new Response(JSON.stringify({
            result: "duplicate",
            message: `ALREADY SCANNED\nBy: ${ticket.scanned_by || "unknown"}\nAt: ${ticket.scan_time || "unknown time"}`
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        } else {
          return new Response(JSON.stringify({ result: "invalid", message: "INVALID TICKET\nDo not allow entry." }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }
      }

      // ----------------------------------------------------
      // GET /api/tickets -> Retrieve all tickets securely
      if (url.pathname === "/api/tickets" && request.method === "GET") {
        const res = await fetch(`${env.FIREBASE_URL}/tickets.json?auth=${env.FIREBASE_SECRET}`);
        const data = await res.json();
        return new Response(JSON.stringify(data || {}), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // ----------------------------------------------------
      // POST /api/save-email -> Update ticket email securely
      if (url.pathname === "/api/save-email" && request.method === "POST") {
        const { ticketId, email } = await request.json();
        if (!ticketId) {
          return new Response(JSON.stringify({ error: "Missing ticketId" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }
        await fetch(`${env.FIREBASE_URL}/tickets/${ticketId}.json?auth=${env.FIREBASE_SECRET}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email || "" })
        });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // ----------------------------------------------------
      // POST /api/generate -> Generate New Unique Tickets
      if (url.pathname === "/api/generate" && request.method === "POST") {
        const { count } = await request.json();
        const ticketCount = parseInt(count, 10);
        if (isNaN(ticketCount) || ticketCount <= 0 || ticketCount > 5000) {
          return new Response(JSON.stringify({ error: "Invalid ticket count" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        const generatedTickets = {};
        const ticketIdList = [];

        // Generate cryptographically secure unique IDs
        for (let i = 0; i < ticketCount; i++) {
          const uniqueId = crypto.randomUUID().substring(0, 8);
          generatedTickets[uniqueId] = {
            status: "Valid",
            email: "",
            scanned_by: "",
            scan_time: "",
            email_sent: false
          };
          ticketIdList.push(uniqueId);
        }

        // Perform bulk upload of tickets to Firebase
        await fetch(`${env.FIREBASE_URL}/tickets.json?auth=${env.FIREBASE_SECRET}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(generatedTickets)
        });

        return new Response(JSON.stringify({ success: true, tickets: ticketIdList }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // ----------------------------------------------------
      // POST /api/send-email -> Dispatch QR Ticket via Resend API
      if (url.pathname === "/api/send-email" && request.method === "POST") {
        const { ticketId, email } = await request.json();
        if (!ticketId || !email) {
          return new Response(JSON.stringify({ error: "Missing ticketId or email" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // 1. Send Email via Resend API
        const emailBody = {
          from: "Ticket Service <tickets@updates.resend.dev>", // Or custom verified sender domain
          to: [email],
          subject: "🎟️ Your QR Code Entry Ticket",
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; padding: 24px; text-align: center; background: #fafafa;">
              <h2 style="margin-top: 0; color: #111;">Your Event Ticket</h2>
              <p style="color: #666; font-size: 15px; margin-bottom: 24px;">Please present this QR code at the entrance gate for verification.</p>
              
              <div style="background: white; display: inline-block; padding: 16px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); margin-bottom: 20px;">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${ticketId}" alt="Entry QR Code" width="200" height="200" style="display: block;" />
              </div>
              
              <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: #333; letter-spacing: 2px; margin-bottom: 20px;">
                ID: ${ticketId}
              </div>
              
              <div style="font-size: 12px; color: #aaa; border-top: 1px dashed #eee; padding-top: 16px;">
                Restricted access. Valid for single entry only. Do not share this QR code.
              </div>
            </div>
          `
        };

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.RESEND_API_KEY}`
          },
          body: JSON.stringify(emailBody)
        });

        if (!resendRes.ok) {
          const errText = await resendRes.text();
          return new Response(JSON.stringify({ error: "Failed to dispatch email", details: errText }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
          });
        }

        // 2. Update Firebase
        await fetch(`${env.FIREBASE_URL}/tickets/${ticketId}.json?auth=${env.FIREBASE_SECRET}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email,
            email_sent: true
          })
        });

        return new Response(JSON.stringify({ success: true, message: "Email sent successfully" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
        });
      }

      // Default Not Found Router
      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) },
      });
    }
  }
};
