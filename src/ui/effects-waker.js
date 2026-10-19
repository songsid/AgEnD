// #2193: the web effects runtime stays unloaded until there is something it could play for this viewer. Before that,
// this module is all there is: a few store subscriptions comparing fields the page already has (no observer, listener,
// timer, layer or request). The runtime itself (app-effects.js and everything it imports) is the reviewed code,
// unchanged; it is imported and started here, once, the first time one of these holds:
//   - the open chat has Canvas Worker placements: its status row's effect_chat_v (the hash of its placements, taken
//     before the server's region filtering — so it can only wake for nothing, never miss something) is not the hash of
//     an empty list;
//   - the signed-in person has a personal effect slot chosen (fx.page/header/sidebar/box/cursor — app-prefs);
//   - an agent's "Try" offer is shown (wakeEffects() from the chat), or Settings saved a personal effect.
// Once started it stays for the page: the runtime is one episode per window (a disposed one cannot start again).
// Owner CSS is not the runtime's: owner-css.js is installed by the app shell and works with the runtime never loaded.
import { appStore } from "/assets/app-store.js";
import { navStore } from "/assets/app-nav.js";
import { ownerEffectsChosen, onOwnerEffectsChanged } from "/assets/app-prefs.js";

/** effect_chat_v of a chat with no placements: sha256(JSON.stringify([])), first 32 hex (fleet-manager's status row). */
export const EMPTY_CHAT_EFFECTS = "4f53cda18c2baa0c0354bb5f9a3ecbe5";

let mod = null, waking = null, chatStore = null, started = false;
const awakeListeners = new Set();

/** Whether `name`'s chat has Canvas Worker placements (as the status rows say). */
export function chatHasEffects(name, app = appStore.get()) {
  const v = name ? app.instances?.find(i => i.name === name)?.effect_chat_v : undefined;
  return typeof v === "string" && /^[a-f0-9]{32}$/.test(v) && v !== EMPTY_CHAT_EFFECTS;
}

/** The running effects owner, or null while dormant (or when it could not start: as getAppEffects always was). */
export function getAppEffects(host) { return mod ? mod.getAppEffects(host) : null; }

/** Whether the runtime has been asked to start on this page. */
export function effectsAwake() { return waking !== null; }
/** Whether its module has loaded (started, or found it could not: getAppEffects() then says which). */
export function effectsLoaded() { return mod !== null; }

/** Called once the runtime has started (or immediately when it already has). Returns the unsubscribe. */
export function onEffectsAwake(fn) {
  if (typeof fn !== "function") return () => {};
  if (mod) { try { fn(); } catch { /* a listener's error is its own */ } return () => {}; }
  awakeListeners.add(fn); return () => awakeListeners.delete(fn);
}

/** Load and start the runtime (once per page). Resolves to the owner, or null when it could not start. */
export function wakeEffects() {
  if (waking) return waking;
  waking = import("./app-effects.js").then(m => {
    mod = m;
    const owner = chatStore ? m.startAppEffects({ store: chatStore }) : null;
    for (const fn of [...awakeListeners]) { try { fn(); } catch { /* the rest still hear */ } }
    awakeListeners.clear();
    return owner;
  }, () => null);
  return waking;
}

/** Wake when the open chat has placements or the person has a personal effect. */
function check() {
  if (waking) return;
  const route = navStore.get().route;
  if ((route?.panel === "chat" && chatHasEffects(route.instance)) || ownerEffectsChosen()) void wakeEffects();
}

/** Boot (once per page, with the Chat store the runtime binds to). Starts nothing but the watch. */
export function startEffectsWaker({ store }) {
  chatStore = store;
  if (started) return;
  started = true;
  appStore.subscribe(check); navStore.subscribe(check); onOwnerEffectsChanged(check);
  check();
}
