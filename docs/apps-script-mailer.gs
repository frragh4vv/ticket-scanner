// Gmail mail relay for the TixDesk Worker (MAIL_PROVIDER=appscript).
// Setup: script.google.com > New project > paste this file.
//   Project Settings > Script properties > add SECRET = <long random string> (same value as APPS_SCRIPT_SECRET in the Worker).
//   Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone > copy the /exec URL into APPS_SCRIPT_URL.
// Re-deploy (new version) after editing this file. Free Gmail sends about 100 recipients a day.

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!secret || body.secret !== secret) return out({ ok: false, error: "unauthorized" });
    if (!body.to || !body.subject || !body.html) return out({ ok: false, error: "missing fields" });

    var attachments = (body.attachments || []).map(function (a) {
      return Utilities.newBlob(Utilities.base64Decode(a.content), a.mimeType, a.filename);
    });
    MailApp.sendEmail({
      to: body.to,
      subject: body.subject,
      htmlBody: body.html,
      name: body.name || "Tickets",
      attachments: attachments
    });
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
