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
  var PALETTE_KEY = "agend_palette";
  var PALETTES = ["sky", "meadow", "violet", "mint"];
  var SYNCED_FLAG = "agend_prefs_synced";
  function valid(v) { return v === "light" || v === "dark" ? v : "system"; }
  function validPalette(v) { return PALETTES.indexOf(v) >= 0 ? v : ""; }
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
    if (palette) root.setAttribute("data-palette", palette);
    else root.removeAttribute("data-palette");
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
  // Built-in colours are this browser's base palette. Agent page colours and owner CSS remain above it.
  var palette = "";
  try { palette = validPalette(localStorage.getItem(PALETTE_KEY)); } catch (e) { /* default */ }
  if (current !== null) cache(current); else current = read();
  apply(current);
  var listeners = [];
  var preview = null;
  function retirePreview() {
    if (preview) { current = preview.mode; palette = preview.colours; preview = null; }
  }
  function changed() {
    apply(current);
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](current); } catch (e) { /* independent listeners */ } }
  }
  function cachePalette() {
    try { if (palette) localStorage.setItem(PALETTE_KEY, palette); else localStorage.removeItem(PALETTE_KEY); } catch (e) { /* this page only */ }
  }
  window.AgendTheme = {
    /** The theme this page shows. */
    get: function () { return current; },
    getPalette: function () { return palette; },
    setPalette: function (v) { retirePreview(); palette = validPalette(v); cachePalette(); changed(); },
    /** Choose "system", "light" or "dark" (this browser's copy; app-prefs.js keeps the host's); applied now even when it cannot be stored. */
    set: function (v) {
      retirePreview();
      current = valid(v);
      cache(current);
      changed();
    },
    /** A dialog's temporary paint. An outside choice retires it; cancel never overwrites that newer choice. */
    beginPreview: function () {
      retirePreview();
      var lease = { mode: current, colours: palette }, before = current, beforePalette = palette;
      preview = lease;
      return {
        isCurrent: function () { return preview === lease; },
        update: function (mode, colours) { if (preview !== lease) return; current = valid(mode); palette = validPalette(colours); changed(); },
        cancel: function () { if (preview !== lease) return; preview = null; current = before; palette = beforePalette; changed(); },
        commit: function () { if (preview !== lease) return false; preview = null; cache(current); cachePalette(); changed(); return true; },
      };
    },
    /** Call `fn` with the theme whenever it changes on this page (an open Preferences shows it); returns the unsubscribe. */
    onChange: function (fn) {
      listeners.push(fn);
      return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
  };
})();

// The installed window's title bar follows the page, including page themes and owner CSS.
// Read paint rather than the OS setting: a person can choose Dark on a light desktop.
(function () {
  "use strict";
  if (!document.head || typeof window.getComputedStyle !== "function") return;
  var pending = false;
  function fallback() {
    var mode = window.AgendTheme.get();
    if (mode === "system") mode = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    return mode === "light" ? "#ffffff" : "#212121";
  }
  function color() {
    var el = document.body || document.documentElement, top = Infinity;
    var heads = document.querySelectorAll(".panel-head");
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      if (h.getClientRects().length && h.getBoundingClientRect().top < top) { el = h; top = h.getBoundingClientRect().top; }
    }
    // Headers may be transparent: use the nearest painted surface behind them.
    for (; el; el = el.parentElement) {
      var bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/^rgba\([^)]*,\s*0\s*\)$/.test(bg)) return bg;
    }
    return fallback();
  }
  function update() {
    pending = false;
    var tags = document.querySelectorAll('meta[name="theme-color"]'), tag = tags[0];
    if (!tag) { tag = document.createElement("meta"); tag.setAttribute("name", "theme-color"); document.head.appendChild(tag); }
    // Retire the old OS-qualified pair as well, for a tab crossing an upgrade.
    for (var i = 1; i < tags.length; i++) tags[i].remove();
    tag.removeAttribute("media");
    var value = color();
    if (tag.content !== value) tag.content = value;
  }
  function schedule() {
    if (!pending) { pending = true; window.requestAnimationFrame(update); }
  }
  update();
  window.AgendTheme.onChange(schedule);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", schedule);
  document.addEventListener("DOMContentLoaded", schedule);
  document.addEventListener("transitionend", schedule, true);
  document.addEventListener("load", schedule, true); // Stylesheet arrival / replacement, including owner CSS.
  window.addEventListener("pageshow", schedule);
  // Page palettes are applied to the shell; routes replace headers. Coalesce paints and
  // ignore content attributes so updating this meta element cannot trigger itself.
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "data-theme", "data-palette", "data-agent"],
  });
})();
