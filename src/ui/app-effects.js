/** #1629: one session-only app effect owner. Importing this module starts nothing. */
import { appStore } from "/assets/app-store.js";
import { navStore } from "/assets/app-nav.js";
import { onPrefsChanged, prefInForce } from "/assets/app-prefs.js";
import { resolvedMode, themesStore } from "/assets/app-themes.js";
import { ownerCssLifecycle, safeMode } from "/assets/owner-css.js";
import { constrainedDevice } from "/assets/effect-policy.js";
import { createAppEffectRuntime } from "/assets/effect-app-runtime.js";
import { createEffectCursor } from "/assets/effect-cursor.js";
import { createOwnerEffectRegions } from "/assets/effect-owner-regions.js";
import { chatEffectIdentity } from "/assets/effect-chat-runtime.js";
const owners = new WeakMap();
export function getAppEffects(host = window) { const value = owners.get(host); return value && !value.dead && value.api?.ok ? value : null; }

/** Boot once with the page's Chat store, including when the first visible panel is Fleet. */
export function startAppEffects({ store, window: host = window, factories = {} } = {}) {
  const existing = owners.get(host);
  if (existing) { if (!existing.dead) existing.bindStore(store); return getAppEffects(host); }
  if (!chatEffectIdentity(host) || typeof host.AgendAuth?.onSessionEnd !== "function" || typeof host.AgendAuth?.sessionEnded !== "function") return null;
  const doc = host.document, releases = [], ended = new Set(), updates = new Set(); let replyOff = null, replyStore = null, regions = null, cursor = null, cursorStamp = null;
  const safe = fn => { try { return fn(); } catch { return null; } };
  const hold = off => { if (entry.dead) safe(() => off?.()); else releases.push(off); };
  const entry = { dead: false, api: null,
    cursorSnapshot: () => cursor?.snapshot() ?? { status: "unavailable", id: null },
    gates: () => context(),
    subscribe(fn) { if (typeof fn !== "function" || entry.dead) return () => {}; updates.add(fn); return () => updates.delete(fn); },
    onEnd(fn) { if (typeof fn !== "function") return () => {}; if (entry.dead) { safe(fn); return () => {}; } ended.add(fn); return () => ended.delete(fn); },
    bindStore(value) {
      if (entry.dead || value === replyStore) return;
      safe(() => replyOff?.()); replyOff = null; replyStore = value;
      entry.api?.detachChat();
      if (typeof value?.onAgentReply === "function") {
        const off = value.onAgentReply(event => { if (!entry.dead && replyStore === value) entry.api?.reply(event); });
        if (entry.dead || replyStore !== value) safe(() => off?.()); else replyOff = off;
      }
    },
    attachChat(options) {
      const nav = navStore.get(), name = options?.name;
      if (entry.dead || !entry.api?.ok || nav.route?.panel !== "chat" || nav.route.instance !== name || typeof options.current !== "function") return null;
      return entry.api.attachChat({ ...options, current: () => !entry.dead && host.document === doc && navStore.get().seq === nav.seq && navStore.get().route?.panel === "chat" && navStore.get().route?.instance === name && options.current() === true });
    },
    dispose() {
      if (entry.dead) return; entry.dead = true;
      safe(() => entry.api?.dispose()); safe(() => replyOff?.()); replyOff = null; replyStore = null;
      for (const off of releases.splice(0)) safe(off);
      updates.clear(); const listeners = [...ended]; ended.clear(); for (const fn of listeners) safe(fn);
    },
  };
  owners.set(host, entry); // Reentrant setup never constructs another owner.
  let media, coarse, preview;
  function context() {
    let ready = false; try { ready = preview?.availability().ok === true; } catch { /* unavailable */ }
    return { safe: safeMode(), publicLink: doc.body.dataset.publicLink === "1", reducedMotion: media?.matches !== false, saveData: host.navigator?.connection?.saveData === true,
      hidden: doc.visibilityState !== "visible", enabled: typeof host.OffscreenCanvas === "function" && typeof host.Worker === "function" && typeof host.MutationObserver === "function" && typeof host.ResizeObserver === "function",
      show: prefInForce("fx.show")?.value !== false, previewReady: ready,
      optIn: prefInForce("preview.optIn")?.value === true && preview?.optedIn() === true && preview?.never() !== true,
      constrained: constrainedDevice({ memory: host.navigator?.deviceMemory, cores: host.navigator?.hardwareConcurrency, coarse: coarse?.matches === true, width: host.innerWidth }),
      modal: !!doc.querySelector("dialog[open],.menu-list,.pop,[role=alertdialog],.oc-keep,.shell.sb-open"), openInstance: null };
  }
  const notify = () => { if (!entry.dead) for (const fn of [...updates]) safe(fn); };
  const cursorDragging = () => doc.body.classList?.contains("side-resizing") === true || !!doc.querySelector(".chat-split.resizing");
  function syncCursor() {
    if (entry.dead || !cursor) return;
    const c = context();
    cursor.update(entry.api?.cursorSelection?.() ?? null, c.enabled && c.show && c.previewReady && c.optIn && !c.safe && !c.publicLink && !c.reducedMotion && !c.saveData && !c.hidden && !c.modal && !cursorDragging());
  }
  try {
    if (appStore.get().connection === "ended") { entry.dispose(); return null; }
    preview = host.AgendPreview;
    media = host.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true };
    coarse = host.matchMedia?.("(pointer: coarse)") ?? { matches: false };
    entry.api = (factories.runtime ?? createAppEffectRuntime)({ window: host, current: () => !entry.dead && host.document === doc,
      observe: () => ({ context: context(), ownerCss: ownerCssLifecycle.get().state, mode: resolvedMode() }), onDispose: () => entry.dispose(),
      resolveOwnerTarget: (slot, manifest, proof) => !entry.dead ? regions?.resolve?.(slot, manifest.box, proof) ?? null : null,
      onChange: () => { syncCursor(); notify(); } });
    if (entry.dead || !entry.api.ok) { entry.dispose(); return null; }
    const ownRegions = (factories.regions ?? createOwnerEffectRegions)({ window: host, current: () => !entry.dead && host.document === doc });
    regions = ownRegions?.ok ? ownRegions : null; hold(() => ownRegions?.dispose?.());
    if (entry.dead) return null;
    const ownCursor = safe(() => (factories.cursor ?? createEffectCursor)({ window: host, current: () => !entry.dead && host.document === doc,
      readImage: (selection, signal) => entry.api?.cursorImageSettled?.(selection, signal) ?? Promise.resolve(null),
      onChange(value) { const next = JSON.stringify(value); if (next !== cursorStamp) { cursorStamp = next; notify(); } },
    }));
    cursor = ownCursor?.ok ? ownCursor : null; hold(() => ownCursor?.dispose?.());
    if (entry.dead) return null;
    const sync = () => { if (!entry.dead) { entry.api.sync(); syncCursor(); } };
    let revision = appStore.get().themesRev, prefsRevision = appStore.get().prefsRev, navSeq = navStore.get().seq;
    hold(navStore.subscribe(value => { if (entry.dead || value.seq === navSeq) return; navSeq = value.seq; entry.api.detachChat(); syncCursor(); }));
    hold(appStore.subscribe(value => {
      if (entry.dead) return;
      if (value.connection === "ended") { entry.dispose(); return; }
      const chatChanged = value.themesRev !== revision, ownerChanged = value.prefsRev !== prefsRevision;
      revision = value.themesRev; prefsRevision = value.prefsRev;
      if (chatChanged) entry.api.changedChat();
      if (ownerChanged) entry.api.changedOwner();
      if (!chatChanged && !ownerChanged) sync();
    }));
    hold(ownerCssLifecycle.subscribe(sync)); hold(themesStore.subscribe(sync)); hold(onPrefsChanged(sync));
    if (typeof preview?.onChange === "function") hold(preview.onChange(sync));
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
