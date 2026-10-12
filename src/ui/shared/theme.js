// Light / dark for a panel (#1307). Loaded from /assets/theme.js in <head>, before the page paints, so a chosen theme
// never flashes the other one first. "system" (the default) follows the device's prefers-color-scheme through CSS;
// "light" or "dark" lives in localStorage, like agend_lang.
//
// #1665: the choice is kept on the host and follows the person between devices. The signed-in app's page carries the
// host's value in <html data-prefs> — it wins over this browser's copy (which it refreshes), so a device paints
// the synced theme first, a new device included. Without it (the sign-in page, the anonymous View reader, a fleet
// with nothing chosen yet) the browser's copy decides, as before.
//
// A page's tokens follow the pattern: dark under :root, light under @media (prefers-color-scheme: light) for
// :root:not([data-theme="dark"]), and again under :root[data-theme="light"].
(function () {
  "use strict";
  var KEY = "agend_theme";
  function valid(v) { return v === "light" || v === "dark" ? v : "system"; }
  function read() {
    try { return valid(localStorage.getItem(KEY)); } catch (e) { return "system"; }   // storage blocked: follow the device
  }
  function cache(v) {
    try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* this page only */ }
  }
  var host = null;
  try { host = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null").values.theme; } catch (e) { /* none */ }
  if (host === "light" || host === "dark" || host === "system") cache(host);
  function apply(v) {
    var root = document.documentElement;
    if (v === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", v);
  }
  apply(read());
  window.AgendTheme = {
    get: read,
    /** Choose "system", "light" or "dark" (this browser's copy; app-prefs.js keeps the host's); applied now even when it cannot be stored. */
    set: function (v) {
      v = valid(v);
      cache(v);
      apply(v);
    },
  };
})();
