// Light / dark for a panel (#1307). Loaded from /assets/theme.js in <head>, before the page paints, so a chosen theme
// never flashes the other one first. "system" (the default) follows the device's prefers-color-scheme through CSS;
// "light" or "dark" lives in localStorage, like agend_lang.
//
// #1665: the choice is kept on the host and follows the person between devices. The signed-in app's page carries the
// host's values in <html data-prefs>: the host's theme is what this page paints and holds, whatever this browser's
// storage does (the copy kept there is best effort — a full or blocked storage changes nothing on screen). Nothing
// chosen on the host: a device already in step with it (app-prefs.js's migration done) takes the default; one not yet
// in step keeps its own until it has uploaded it. Without data-prefs (the sign-in page, the anonymous View reader) this
// browser's copy decides, as before.
//
// A page's tokens follow the pattern: dark under :root, light under @media (prefers-color-scheme: light) for
// :root:not([data-theme="dark"]), and again under :root[data-theme="light"].
(function () {
  "use strict";
  var KEY = "agend_theme";
  var SYNCED_FLAG = "agend_prefs_synced";
  function valid(v) { return v === "light" || v === "dark" ? v : "system"; }
  function read() {
    try { return valid(localStorage.getItem(KEY)); } catch (e) { return "system"; }   // storage blocked: follow the device
  }
  function cache(v) {
    try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* this page only */ }
  }
  function apply(v) {
    var root = document.documentElement;
    if (v === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", v);
  }
  /** The host's choice for this page: a theme, or null — none known here (no data-prefs, or not in step yet). */
  function hostChoice() {
    var d = null;
    try { d = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null"); } catch (e) { d = null; }
    if (!d || typeof d !== "object" || !d.values || typeof d.values !== "object") return null;
    var v = d.values.theme;
    if (v === "light" || v === "dark" || v === "system") return v;
    var inStep = false;
    try { inStep = localStorage.getItem(SYNCED_FLAG) === "1"; } catch (e) { inStep = false; }
    return inStep ? "system" : null;
  }
  var current = hostChoice();
  if (current !== null) cache(current); else current = read();
  apply(current);
  var listeners = [];
  window.AgendTheme = {
    /** The theme this page shows. */
    get: function () { return current; },
    /** Choose "system", "light" or "dark" (this browser's copy; app-prefs.js keeps the host's); applied now even when it cannot be stored. */
    set: function (v) {
      current = valid(v);
      cache(current);
      apply(current);
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](current); } catch (e) { /* one listener's error stops no other */ } }
    },
    /** Call `fn` with the theme whenever it changes on this page (an open Preferences shows it); returns the unsubscribe. */
    onChange: function (fn) {
      listeners.push(fn);
      return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
  };
})();
