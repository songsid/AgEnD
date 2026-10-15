// #1629 r4 §3: owner CSS on this page — the signed-in person's own stylesheet, linked last in <head> so it wins over
// app.css. It is a same-origin <link> (style-src 'self' admits it): no inline CSS, no nonce, no style attribute and no
// constructed stylesheet. Never linked:
// - on Settings (removed while it is open, put back on leaving: the way out is always rendered stock);
// - on the public link, for the anonymous View reader, and wherever the server named no version (data-owner-css);
// - on a device that turned it off (agend_owner_css_off), and for a load with ?safe=1 (safe mode).
// Sign-in, resend-code and setup are other pages: they never load this module.
import { navStore } from "./app-nav.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { html, useEffect, useState } from "./app-html.js";
import { t } from "./app-i18n.js";

export const OWNER_CSS_OFF_KEY = "agend_owner_css_off";
const LINK_ID = "owner-css";

let safe = false;
let active = null;
let installed = false;

/** This load is in safe mode (?safe=1): no owner CSS — and, as they come, no widgets or effects and default themes. */
export function safeMode() { return safe; }

/** This device turned owner CSS off (a per-device switch: not synced, so a broken phone layout is fixed on the phone). */
export function ownerCssOffHere() {
  try { return localStorage.getItem(OWNER_CSS_OFF_KEY) === "1"; } catch { return false; }
}
export function setOwnerCssOffHere(off) {
  try { if (off) localStorage.setItem(OWNER_CSS_OFF_KEY, "1"); else localStorage.removeItem(OWNER_CSS_OFF_KEY); } catch { /* this page only */ }
  sync();
}

/** The person's version in force, as this page knows it (null: none). */
export function ownerCssActive() { return active; }

function eligiblePage() {
  const b = document.body && document.body.dataset;
  return !!b && b.mode === "full" && b.publicLink !== "1";
}
function wanted() {
  if (!eligiblePage() || safe || !active || ownerCssOffHere()) return false;
  const r = navStore.get().route;
  return !(r && r.panel === "settings");
}

/** Link it, update it, or remove it — to match what this page should show now. */
function sync() {
  const el = document.getElementById(LINK_ID);
  if (!wanted()) { if (el) el.remove(); return; }
  const href = `/ui/owner-css.css?v=${encodeURIComponent(active)}`;
  if (el) { if (el.getAttribute("href") !== href) el.setAttribute("href", href); return; }
  const link = document.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("id", LINK_ID);
  link.setAttribute("href", href);
  document.head.appendChild(link);                     // last in <head>: after app.css in the cascade
}

/** This page saved, restored or turned off a version: show it at once (null: none). */
export function setOwnerCssActive(sha) {
  active = typeof sha === "string" && /^[0-9a-f]{32}$/.test(sha) ? sha : null;
  sync();
}

// ── Keep or revert (r4 §3): a saved version is on trial. "Keep" within 15 s keeps it; anything else reverts it — the
// page that saved it at 15 s, and the host at its own deadline (a closed tab, or CSS that hid this bar). The bar is the
// shell's, on every page and every device of the person's, so they can look at the result before answering.
// A revert names its trial (POST /ui/owner-css/revert { sha }): the host reverts only that trial, only while it still
// is one — a trial kept on another device meanwhile stays kept.
export const KEEP_SECONDS = 15;
/** { sha, previous, deadline (performance.now ms), local } while a version is on trial, else null. */
export const ownerCssTrial = createStore(null);
let trialTimer = null;
// set(fn) replaces the state; set(object) would merge into it (createStore), and null merges as nothing.
const clearTrial = () => { if (trialTimer) clearTimeout(trialTimer); trialTimer = null; ownerCssTrial.set(() => null); };

async function post(path, body) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { ok: res.ok, status: res.status, body: json };
}

/**
 * A version is in force on trial: show it, and ask. `local`: this page saved it — at the end of `seconds` it reverts it
 * (by its sha). Otherwise (another device's trial, or this page reloaded during one) it counts down to the host's
 * deadline and then asks the host again, which has settled it by then: a device's clock never reverts early.
 */
