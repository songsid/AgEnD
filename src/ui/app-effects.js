/** #1629: one session-only app effect owner. Importing this module starts nothing. */
import { appStore } from "/assets/app-store.js";
import { motionBlocked, onMotionChange } from "/assets/fx-motion.js";
import { navStore } from "/assets/app-nav.js";
import { onPrefsChanged } from "/assets/app-prefs.js";
import { resolvedMode, themesStore, themesShown } from "/assets/app-themes.js";
import { ownerCssLifecycle, safeMode } from "/assets/owner-css.js";
import { constrainedDevice } from "/assets/effect-policy.js";
import { createAppEffectRuntime } from "/assets/effect-app-runtime.js";
import { effectBootstrapReady } from "/assets/effect-frame.js";
import { createEffectCursor } from "/assets/effect-cursor.js";
import { createOwnerEffectRegions } from "/assets/effect-owner-regions.js";
import { chatEffectIdentity, effectPlaybackIdentity } from "/assets/effect-chat-runtime.js";
import { createEffectTrialController } from "./effect-trial-controller.js";
import { effectTrialMessage } from "./effect-trial-offer.js";
import { claimPanel, panelVersion, panelStore, openTrialPanel, closePanel } from "./preview-panel.js";
const owners = new WeakMap();
export function getAppEffects(host = window) { const value = owners.get(host); return value && !value.dead && value.api?.ok ? value : null; }

