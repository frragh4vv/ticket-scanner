// Storage notice for TixDesk's public pages. TixDesk sets no advertising or analytics cookies; the only
// browser storage it uses is strictly necessary (sign-in sessions, scanner settings), so this is a
// notice rather than a consent gate. Dismissal is remembered in localStorage.
(function () {
  const KEY = "stub_storage_notice_v1";
  try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }

  const bar = document.createElement("div");
  bar.className = "consent";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Cookie and storage notice");
  bar.innerHTML =
    '<p>We don\'t use advertising or analytics cookies. We only store what\'s needed to keep you signed in and remember scanner settings. ' +
    '<a href="/cookies">Cookie policy</a></p><button type="button">Got it</button>';
  bar.querySelector("button").addEventListener("click", function () {
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch (e) {}
    bar.remove();
  });
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(bar); });
  if (document.readyState !== "loading") document.body.appendChild(bar);
})();
