/** #1629: static Chat fallback. It requires no preview origin, device consent, Worker or personal identity. */
import { useLayoutEffect } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { onPrefsChanged } from "/assets/app-prefs.js";
import { themesShown, themesStore } from "/assets/app-themes.js";
import { ownerCssLifecycle } from "/assets/owner-css.js";
import { effectPlaybackIdentity } from "/assets/effect-chat-runtime.js";
import { effectBootstrapReady } from "/assets/effect-frame.js";
import { createChatPosters } from "/assets/effect-posters.js";

export function ChatEffectPosters({ name, lease, element }) {
  useLayoutEffect(() => {
    let live = true, api = null;
    const releases = [], host = window;
    const current = () => live && lease.current();
    const cleanup = () => { if (!live) return; live = false; try { api?.dispose?.(); } catch { /* optional */ } for (const off of releases) { try { off?.(); } catch { /* release all */ } } };
    lease.hold(cleanup);
    try {
      const motion = host.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true };
      const observe = () => {
        // This is a surface fallback, not a replacement for an explicit Pause, queued effect or failed live read.
        const playback = effectPlaybackIdentity(host) && typeof host.Worker === "function" && typeof host.OffscreenCanvas === "function" &&
          effectBootstrapReady(host, host.location?.origin, host.document.body.dataset.effectBoot) && !motion.matches && host.navigator?.connection?.saveData !== true;
        return { shown: themesShown(), fallback: !playback, ownerCss: ownerCssLifecycle.get().state };
      };
      api = createChatPosters({ window: host, name, element: element.current, current, observe });
      if (!api.ok) return cleanup;
      const sync = () => { if (current()) api.sync(); };
      let revision = appStore.get().themesRev;
      releases.push(appStore.subscribe(s => {
        if (!current()) return;
        if (s.connection === "ended") { api.dispose(); return; }
        if (s.themesRev !== revision) { revision = s.themesRev; api.changed(); } else sync();
      }));
      releases.push(ownerCssLifecycle.subscribe(sync)); releases.push(themesStore.subscribe(sync)); releases.push(onPrefsChanged(sync));
      for (const target of [motion, host.navigator?.connection]) if (target?.addEventListener) { target.addEventListener("change", sync); releases.push(() => target.removeEventListener("change", sync)); }
      sync(); return cleanup;
    } catch { cleanup(); return cleanup; }
  }, [name, lease]);
  return null;
}
