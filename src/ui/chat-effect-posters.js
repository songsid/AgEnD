/** #1629: static Chat fallback. It requires no preview origin, device consent, Worker or personal identity. */
import { useLayoutEffect } from "/assets/app-html.js";
import { appStore } from "/assets/app-store.js";
import { onPrefsChanged, prefInForce } from "/assets/app-prefs.js";
import { themesShown, themesStore } from "/assets/app-themes.js";
import { ownerCssLifecycle } from "/assets/owner-css.js";
import { chatEffectIdentity } from "/assets/effect-chat-runtime.js";
import { createChatPosters } from "/assets/effect-posters.js";

export function ChatEffectPosters({ name, lease, element }) {
  useLayoutEffect(() => {
    let live = true, api = null;
    const releases = [], host = window;
    const current = () => live && lease.current();
    const cleanup = () => { if (!live) return; live = false; try { api?.dispose?.(); } catch { /* optional */ } for (const off of releases) { try { off?.(); } catch { /* release all */ } } };
    lease.hold(cleanup);
    try {
      const preview = host.AgendPreview, motion = host.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true };
      const observe = () => {
        let previewReady = false; try { previewReady = preview?.availability().ok === true; } catch { /* fallback */ }
        // This is a surface fallback, not a replacement for an explicit Pause, queued effect or failed live read.
        const playback = chatEffectIdentity(host) && typeof host.Worker === "function" && typeof host.OffscreenCanvas === "function" && previewReady &&
          prefInForce("preview.optIn")?.value === true && preview?.optedIn() === true && preview?.never() !== true && !motion.matches && host.navigator?.connection?.saveData !== true;
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
      if (typeof preview?.onChange === "function") releases.push(preview.onChange(sync));
      for (const target of [motion, host.navigator?.connection]) if (target?.addEventListener) { target.addEventListener("change", sync); releases.push(() => target.removeEventListener("change", sync)); }
      sync(); return cleanup;
    } catch { cleanup(); return cleanup; }
  }, [name, lease]);
  return null;
}
