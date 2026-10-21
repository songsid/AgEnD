// Product feature policy only: this module imports no experimental runtime.
import { appStore } from "./app-store.js";
import { navStore } from "./app-nav.js";
import { ownerEffectsChosen, onOwnerEffectsChanged } from "./app-prefs.js";
import { register } from "./app-i18n.js";
import { html, useEffect, useState } from "./app-html.js";
register("cwControls", { en: { title: "Effects" }, "zh-TW": { title: "效果" } });
export function canvasWorkerEnabled() { return appStore.get().canvasWorker === true; }
export function onCanvasWorkerChange(fn) {
  let value = canvasWorkerEnabled();
  return appStore.subscribe(() => { const next = canvasWorkerEnabled(); if (next !== value) { value = next; fn(next); } });
}
export function useCanvasWorker() {
  const [value, setValue] = useState(canvasWorkerEnabled);
  useEffect(() => { setValue(canvasWorkerEnabled()); return onCanvasWorkerChange(setValue); }, []);
  return value;
}
// Never evaluate the optional module before admission. An obsolete import may finish, but cannot mount.
export function experimentalComponent(load, select) {
  return function ExperimentalComponent(props) {
    const enabled = useCanvasWorker(), [component, setComponent] = useState(null);
    useEffect(() => {
      let current = true;
      if (enabled) load().then(module => { if (current && canvasWorkerEnabled()) setComponent(() => select(module)); }, () => {});
      return () => { current = false; };
    }, [enabled]);
    return enabled && component ? html`<${component} ...${props} />` : null;
  };
}

/** effect_chat_v of a chat with no placements: sha256(JSON.stringify([])), first 32 hex (fleet-manager's status row). */
export const EMPTY_CHAT_EFFECTS = "4f53cda18c2baa0c0354bb5f9a3ecbe5";

let mod = null, waking = null, chatStore = null, started = false, generation = 0, awakeGeneration = -1, retiring = Promise.resolve();
const awakeListeners = new Set();

/** Whether `name`'s chat has Canvas Worker placements (as the status rows say). */
export function chatHasEffects(name, app = appStore.get()) {
  const v = name ? app.instances?.find(i => i.name === name)?.effect_chat_v : undefined;
  return canvasWorkerEnabled() && typeof v === "string" && /^[a-f0-9]{32}$/.test(v) && v !== EMPTY_CHAT_EFFECTS;
}

/** The running effects owner, or null while dormant (or when it could not start: as getAppEffects always was). */
export function getAppEffects(host) { return canvasWorkerEnabled() && mod ? mod.getAppEffects(host) : null; }

/** Whether the runtime has been asked to start on this page. */
export function effectsAwake() { return waking !== null; }
/** Whether its module has loaded (started, or found it could not: getAppEffects() then says which). */
export function effectsLoaded() { return mod !== null && awakeGeneration === generation; }

/** Follow every completed runtime episode, including a replacement after an experimental off/on. */
export function onEffectsAwake(fn) {
  if (typeof fn !== "function") return () => {};
  awakeListeners.add(fn);
  if (effectsLoaded()) { try { fn(); } catch { /* a listener's error is its own */ } }
  return () => awakeListeners.delete(fn);
}

/** Load lazily; each explicitly enabled episode owns its startup and cancellation. */
export function wakeEffects() {
  if (!canvasWorkerEnabled()) return Promise.resolve(null);
  if (waking) return waking;
  const episode = generation;
  waking = (mod ? Promise.resolve(mod) : import("/ui/js/app-effects.js")).then(async m => {
    mod = m;
    await retiring;
    if (episode !== generation || !canvasWorkerEnabled()) return null;
    const owner = chatStore ? m.startAppEffects({ store: chatStore }) : null;
    awakeGeneration = episode;
    for (const fn of [...awakeListeners]) { try { fn(); } catch { /* the rest still hear */ } }
    return owner;
  }, () => null);
  return waking;
}

/** Wake when the open chat has placements or the person has a personal effect. */
function check() {
  if (!canvasWorkerEnabled()) {
    generation++;
    const owner = mod?.getAppEffects();
    if (owner) retiring = Promise.resolve(owner.dispose?.(true));
    waking = null;
    return;
  }
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

// Full Canvas Worker metadata stays in the experimental graph, never in ordinary chat boot.
let metadata = null, metadataPending = null;
const metadataListeners = new Set();
export function onCanvasMetadataChange(fn) { metadataListeners.add(fn); return () => metadataListeners.delete(fn); }
export function loadCanvasWorkerMetadata() {
  if (!canvasWorkerEnabled()) return Promise.resolve(null);
  if (metadata) return Promise.resolve(metadata);
  if (metadataPending?.episode === generation) return metadataPending.promise;
  const episode = generation, op = { episode, promise: null };
  metadataPending = op;
  op.promise = import("./effect-display-metadata.js").then(value => {
    if (episode !== generation || !canvasWorkerEnabled()) return null;
    metadata = value;
    for (const fn of [...metadataListeners]) { try { fn(); } catch { /* independent viewers */ } }
    appStore.set({ canvasMetadataEpoch: episode });
    return metadata;
  }, () => null).finally(() => { if (metadataPending === op) metadataPending = null; });
  return op.promise;
}
export function readCanvasTrialMessage(message) {
  if (!canvasWorkerEnabled()) return null;
  if (!metadata) { void loadCanvasWorkerMetadata(); return undefined; }
  return metadata.effectTrialMessage(message);
}
export function canvasWorkerMenuAvailable(host) {
  if (!canvasWorkerEnabled()) return false;
  if (!metadata) { void loadCanvasWorkerMetadata(); return false; }
  return metadata.chatEffectIdentity(host) !== null;
}
