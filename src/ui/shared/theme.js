// Light / dark for a panel (#1307). Loaded from /assets/theme.js in <head>, before the page paints, so a chosen theme
// never flashes the other one first. "system" (the default) follows the device's prefers-color-scheme through CSS;
// "light" or "dark" is this browser's own choice and lives in localStorage, like agend_lang.
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
  function apply(v) {
    var root = document.documentElement;
    if (v === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", v);
  }
  apply(read());
  window.AgendTheme = {
    get: read,
    /** Choose "system", "light" or "dark" for this browser; applied now even when it cannot be stored. */
    set: function (v) {
      v = valid(v);
      try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* this page only */ }
      apply(v);
    },
  };
})();