export function startOwnerCssTrial(sha, previous, seconds = KEEP_SECONDS, local = true) {
  clearTrial();
  setOwnerCssActive(sha);
  const s = Math.max(0, local ? Math.min(KEEP_SECONDS, seconds) : seconds);
  // The bar shows the real time left: 15 s here; up to the host's deadline on a page that did not save it.
  const trial = { sha, previous: previous || null, deadline: performance.now() + s * 1000, local };
  ownerCssTrial.set(() => trial);
  trialTimer = setTimeout(() => { if (local) revertOwnerCss(); else { clearTrial(); reread(); } }, s * 1000);
}
export async function keepOwnerCss() {
  const trial = ownerCssTrial.get();
  if (!trial) return false;
  clearTrial();
  const r = await post("/ui/owner-css/keep", { sha: trial.sha });
  if (!r.ok) { await reread(); return false; }                        // too late: the host reverted it — show what is in force
  return true;
}
export async function revertOwnerCss() {
  const trial = ownerCssTrial.get();
  if (!trial) return;
  clearTrial();
  setOwnerCssActive(trial.previous);                                   // at once; the host's answer below is what stays
  await post("/ui/owner-css/revert", { sha: trial.sha }).catch(() => null);
  await reread();
}

/** The shell's bar: "Keep this CSS?", the seconds left, Keep and Revert. */
export function OwnerCssKeepBar() {
  const trial = useStore(ownerCssTrial);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!trial) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [trial]);
  if (!trial) return null;
  const left = Math.max(0, Math.ceil((trial.deadline - performance.now()) / 1000));
  return html`<div class="oc-keep" role="alertdialog" aria-live="assertive" aria-label=${t("app.ownerCssKeep")} data-trust="">
    <span class="oc-keep-text"><span class="oc-keep-q">${t("app.ownerCssKeep")}</span><span class="oc-keep-left">${t("app.ownerCssKeepLeft", left)}</span></span>
    <button type="button" class="btn btn-primary btn-sm" onClick=${() => { keepOwnerCss(); }}>${t("app.ownerCssKeepYes")}</button>
    <button type="button" class="btn btn-sm" onClick=${() => { revertOwnerCss(); }}>${t("app.ownerCssKeepNo")}</button>
  </div>`;
}

/** Ask the host which version is in force (another device changed it, or a trial ended), and whether one is on trial. */
async function reread() {
  if (!eligiblePage()) return;
  try {
    const res = await fetch("/ui/owner-css/state", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    if (body) reconcile(body);
  } catch { /* the next change tries again */ }
}
/** Match the host: the version in force, and whether one is on trial (another device's included) — or none any more. */
function reconcile(state) {
  const pending = state.pending && state.pending.sha === state.active ? state.pending : null;
  const trial = ownerCssTrial.get();
  if (!pending) { if (trial) clearTrial(); setOwnerCssActive(state.active); return; }
  if (trial && trial.sha === pending.sha) return;                      // already asking about this one
  // A margin under the host's deadline would let this device revert early; it asks again just after the deadline.
  startOwnerCssTrial(pending.sha, pending.previous, Math.max(0, (pending.until - Date.now()) / 1000) + 1, false);
}

/** Once per page load, before the first panel paints. */
export function installOwnerCss() {
  if (installed) return;
  installed = true;
  try { safe = new URLSearchParams(location.search).get("safe") === "1"; } catch { safe = false; }
  const b = document.body && document.body.dataset;
  setOwnerCssActive(b && b.ownerCss);
  navStore.subscribe(sync);
  // What the host says now: a trial in progress (this page reloaded during one, or another device's) shows the bar;
  // one the host has settled since the page was served shows its outcome.
  if (eligiblePage()) reread();
  let rev = appStore.get().prefsRev;
  appStore.subscribe((s) => {
    if (s.prefsRev === rev) return;
    const first = rev === null || rev === undefined;
    rev = s.prefsRev;
    if (!first) reread();
  });
}
