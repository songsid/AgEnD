// #1386 §6.3 (#1408 step 4): browser notifications for "Needs you", per device and opt-in, desktop browsers only.
//
// The list itself is the app store's `needs` (SSE `needs` / the /ui/poll field — no read of its own, #1374). This
// module only watches it, while a signed-in page is open in any panel:
// - a notification only for an item id this page has not seen, and only while the page is hidden (a visible page
//   shows the list; what it showed is seen);
// - a terminal wait (awaiting_input) only once it is ≥ 5 s old, so a dialog AgEnD answers by itself never pings
//   anyone; the list is never delayed;
// - tag = item id, so the same item never stacks; a click focuses the tab and opens that instance's chat.
// The toggle asks Notification.requestPermission() on that click only. Not offered on a phone (the constructor is
// missing or throws there; Discord's notification is the one to rely on) or on a plain-HTTP LAN address.
import { appStore } from "./app-store.js";
import { t } from "./app-i18n.js";

const STORE_KEY = "agend_needs_notify";
const TERMINAL_WAIT_MS = 5000;
const now = () => Date.now();          // item.since is the server's epoch ms: an age compares wall clocks

/** Why notifications cannot be offered here, or "ok". */
export function notifySupport(env = globalThis) {
  if (typeof env.Notification !== "function") return "unsupported";
  const ua = (env.navigator && env.navigator.userAgent) || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "mobile";
  if (env.isSecureContext === false) return "insecure";
  return "ok";
}

function stored() { try { return localStorage.getItem(STORE_KEY) === "1"; } catch { return false; } }
function store(on) { try { if (on) localStorage.setItem(STORE_KEY, "1"); else localStorage.removeItem(STORE_KEY); } catch { /* this page only */ } }

/** On: chosen on this device and still permitted by the browser. */
export function notifyOn(env = globalThis) {
  return notifySupport(env) === "ok" && stored() && env.Notification.permission === "granted";
}

/** The toggle: asks the browser on this click only. Resolves to the state after it ("on", "denied", "off"). */
export async function setNotify(on, env = globalThis) {
  if (!on) { store(false); return "off"; }
  if (notifySupport(env) !== "ok") return "off";
  let permission = env.Notification.permission;
  if (permission !== "granted") {
    try { permission = await env.Notification.requestPermission(); } catch { permission = "denied"; }
  }
  if (permission !== "granted") { store(false); return "denied"; }
  store(true);
  return "on";
}

export const reasonText = (item) => t(`app.needs_reason_${item.reason}`);

let stop = null;

/**
 * Follow the store for the life of the page (full mode only). `open(instance)` is how a click opens a chat.
 * Returns the stop function (for tests); a second start replaces the first.
 */
export function startNeedsNotifier({ open, env = globalThis } = {}) {
  if (stop) stop();
  const seen = new Set();
  const timers = new Map();                       // id → a terminal wait's 5-s check
  const doc = env.document;
  const hidden = () => !!(doc && doc.hidden);
  const notify = (item) => {
    seen.add(item.id);
    if (!notifyOn(env)) return;
    try {
      const n = new env.Notification(item.instance, { body: item.detail ? `${reasonText(item)}: ${item.detail}` : reasonText(item), tag: item.id });
      n.onclick = () => { try { env.focus && env.focus(); } catch { /* ignore */ } if (open) open(item.instance); n.close(); };
    } catch { /* a browser that refuses at the last moment: the list still shows it */ }
  };
  const consider = (items) => {
    const listed = new Set(items.map((i) => i.id));
    for (const [id, h] of timers) if (!listed.has(id)) { clearTimeout(h); timers.delete(id); }
    for (const item of items) {
      if (seen.has(item.id) || timers.has(item.id)) continue;
      if (!hidden()) { seen.add(item.id); continue; }
      const wait = item.type === "awaiting_input" ? TERMINAL_WAIT_MS - (now() - item.since) : 0;
      if (wait > 0) {
        timers.set(item.id, setTimeout(() => {
          timers.delete(item.id);
          const still = (appStore.get().needs || []).find((i) => i.id === item.id);
          if (!still || seen.has(item.id)) return;
          if (hidden()) notify(still); else seen.add(item.id);
        }, wait));
      } else notify(item);
    }
  };
  // Coming back to the page: what is listed now has been seen.
  const onVisible = () => { if (!hidden()) for (const i of appStore.get().needs || []) seen.add(i.id); };
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisible);
  consider(appStore.get().needs || []);
  const off = appStore.subscribe((s) => consider(Array.isArray(s.needs) ? s.needs : []));
  stop = () => {
    off();
    if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisible);
    for (const h of timers.values()) clearTimeout(h);
    timers.clear();
    stop = null;
  };
  return stop;
}
