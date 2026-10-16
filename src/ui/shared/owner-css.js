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

// Read when this module loads, so it holds for whatever asks first (themes start before installOwnerCss runs).
const readSafe = () => { try { return new URLSearchParams(location.search).get("safe") === "1"; } catch { return false; } };
let safe = readSafe();
let active = null;
let installed = false;
// B2: admission uses positive observed lifecycle, never active===null as proof of absence.
const lifeStore = createStore(Object.freeze({ state: "unknown", generation: 0, reason: "unverified" }));
export const ownerCssLifecycle = Object.freeze({ get: lifeStore.get, subscribe: lifeStore.subscribe });
let lifeGeneration = 0, linkGeneration = 0, ownedLink = null, linkState = "unknown", sourceState = "unknown";
function life(state, reason) { lifeStore.set(() => Object.freeze({ state, generation: ++lifeGeneration, reason })); }


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

/** Revoke admission before a CSS/route mutation; a missing element alone is never an off verdict. */
function sync() {
  life("unknown", "changing");
  const el = document.getElementById(LINK_ID);
  if (!wanted()) {
    ++linkGeneration;
    if (el) el.remove();
    if (ownedLink && ownedLink !== el) ownedLink.remove();
    ownedLink = null; linkState = "unknown";
    const absent = document.querySelectorAll(`#${LINK_ID}`).length === 0;
    const route = navStore.get().route;
    const disabled = !eligiblePage() || safe || ownerCssOffHere() || route?.panel === "settings";
    life(absent && (disabled || sourceState === "off") ? "off" : "unknown", absent ? disabled ? "disabled_here" : sourceState === "off" ? "host_off" : "unverified" : "removal_failed");
    return;
  }
  const href = `/ui/owner-css.css?v=${encodeURIComponent(active)}`;
  if (el && el !== ownedLink) { life("unknown", "unowned_link"); return; }
  if (ownedLink && el === ownedLink && el.getAttribute("href") === href) { life(linkState, linkState === "on" ? "loaded" : linkState === "loading" ? "loading" : "load_failed"); return; }
  // A new owned element fences late events from the previous version, including href changes.
  const epoch = ++linkGeneration, sha = active;
  if (ownedLink) ownedLink.remove();
  const link = document.createElement("link"); ownedLink = link; linkState = "loading";
  link.setAttribute("rel", "stylesheet"); link.setAttribute("id", LINK_ID); link.setAttribute("href", href);
  const current = () => ownedLink === link && epoch === linkGeneration && active === sha && wanted()
    && link.isConnected === true && document.getElementById(LINK_ID) === link && link.getAttribute("href") === href;
  link.addEventListener("load", () => {
    if (!current()) return;
    let valid = false;
    try { valid = link.disabled !== true && !!link.sheet && link.sheet.ownerNode === link && link.sheet.disabled !== true && link.sheet.href === new URL(href, location.href).href; } catch { /* unknown stylesheet */ }
    linkState = valid ? "on" : "unknown"; life(linkState, valid ? "loaded" : "load_unverified");
  });
  link.addEventListener("error", () => { if (!current()) return; linkState = "unknown"; life("unknown", "load_failed"); });
  life("loading", "loading");
  document.head.appendChild(link); // last in head; no style text, inline attribute or constructed stylesheet
}

// #1883 r2: every change this page makes, and every read it starts, moves `gen`. A host answer is taken only if nothing
// newer happened after it was asked for — an older /state answer never overwrites a newer read, save, keep or revert.
let gen = 0;
const local = () => ++gen;

/** This page saved, restored or turned off a version: show it at once (null: none). */
export function setOwnerCssActive(sha) {
  local();
  showActive(sha, sha === null ? "off" : "on");
}
function showActive(sha, evidence = "unknown") {
  active = typeof sha === "string" && /^[0-9a-f]{32}$/.test(sha) ? sha : null;
  sourceState = evidence === "off" && sha === null ? "off" : evidence === "on" && active ? "on" : "unknown";
  sync();
}