/** Boot once with the page's Chat store, including when the first visible panel is Fleet. */
export function startAppEffects({ store, window: host = window, factories = {} } = {}) {
  const existing = owners.get(host);
  if (existing) { if (!existing.dead) existing.bindStore(store); return getAppEffects(host); }
  const playbackIdentity = effectPlaybackIdentity(host), ownerIdentity = chatEffectIdentity(host);
  if (!playbackIdentity || typeof host.AgendAuth?.onSessionEnd !== "function" || typeof host.AgendAuth?.sessionEnded !== "function") return null;
  const doc = host.document, releases = [], ended = new Set(), updates = new Set(), trialUpdates = new Set(); let replyOff = null, replyStore = null, regions = null, cursor = null, cursorStamp = null, trialControl = null, trialIntent = null, trialHint = ownerIdentity ? null : false, trialSerial = 0, trialStamp = null, chatBinding = null;
  const safe = fn => { try { return fn(); } catch { return null; } };
  const hold = off => { if (entry.dead) safe(() => off?.()); else releases.push(off); };
  const entry = { dead: false, api: null,
    cursorSnapshot: () => cursor?.snapshot() ?? { status: "unavailable", id: null },
    gates: () => context(),
    subscribe(fn) { if (typeof fn !== "function" || entry.dead) return () => {}; updates.add(fn); return () => updates.delete(fn); },
    subscribeTrial(fn) { if (typeof fn !== "function" || entry.dead) return () => {}; trialUpdates.add(fn); return () => trialUpdates.delete(fn); },
    onEnd(fn) { if (typeof fn !== "function") return () => {}; if (entry.dead) { safe(fn); return () => {}; } ended.add(fn); return () => ended.delete(fn); },
    bindStore(value) {
      if (entry.dead || value === replyStore) return;
      safe(() => replyOff?.()); replyOff = null; replyStore = value;
      trialControl?.stop(); chatBinding = null; entry.api?.detachChat();
      if (typeof value?.onAgentReply === "function") {
        const off = value.onAgentReply(event => { if (!entry.dead && replyStore === value) entry.api?.reply(event); });
        if (entry.dead || replyStore !== value) safe(() => off?.()); else replyOff = off;
      }
    },
    trialStatus(message) {
      const offer = safe(() => effectTrialMessage(message)), nav = navStore.get();
      const now = safe(() => host.Date.now());
      if (!offer || !Number.isFinite(now) || now >= offer.expiresAt) return "expired";
      if (trialHint === null && !entry.dead) return "checking";
      if (entry.dead || !trialHint || trialControl?.ok !== true) return "localAdmin";
      if (!chatBinding || safe(() => chatBinding.current()) !== true || message.instance !== nav.route?.instance || nav.route?.panel !== "chat") return "chatChanged";
      const state = trialControl.snapshot();
      if (state.phase !== "idle" || state.busy) return "busy";
      return trialPlaybackStatus();
    },
    trialFailure(message) {
      const offer = safe(() => effectTrialMessage(message)), state = trialControl?.snapshot();
      return offer && state?.phase === "idle" && state.offer === offer.offer && !["stopped", "replaced"].includes(state.reason) ? state.reason : null;
    },
    canTry(message) { return entry.trialStatus(message) === "ready"; },
    stopTrial() { trialControl?.stop(); },
    startTrial(message) {
      if (!entry.canTry(message)) return Promise.resolve(false);
      const nav = navStore.get(); trialIntent = { name: message.instance, seq: nav.seq, claim: claimPanel(), handle: null, chat: chatBinding };
      return trialControl.start(message);
    },
    attachChat(options) {
      const nav = navStore.get(), name = options?.name;
      if (entry.dead || !entry.api?.ok || nav.route?.panel !== "chat" || nav.route.instance !== name || typeof options.current !== "function") return null;
      const binding = { current: () => !entry.dead && host.document === doc && navStore.get().seq === nav.seq && navStore.get().route?.panel === "chat" && navStore.get().route?.instance === name && options.current() === true };
      chatBinding = binding; trialControl?.stop();
      if (entry.dead || chatBinding !== binding) return null;
      const handle = entry.api.attachChat({ ...options, current: () => chatBinding === binding && binding.current() });
      if (entry.dead || chatBinding !== binding) { safe(() => handle?.dispose()); return null; }
      if (!handle) chatBinding = null;
      return handle;
    },
    dispose() {
      if (entry.dead) return; entry.dead = true;
      safe(() => trialControl?.dispose()); safe(() => entry.api?.dispose()); safe(() => replyOff?.()); replyOff = null; replyStore = null;
      for (const off of releases.splice(0)) safe(off);
      updates.clear(); trialUpdates.clear(); const listeners = [...ended]; ended.clear(); for (const fn of listeners) safe(fn);
    },
  };
  owners.set(host, entry); // Reentrant setup never constructs another owner.
  let media, coarse;
  function ownerCssForPlayback() {
    if (doc.body.dataset.tier !== "guest") return ownerCssLifecycle.get().state;
    // Guests never install owner CSS. Prove its absence rather than borrowing the uninstalled
    // lifecycle's initial unknown, and refuse unexpected styles instead of trusting a missing id.
    try {
      if (doc.body.dataset.ownerCss || doc.querySelectorAll("#owner-css").length) return "unknown";
      // A CSP-refused or disabled STYLE has no paint. Recheck on every proof so enabling
      // it never borrows an earlier absence verdict (WebKit capture inserts a refused no-op).
      for (const style of doc.querySelectorAll("style")) if (style.sheet && style.sheet.disabled !== true) return "unknown";
      const allowed = new Set(["/assets/tokens.css", "/assets/app.css"]);
      for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
        const url = new URL(link.getAttribute("href"), host.location.origin);
        if (url.origin !== host.location.origin || !allowed.has(url.pathname) || url.search || url.hash) return "unknown";
      }
      return "off";
    } catch { return "unknown"; }
  }
  function guestChatVersion(value) {
    if (doc.body.dataset.tier !== "guest") return null;
    const name = navStore.get().route?.instance, v = value.instances?.find(i => i.name === name)?.effect_chat_v;
    return typeof v === "string" && /^[a-f0-9]{32}$/.test(v) ? v : null;
  }
  function context() {
    return { safe: safeMode(), publicLink: doc.body.dataset.publicLink === "1", reducedMotion: motionBlocked(host), saveData: host.navigator?.connection?.saveData === true,
      hidden: doc.visibilityState !== "visible", enabled: entry.api?.playbackAvailable !== false && typeof host.OffscreenCanvas === "function" && typeof host.Worker === "function" && typeof host.MutationObserver === "function" && typeof host.ResizeObserver === "function",
      show: themesShown(), transportReady: effectBootstrapReady(host, host.location?.origin, doc.body.dataset.effectBoot),
      constrained: constrainedDevice({ memory: host.navigator?.deviceMemory, cores: host.navigator?.hardwareConcurrency, coarse: coarse?.matches === true, width: host.innerWidth }),
      modal: !!doc.querySelector("dialog[open],.menu-list,.pop,[role=alertdialog],.oc-keep,.shell.sb-open"), openInstance: null };
  }
  function trialCurrent(name) {
    const intent = trialIntent, nav = navStore.get();
    return !entry.dead && host.document === doc && !!intent && !!intent.chat && chatBinding === intent.chat && intent.chat.current() === true && intent.name === name && nav.seq === intent.seq && nav.route?.panel === "chat" && nav.route.instance === name
      && (panelVersion() === intent.claim || intent.handle !== null && panelStore.get().open?.handle === intent.handle);
  }
  // One priority order feeds both presentation and redraw identity: false→different-false must redraw.
  function trialPlaybackStatus() {
    const c = context();
    if (c.safe) return "safe";
    if (!c.show) return "effectsOff";
    if (c.reducedMotion) return "reducedMotion";
    if (!c.enabled) return "unsupported";
    if (!c.transportReady) return "transport";
    if (c.publicLink) return "localAdmin";
    if (c.hidden || doc.hasFocus?.() !== true) return "inactive";
    if (c.modal) return "dialog";
    return "ready";
  }
  function trialAllowed() {
    const c = context();
    return !entry.dead && doc.visibilityState === "visible" && doc.hasFocus?.() === true
      && c.enabled && c.show && c.transportReady && !c.safe && !c.publicLink && !c.reducedMotion && !c.hidden && !c.modal;
  }
  function mountTrial(handle) {
    const intent = trialIntent; if (!intent || !trialCurrent(handle.instance) || !handle.current() || !Number.isSafeInteger(++trialSerial)) throw Error("trial_unavailable");
    intent.handle = handle;
    const binding = Object.freeze({ key: `trial:${trialSerial}:${handle.reply.trial}`, id: handle.reply.offer.id, run: handle.reply.trial, instance: handle.instance, generation: trialSerial });
    let stage = null, source = null;
    const cleanup = () => {
      safe(() => source?.stop()); safe(() => stage?.dispose());
      if (panelStore.get().open?.handle === handle) closePanel();
    };
    try {
      openTrialPanel({ key: binding.key, instance: handle.instance, binding, handle,
        onStage(value) {
          stage = value;
          if (!handle.current()) { cleanup(); handle.stop(); return; }
          source = entry.api.attachTrial({ reply: handle.reply, offer: handle.reply.offer.offer, startedAt: handle.startedAt, stage,
            current: handle.current, onStop: handle.stop });
          if (!source) { cleanup(); handle.stop(); }
        },
      });
    } catch (error) { cleanup(); throw error; }
    return cleanup;
  }
  function notifyTrial() {
    if (entry.dead) return;
    const nav = navStore.get(), next = JSON.stringify([trialHint, safe(() => chatBinding?.current()) === true, trialPlaybackStatus(), nav.route?.panel, nav.route?.instance, trialControl?.snapshot()]);
    if (next === trialStamp) return; trialStamp = next;
    for (const fn of [...trialUpdates]) safe(fn);
  }
  const notify = () => { if (!entry.dead) { trialControl?.sync(); notifyTrial(); for (const fn of [...updates]) safe(fn); } };
  const cursorDragging = () => doc.body.classList?.contains("side-resizing") === true || !!doc.querySelector(".chat-split.resizing");
  function syncCursor() {
    if (entry.dead || !cursor) return;
    const c = context();
    cursor.update(entry.api?.cursorSelection?.() ?? null, c.enabled && c.show && c.transportReady && !c.safe && !c.publicLink && !c.reducedMotion && !c.hidden && !c.modal && !cursorDragging());
  }
  try {
    if (appStore.get().connection === "ended") { entry.dispose(); return null; }
    media = host.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true };
    coarse = host.matchMedia?.("(pointer: coarse)") ?? { matches: false };
    entry.api = (factories.runtime ?? createAppEffectRuntime)({ window: host, current: () => !entry.dead && host.document === doc,
      observe: () => ({ context: context(), ownerCss: ownerCssForPlayback(), mode: resolvedMode() }), onDispose: () => entry.dispose(),
      resolveOwnerTarget: (slot, manifest, proof) => !entry.dead ? regions?.resolve?.(slot, manifest.box, proof) ?? null : null,
      onChange: () => { syncCursor(); notify(); } });
    if (entry.dead || !entry.api.ok) { entry.dispose(); return null; }
    if (ownerIdentity) trialControl = (factories.trialController ?? createEffectTrialController)({ window: host, current: trialCurrent, allowed: trialAllowed, onStart: mountTrial, onChange: notify });
    hold(() => trialControl?.dispose());
    if (ownerIdentity && typeof host.AgendAuth.trialSession === "function") Promise.resolve().then(() => host.AgendAuth.trialSession()).then(value => {
      if (entry.dead) return; trialHint = value?.localAdmin === true && value.epoch === chatEffectIdentity(host)?.epoch; notify();
    }).catch(() => { if (!entry.dead) { trialHint = false; notify(); } });
    hold(panelStore.subscribe(() => { trialControl?.sync(); notifyTrial(); }));
    const ownRegions = ownerIdentity && (factories.regions ?? createOwnerEffectRegions)({ window: host, current: () => !entry.dead && host.document === doc });
    regions = ownRegions?.ok ? ownRegions : null; hold(() => ownRegions?.dispose?.());
    if (entry.dead) return null;
    const ownCursor = ownerIdentity && safe(() => (factories.cursor ?? createEffectCursor)({ window: host, current: () => !entry.dead && host.document === doc,
      readImage: (selection, signal) => entry.api?.cursorImageSettled?.(selection, signal) ?? Promise.resolve(null),
      onChange(value) { const next = JSON.stringify(value); if (next !== cursorStamp) { cursorStamp = next; notify(); } },
    }));
    cursor = ownCursor?.ok ? ownCursor : null; hold(() => ownCursor?.dispose?.());
    if (entry.dead) return null;
    const sync = () => { if (!entry.dead) { trialControl?.sync(); entry.api.sync(); syncCursor(); notifyTrial(); } };
    let revision = appStore.get().themesRev, prefsRevision = appStore.get().prefsRev, guestRevision = guestChatVersion(appStore.get()), navSeq = navStore.get().seq;
    hold(navStore.subscribe(value => { if (entry.dead || value.seq === navSeq) return; navSeq = value.seq; trialControl?.stop(); chatBinding = null; entry.api.detachChat(); syncCursor(); }));
    hold(appStore.subscribe(value => {
      if (entry.dead) return;
      if (value.connection === "ended") { entry.dispose(); return; }
      const guestNext = guestChatVersion(value), chatChanged = value.themesRev !== revision || guestNext !== guestRevision, ownerChanged = value.prefsRev !== prefsRevision;
      revision = value.themesRev; prefsRevision = value.prefsRev; guestRevision = guestNext;
      if (chatChanged) entry.api.changedChat();
      if (ownerChanged) entry.api.changedOwner();
      if (!chatChanged && !ownerChanged) sync();
    }));
    hold(ownerCssLifecycle.subscribe(sync)); hold(themesStore.subscribe(sync)); hold(onPrefsChanged(sync)); hold(onMotionChange(sync));
    if (typeof host.AgendTheme?.onChange === "function") hold(host.AgendTheme.onChange(sync));
    for (const [target, type] of [[media, "change"], [coarse, "change"], [doc, "visibilitychange"], [host, "resize"], [host.navigator?.connection, "change"]]) {
      if (target?.addEventListener) { target.addEventListener(type, sync); hold(() => target.removeEventListener(type, sync)); }
    }
    if (entry.dead) return null;
    let modal = context().modal, dragging = cursorDragging(), queuedSurface = false;
    // Panel commits can happen after navigation and contain no Chat lease. Reproject fixed owner targets
    // once after stock DOM changes. Body-level effect roots/frames/rules do not schedule themselves.
    const surfaceChanged = () => {
      if (entry.dead || queuedSurface) return; queuedSurface = true;
      Promise.resolve().then(() => { queuedSurface = false; sync(); });
    };
    const barriers = typeof host.MutationObserver === "function" ? new host.MutationObserver(records => {
      if (entry.dead) return;
      const value = context().modal, drag = cursorDragging(); if (value !== modal || drag !== dragging) { modal = value; dragging = drag; sync(); }
      if (Array.isArray(records) && records.some(r => r.target?.closest?.("#app") || r.target === doc.getElementById?.("app"))) surfaceChanged();
    }) : null;
    hold(() => barriers?.disconnect());
    if (entry.dead) return null;
    barriers?.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "open", "hidden", "role"] });
    entry.bindStore(store); sync();
    return getAppEffects(host);
  } catch { entry.dispose(); return null; }
}
