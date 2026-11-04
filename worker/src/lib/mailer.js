// Outbound mail transport. Picks a provider so callers don't care which one is live.
//   MAIL_PROVIDER=appscript  Google Apps Script web app (docs/apps-script-mailer.gs), sends from your Gmail
//   MAIL_PROVIDER=resend     Resend API
// Unset: appscript when APPS_SCRIPT_URL is set, otherwise resend.
// attachments: [{ filename, content }] with base64 content.
// Returns { ok, status, text }; status 500 means the provider isn't configured.

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

export function mailProvider(env) {
  const p = String(env.MAIL_PROVIDER || "").toLowerCase();
  if (p === "appscript" || p === "resend") return p;
  return env.APPS_SCRIPT_URL ? "appscript" : "resend";
}

export function mailConfigured(env) {
  return mailProvider(env) === "appscript" ? !!(env.APPS_SCRIPT_URL && env.APPS_SCRIPT_SECRET) : !!env.RESEND_API_KEY;
}

export async function sendMail(env, { to, subject, html, attachments = [], fromName }) {
  if (mailProvider(env) === "appscript") return sendViaAppsScript(env, { to, subject, html, attachments, fromName });
  return sendViaResend(env, { to, subject, html, attachments, fromName });
}

async function sendViaResend(env, { to, subject, html, attachments, fromName }) {
  if (!env.RESEND_API_KEY) return { ok: false, status: 500, text: "RESEND_API_KEY is not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM || `${fromName || "Tickets"} <onboarding@resend.dev>`,
      to: [to],
      subject,
      html,
      ...(attachments.length ? { attachments } : {})
    })
  });
  return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
}

async function sendViaAppsScript(env, { to, subject, html, attachments, fromName }) {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_SECRET) {
    return { ok: false, status: 500, text: "APPS_SCRIPT_URL and APPS_SCRIPT_SECRET are not configured" };
  }
  // text/plain keeps this a simple request; the script reads the raw body. Apps Script answers via a redirect, which fetch follows.
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      secret: env.APPS_SCRIPT_SECRET,
      to,
      subject,
      html,
      name: fromName || "Tickets",
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        mimeType: MIME[a.filename.split(".").pop().toLowerCase()] || "application/octet-stream"
      }))
    })
  });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { /* HTML error page from Google */ }
  if (res.ok && out && out.ok) return { ok: true, status: 200, text: "" };
  // Apps Script always answers 200, so quota errors only show up in the message
  const msg = (out && out.error) || text.slice(0, 300);
  return { ok: false, status: /too many times|quota|limit exceeded/i.test(msg) ? 429 : 502, text: msg };
}
