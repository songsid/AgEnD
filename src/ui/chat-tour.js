// #1366: the first sign-in tour, in the app shell (#1408). Shown once on this device (agend_tour_done), dismissed by
// Got it, Skip or Esc, and replayed from Tour in the sidebar. A card that outlines one thing at a time: no overlay,
// nothing blocked, and no style attribute — the outline is a class (#1300). When this browser's storage cannot be read
// it is not shown at all: a tour that comes back on every load is worse than none.
//
// Esc order: the phone drawer covers the card, so it closes first (the shell); then the tour; only then may Esc reach
// the chat and stop a reply. The Esc that closed the tour is spent: its key repeats (a held key) must not go on to stop
// the agent (#1369 review).
import { t, onLang } from "/assets/app-i18n.js";
import { shellStore, closeDrawer } from "/assets/app-shell.js";
import "./chat-strings.js";

const TOUR_KEY = "agend_tour_done";
const byId = (id) => document.getElementById(id);
// On a phone the instance list is in the closed drawer: the tour outlines what opens it (☰), and for "needs you" the
// bottom tab's badge (#1408 step 5: retargeted to the app's shell).
const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches;
const STEPS = [
  { text: "chat.tour1", spot: () => (narrow() ? byId("sbOpen") : byId("instanceList")) },
  { text: "chat.tour2", spot: () => byId("main") },
  { text: "chat.tour3", spot: () => byId("attachBtn") },
  { text: "chat.tour4", spot: () => { const stop = byId("stopBtn"); return stop && !stop.hidden ? stop : byId("sendBtn"); } },
  { text: "chat.tour5", spot: () => (narrow() ? document.querySelector(".tabs .tab-badge") || byId("sbOpen")
    : document.querySelector(".badge-await") || byId("instanceList")) },
];
let at = -1, spot = null, returnTo = null, escHeld = false, installed = false;

export function tourDone() { try { return localStorage.getItem(TOUR_KEY) === "1"; } catch { return true; } }
export function tourStep() { return at; }

export function startTour() {
  // Replayed from the drawer: the drawer closes first (focus goes back to ☰), so the card is seen.
  closeDrawer();
  if (at < 0) returnTo = document.activeElement;
  show(0);
}

/** The current step's outline follows a redraw (a new badge, Send swapped for Stop reply) — same card, same focus. */
export function refreshTourSpot() {
  if (at < 0) return;
  const next = STEPS[at].spot() || null;
  if (next === spot && (!next || next.classList.contains("tour-spot"))) return;
  if (spot) spot.classList.remove("tour-spot");
  spot = next;
  if (spot) spot.classList.add("tour-spot");
}

function show(i) {
  if (i < 0 || i >= STEPS.length) return;
  at = i;
  if (spot) spot.classList.remove("tour-spot");
  spot = STEPS[i].spot() || null;
  if (spot) spot.classList.add("tour-spot");
  let card = byId("tour");
  if (!card) {
    card = document.createElement("section"); card.id = "tour"; card.className = "tour";
    card.setAttribute("role", "dialog"); card.setAttribute("aria-labelledby", "tourTitle");
    card.addEventListener("click", onCardClick);
    document.body.appendChild(card);
  }
  card.textContent = "";
  const title = document.createElement("h2"); title.id = "tourTitle"; title.textContent = t("chat.tourTitle");
  const text = document.createElement("p"); text.className = "tour-text"; text.setAttribute("aria-live", "polite"); text.textContent = t(STEPS[i].text);
  const foot = document.createElement("div"); foot.className = "tour-foot";
  const count = document.createElement("span"); count.className = "tour-count"; count.textContent = t("chat.tourStep", i + 1, STEPS.length);
  const button = (label, act, arg, cls) => {
    const b = document.createElement("button"); b.type = "button"; b.className = `btn btn-sm ${cls}`; b.dataset.tour = act;
    if (arg != null) b.dataset.arg = String(arg);
    b.textContent = t(label); return b;
  };
  foot.append(count);
  if (i < STEPS.length - 1) foot.append(button("chat.tourSkip", "end", null, "btn-ghost"));
  if (i > 0) foot.append(button("chat.tourBack", "move", -1, "btn-ghost"));
  const next = i < STEPS.length - 1 ? button("chat.tourNext", "move", 1, "btn-primary") : button("chat.tourDone", "end", null, "btn-primary");
  foot.append(next);
  card.append(title, text, foot);
  next.focus();
}

function onCardClick(e) {
  const b = e.target && e.target.closest ? e.target.closest("[data-tour]") : null;
  if (!b) return;
  if (b.dataset.tour === "move") show(at + Number(b.dataset.arg));
  else endTour();
}

export function endTour() {
  try { localStorage.setItem(TOUR_KEY, "1"); } catch { /* this page only */ }
  at = -1;
  if (spot) spot.classList.remove("tour-spot");
  spot = null;
  const card = byId("tour"); if (card) card.remove();
  if (returnTo && document.contains(returnTo) && typeof returnTo.focus === "function") returnTo.focus();
  returnTo = null;
}

/** Capture-phase Esc: it runs before the shell's own key handling, so a tour Esc never reaches the chat. */
export function onTourKey(e) {
  if (e.key !== "Escape" || e.isComposing) return;
  if (escHeld) {
    if (e.repeat) { e.preventDefault(); e.stopPropagation(); return; }
    escHeld = false;
  }
  if (shellStore.get().drawer) return;          // the drawer is on top: the shell closes it first
  if (at >= 0) { e.preventDefault(); e.stopPropagation(); endTour(); escHeld = true; }
}

/** Once per page: the key handler, the language follow-up, and the first showing on a device that has not seen it. */
export function installTour() {
  if (installed) return;
  installed = true;
  document.addEventListener("keydown", onTourKey, true);
  onLang(() => { if (at >= 0) show(at); });
  // Shown first on the chat (it points at the chat's own controls), never over View or another panel.
  if (!tourDone() && /^\/ui(\/chat\/|$)/.test(location.pathname)) setTimeout(startTour, 0);
}
