/*
 * #1306: running an agent's HTML in the web chat — the parent side. Design: docs/design/1306-inline-html-preview.md.
 *
 * The HTML runs in a frame from a SEPARATE listener (the preview origin), sandboxed to an opaque origin, so it cannot
 * act as the signed-in person: it has no dashboard origin, no cookie it can use, no CSRF value. It reaches the frame
 * only by postMessage, after the frame proved it is this fleet's listener (the boot id). What it is NOT promised: that
 * it cannot send data out — so previews are off on every device until that device opts in, and every preview carries
 * the banner saying so.
 *
 * This file knows nothing about the chat, the composer, the fleet's API or navigation: the message listener below can
 * reach the frames it made and nothing else (a test asserts it). Imported by the chat panel (#1408: the import sets globalThis.AgendPreview); also
 * exports itself for the tests.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  // The global as well: the chat imports this file for its side effect (#1408), in the browser and under the tests.
  if (root) root.AgendPreview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var LIMITS = { maxBytes: 1024 * 1024, minHeight: 40, maxHeight: 4000, readyMs: 3000, watchdogMs: 10000, resizePerSec: 10, minDelta: 2, growthFreeze: 5, growthWindowMs: 2000 };
  var OPT_IN_KEY = "agend_html_preview";        // localStorage: "on" — this device allows previews
  var NEVER_KEY = "agend_html_preview_never";   // sessionStorage: "1" — never preview on this device (this session)
  var BANNER = "Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab.";

  var cfg = { dashboardOrigin: "", previewOrigin: "", boot: "", reason: "" };
  var changed = [];   // the page's "this device's choice changed" callbacks (checkbox, cards)
  var live = new Map();   // cardKey → { key, iframe, ch, holder, state, … }   (at most one: one running preview per page)
  var listening = false;

  function now() { return root.performance && typeof root.performance.now === "function" ? root.performance.now() : Date.now(); }
  function store(kind) { try { return root[kind] || null; } catch (e) { return null; } }
  function utf8Bytes(s) { try { return new root.TextEncoder().encode(s).length; } catch (e) { return String(s).length * 3; } }
  function randomCh() {
    var b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    var s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  /** What the server said about this page load (the <body data-*> attributes /ui was served with). */
  function init(data) {
    cfg = {
      dashboardOrigin: String((data && data.dashboardOrigin) || ""),
      previewOrigin: String((data && data.previewOrigin) || ""),
      boot: String((data && data.previewBoot) || ""),
      reason: String((data && data.previewReason) || ""),
    };
    if (!listening && typeof root.addEventListener === "function") {
      root.addEventListener("message", onMessage);
      // The opt-in is per device: another tab of this dashboard turning it off (or clearing storage) stops the
      // previews running here at once. Turning it on elsewhere starts nothing here — only a click on Preview does.
      root.addEventListener("storage", onStorage);
      listening = true;
    }
  }
  function onStorage(event) {
    if (event && event.key !== OPT_IN_KEY && event.key !== null) return;   // key null: storage was cleared
    if (!optedIn()) stopAll("off");
    notify();
  }
  /** Call `fn` whenever this device's choice may have changed (here or in another tab). Returns the unsubscribe: a
   *  chat that leaves takes its callback with it (#1408 §4), so 50 visits leave no callback behind. */
  function onChange(fn) {
    if (typeof fn !== "function") return function () {};
    changed.push(fn);
    return function () { var i = changed.indexOf(fn); if (i >= 0) changed.splice(i, 1); };
  }
  function listeners() { return changed.length; }
  function notify() { for (var i = 0; i < changed.length; i++) { try { changed[i](); } catch (e) { /* one listener's error stops no other */ } } }

  // ── This device's choice ────────────────────────────────

  function optedIn() { var s = store("localStorage"); try { return !!s && s.getItem(OPT_IN_KEY) === "on"; } catch (e) { return false; } }
  /** Allow (or stop allowing) previews on this device. Turning it off stops every running preview at once. */
  function setOptIn(on) {
    var s = store("localStorage");
    try { if (s) { if (on) s.setItem(OPT_IN_KEY, "on"); else s.removeItem(OPT_IN_KEY); } } catch (e) { /* this page only */ }
    if (!on) stopAll("off");
    notify();
  }
  function never() { var s = store("sessionStorage"); try { return !!s && s.getItem(NEVER_KEY) === "1"; } catch (e) { return false; } }
  function setNever(on) {
    var s = store("sessionStorage");
    try { if (s) { if (on) s.setItem(NEVER_KEY, "1"); else s.removeItem(NEVER_KEY); } } catch (e) { /* this page only */ }
    if (on) stopAll("off");
    notify();
  }

  /**
   * Whether this page may run a preview at all, and why not: the server must have chosen a preview origin for this
   * load, the browser must really be at the origin the server believed (a proxy that rewrites Host would otherwise get
   * a frame from the wrong place), and the device must have opted in and not switched previews off.
   */
  function availability() {
    if (!cfg.previewOrigin || !cfg.boot) return { ok: false, why: "server", reason: cfg.reason || "Previews are not available here." };
    var at = root.location && root.location.origin;
    if (!cfg.dashboardOrigin || at !== cfg.dashboardOrigin) {
      return { ok: false, why: "origin", reason: "Previews are off: this page is at " + at + ", but the fleet believes it is at " + (cfg.dashboardOrigin || "an unknown address") + " (a proxy that rewrites Host). Pass the external Host through, or set web.preview_origin." };
    }
    if (never()) return { ok: false, why: "never", reason: "Previews are switched off on this device for this session." };
    if (!optedIn()) return { ok: false, why: "optin", reason: "Previews are off on this device. Allow them from the card's menu or the sidebar." };
    return { ok: true, why: "", reason: "" };
  }

  // ── The frame ───────────────────────────────────────────

  /**
   * The ONE place the dashboard makes an iframe or writes `sandbox` (a test fails if anything else does):
   * opaque origin (allow-scripts only — never allow-same-origin, forms, popups, top navigation, modals, downloads),
   * no permissions, no referrer, from <preview origin>/frame — the only URL the dashboard's frame-src allows.
   */
  function mountPreview(doc) {
    var f = doc.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("allow", "");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("loading", "eager");
    f.setAttribute("title", "Untrusted HTML preview");
    f.className = "preview-frame";
    f.src = cfg.previewOrigin + "/frame";
    return f;
  }

  /**
   * Run `html` in `holder` (a node of the card) for `key`. `ui` is told what happened: ui.state(name, reason) with
   * "starting" | "running" | "stopped" | "unavailable". One preview at a time: any other running one stops first.
   * opts.fill (#1481, the side panel): the frame fills its holder — the same frame from mountPreview, only sized by the
   * panel instead of by the frame's height messages, which it then ignores.
   */
  function start(key, holder, html, ui, opts) {
    var a = availability();
    if (!a.ok) { ui.state("unavailable", a.reason); return false; }
    if (typeof html !== "string" || utf8Bytes(html) > LIMITS.maxBytes) { ui.state("unavailable", "This HTML is over 1 MiB; it is not previewed."); return false; }
    stopAll("another");
    var doc = holder.ownerDocument;
    var iframe = mountPreview(doc);
    var card = {
      key: key, iframe: iframe, ch: randomCh(), holder: holder, html: html, ui: ui, rendered: false,
      height: LIMITS.minHeight, lastApplied: -Infinity, appliedInSecond: [], frozen: false, growth: [], pendingFrame: false,
      readyTimer: null, watchdogTimer: null, fill: !!(opts && opts.fill),
    };
    if (card.fill) iframe.classList.add("fill");
    live.set(key, card);
    card.readyTimer = root.setTimeout(function () {
      if (live.get(key) === card && !card.rendered) stop(key, "unavailable", "Preview unavailable: the preview did not answer within 3 s. If an earlier preview froze, it may still be running — open the dashboard in a new tab. Over SSH, forward the preview port too.");
    }, LIMITS.readyMs);
    holder.appendChild(iframe);
    if (!card.fill) setHeight(card, LIMITS.minHeight);
    ui.state("starting", "");
    return true;
  }

  function setHeight(card, px) { card.height = px; card.iframe.style.height = px + "px"; }   // CSSOM — never a style attribute

  function armWatchdog(card) {
    if (card.watchdogTimer) root.clearTimeout(card.watchdogTimer);
    card.watchdogTimer = root.setTimeout(function () {
      if (live.get(card.key) !== card) return;
      // Best effort: a frame that froze this tab freezes this timer too. Only while the page is visible.
      var hidden = root.document && root.document.visibilityState === "hidden";
      if (hidden) { armWatchdog(card); return; }
      stop(card.key, "stopped", "The preview stopped answering, so it was closed.");
    }, LIMITS.watchdogMs);
  }

  /** Stop the preview for `key`: remove its frame and its timers. A preview is never moved or reloaded silently. */
  function stop(key, state, reason) {
    var card = live.get(key);
    if (!card) return false;
    live.delete(key);
    if (card.readyTimer) root.clearTimeout(card.readyTimer);
    if (card.watchdogTimer) root.clearTimeout(card.watchdogTimer);
    if (card.iframe.parentNode) card.iframe.parentNode.removeChild(card.iframe);
    card.ui.state(state || "stopped", reason || "");
    return true;
  }
  function stopAll(why) {
    var keys = [];
    live.forEach(function (_c, k) { keys.push(k); });
    for (var i = 0; i < keys.length; i++) stop(keys[i], "stopped", why === "off" ? "Previews were switched off on this device." : why === "another" ? "Another preview started." : "");
    return keys;
  }
  /** Stop every preview inside `node` (before the chat replaces, moves or removes it); returns the stopped keys. */
  function stopIn(node) {
    var keys = [];
    live.forEach(function (c, k) { if (node && (node === c.holder || (typeof node.contains === "function" && node.contains(c.holder)))) keys.push(k); });
    for (var i = 0; i < keys.length; i++) stop(keys[i], "stopped", "");
    return keys;
  }
  function running(key) { return live.has(key); }
  function liveCount() { return live.size; }
  function liveFrame(key) { var c = live.get(key); return c ? c.iframe : null; }

  // ── Messages from frames (design §4.2) ──────────────────

  var KEYS = { ready: "boot,ch,type,v", resize: "ch,height,type,v", heartbeat: "ch,type,v" };

  /**
   * The only window message listener. A message counts only from one of OUR frames (event.source is that frame's
   * window, and its origin is the opaque "null"), with one of three exact shapes; each has one effect, on that frame
   * only: ready → send the HTML once (boot checked, opt-in checked again), resize → its height, heartbeat → its
   * watchdog. It has no reference to the chat, the composer, the fleet's API, navigation or storage.
   */
  function onMessage(event) {
    var card = null;
    live.forEach(function (c) { if (event.source && event.source === c.iframe.contentWindow) card = c; });
    if (!card || event.origin !== "null") return;
    var d = event.data;
    if (!d || typeof d !== "object" || Array.isArray(d) || d.v !== 1 || typeof d.type !== "string" || !Object.prototype.hasOwnProperty.call(KEYS, d.type)) return;
    if (Object.keys(d).sort().join(",") !== KEYS[d.type]) return;
    if (d.type === "ready") {
      if (d.ch !== null || typeof d.boot !== "string" || card.rendered) return;
      if (d.boot !== cfg.boot) { stop(card.key, "unavailable", "Preview unavailable: something else answered on the preview port."); return; }
      if (!availability().ok) { stop(card.key, "unavailable", availability().reason); return; }
      card.rendered = true;
      root.clearTimeout(card.readyTimer); card.readyTimer = null;
      card.iframe.contentWindow.postMessage({ v: 1, type: "render", ch: card.ch, html: card.html }, "*");
      armWatchdog(card);
      card.ui.state("running", "");
      return;
    }
    if (d.ch !== card.ch || !card.rendered) return;
    if (d.type === "heartbeat") {
      // A heartbeat never outlives the permission: if this device stopped allowing previews (and the storage event
      // was missed), the next heartbeat ends it.
      if (!availability().ok) { stop(card.key, "stopped", "Previews were switched off on this device."); return; }
      armWatchdog(card);
      return;
    }
    if (typeof d.height !== "number" || !isFinite(d.height) || Math.floor(d.height) !== d.height) return;
    requestHeight(card, d.height);
  }

  /** Height rules (design §4.2): clamp to [40, 4000]; ≤ 1 per animation frame and ≤ 10 per second; Δ < 2 px ignored;
   *  after 5 consecutive increases within 2 s the height freezes and the frame scrolls. */
  function requestHeight(card, h) {
    if (card.fill) return;                            // the panel sizes it (#1481)
    var want = Math.max(LIMITS.minHeight, Math.min(LIMITS.maxHeight, h));
    if (Math.abs(want - card.height) < LIMITS.minDelta) return;
    var t = now();
    if (want > card.height) {
      card.growth = card.growth.filter(function (x) { return t - x < LIMITS.growthWindowMs; });
      card.growth.push(t);
      if (card.growth.length > LIMITS.growthFreeze) card.frozen = true;
    } else card.growth = [];
    if (card.frozen) return;
    card.appliedInSecond = card.appliedInSecond.filter(function (x) { return t - x < 1000; });
    if (card.appliedInSecond.length >= LIMITS.resizePerSec) return;
    card.wanted = want;
    if (card.pendingFrame) return;
    card.pendingFrame = true;
    var raf = typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame : function (f) { return root.setTimeout(f, 16); };
    raf(function () {
      card.pendingFrame = false;
      if (live.get(card.key) !== card) return;
      card.appliedInSecond.push(now());
      setHeight(card, card.wanted);
    });
  }

  return {
    init: init, availability: availability, optedIn: optedIn, setOptIn: setOptIn, never: never, setNever: setNever, onChange: onChange, listeners: listeners, onStorage: onStorage,
    start: start, stop: stop, stopAll: stopAll, stopIn: stopIn, running: running, liveCount: liveCount, liveFrame: liveFrame,
    mountPreview: mountPreview, onMessage: onMessage, BANNER: BANNER, LIMITS: LIMITS,
  };
});