// ── Keep or revert (r4 §3): a saved version is on trial. "Keep" within 15 s keeps it; anything else reverts it — the
// page that saved it at 15 s, and the host at its own deadline (a closed tab, or CSS that hid this bar). The bar is the
// shell's, on every page and every device of the person's, so they can look at the result before answering.
// A trial has an id of its own (the same text saved twice is two trials): keep and revert name it, and the host acts
// only while that trial still is the one on trial — one kept, reverted or replaced meanwhile, anywhere, stays.
export const KEEP_SECONDS = 15;
/** The host's whole trial budget (20 s) and a second: the longest a page that did not save a trial waits to ask again. */
const HOST_TRIAL_SECONDS = 21;
/** { id, sha, previous, deadline (performance.now ms), local } while a version is on trial, else null. */
export const ownerCssTrial = createStore(null);
let trialTimer = null;
// set(fn) replaces the state; set(object) would merge into it (createStore), and null merges as nothing.
const dropTrial = () => { if (trialTimer) clearTimeout(trialTimer); trialTimer = null; ownerCssTrial.set(() => null); };

async function post(path, body) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { ok: res.ok, status: res.status, body: json };
}

/**
 * Trial `id` (of version `sha`) is in force: show it, and ask. `local`: this page saved it — at the end of `seconds` it
 * reverts it (by its id). Otherwise (another device's trial, or this page loaded during one) `seconds` is the host's
 * own remaining time (never the device's clock), and at its end the page asks the host again, which has settled it.
 */
export function startOwnerCssTrial(id, sha, previous, seconds = KEEP_SECONDS, isLocal = true) {
  local();
  if (trialTimer) clearTimeout(trialTimer);
  showActive(sha, "on");
  const s = Math.max(0, Math.min(isLocal ? KEEP_SECONDS : HOST_TRIAL_SECONDS, Number.isFinite(seconds) ? seconds : 0));
  const trial = { id, sha, previous: previous || null, deadline: performance.now() + s * 1000, local: isLocal };
  ownerCssTrial.set(() => trial);
  trialTimer = setTimeout(() => {
    if (ownerCssTrial.get() !== trial) return;
    if (isLocal) revertOwnerCss(); else { dropTrial(); reread(); }
  }, s * 1000);
}
export async function keepOwnerCss() {
  const trial = ownerCssTrial.get();
  if (!trial) return false;
  local();
  dropTrial();
  const r = await post("/ui/owner-css/keep", { trial: trial.id });
  if (!r.ok) { await reread(); return false; }                        // too late: the host reverted it — show what is in force
  return true;
}
export async function revertOwnerCss() {
  const trial = ownerCssTrial.get();
  if (!trial) return;
  local();
  dropTrial();
  showActive(trial.previous);                                          // at once; the host's answer below is what stays
  await post("/ui/owner-css/revert", { trial: trial.id }).catch(() => null);
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
  return html`<div class="oc-keep" role="alertdialog" aria-live="assertive" aria-label=${t("app.ownerCssKeep")} data-trust="keep">
    <span class="oc-keep-text"><span class="oc-keep-q">${t("app.ownerCssKeep")}</span><span class="oc-keep-left">${t("app.ownerCssKeepLeft", left)}</span></span>
    <button type="button" class="btn btn-primary btn-sm" onClick=${() => { keepOwnerCss(); }}>${t("app.ownerCssKeepYes")}</button>
    <button type="button" class="btn btn-sm" onClick=${() => { revertOwnerCss(); }}>${t("app.ownerCssKeepNo")}</button>
  </div>`;
}

/** Ask the host which version is in force (another device changed it, or a trial ended), and whether one is on trial. */
async function reread() {
  if (!eligiblePage()) return;
  const mine = local();
  sourceState = "unknown"; life("unknown", "refreshing");
  try {
    const res = await fetch("/ui/owner-css/state", { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    if (body && mine === gen) reconcile(body);                         // nothing newer happened since this was asked
  } catch { /* the next change tries again */ }
}
/** Match the host: the version in force, and whether one is on trial (another device's included) — or none any more. */
function reconcile(state) {
  const pending = state.pending && state.pending.sha === state.active && typeof state.pending.id === "string" ? state.pending : null;
  const trial = ownerCssTrial.get();
  if (!pending) { if (trial) dropTrial(); showActive(state.active, state.effectState); return; }
  if (trial && trial.id === pending.id) return;                        // already asking about this one
  // The host's own remaining time and a second (never this device's clock): it has settled the trial by then.
  const remaining = typeof pending.remaining_ms === "number" && Number.isFinite(pending.remaining_ms) ? pending.remaining_ms : 0;
  startOwnerCssTrial(pending.id, pending.sha, pending.previous, remaining / 1000 + 1, false);
}

/** Once per page load, before the first panel paints. */
export function installOwnerCss() {
  if (installed) return;
  installed = true;
  safe = readSafe();
  const b = document.body && document.body.dataset;
  showActive(b?.ownerCss ?? null, b?.ownerCssState);
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
