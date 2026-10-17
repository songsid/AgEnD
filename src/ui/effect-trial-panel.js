/** #1629: fixed host producer. Creates no frame or request; the admitted app controller owns its lease. */
import { html, useLayoutEffect, useRef } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createEffectTrialStage } from "/assets/effect-trial-stage.js";
register("effectTrial", {
  en: { label: "Trial", stop: "Stop trial", close: "Close", note: "A bounded sample. Nothing is applied or saved." },
  "zh-TW": { label: "試播", stop: "停止試播", close: "關閉", note: "僅在此區塊試播，不會套用或儲存。" },
});
/** The caller owns authenticated admission, lease/deadline and shared pool. No script/HTML is rendered here. */
export function EffectTrialPanel({ window: host = globalThis.window, binding, title, current, ownerCss, onStage, onStop, onClose }) {
  const panel = useRef(null), stage = useRef(null), life = useRef(null), latest = useRef(null);
  latest.current = { current, ownerCss, onStage, onStop, onClose };
  const stop = close => {
    const entry = life.current; if (!entry || (close ? entry.closed : entry.dead)) return;
    if (close) entry.closed = true;
    if (!entry.dead) { entry.dead = true; entry.api?.dispose(); }
    try { (close ? entry.onClose : entry.onStop)?.("stopped"); } catch { /* lease already ended */ }
  };
  useLayoutEffect(() => {
    const entry = { dead: false, closed: false, api: null, onStop, onClose }; life.current = entry;
    const ended = reason => { if (entry.dead) return; entry.dead = true; try { entry.onStop?.(reason); } catch { /* never revive */ } };
    try {
      entry.api = createEffectTrialStage({ window: host, panel: panel.current, stage: stage.current, binding,
        current: own => !entry.dead && life.current === entry && latest.current.current?.(own) === true,
        ownerCss: () => latest.current.ownerCss?.(), onStop: ended });
      if (!entry.api) ended("stage_unavailable");
      else { latest.current.onStage?.(entry.api); }
    } catch { entry.api?.dispose(); ended("stage_unavailable"); }
    return () => { entry.api?.dispose(); entry.dead = true; if (life.current === entry) life.current = null; };
  }, [host, binding]);
  return html`<aside ref=${panel} data-trust="preview" class="pv-panel effect-trial-panel" aria-label=${t("effectTrial.label")}>
    <header class="effect-trial-head"><strong>${t("effectTrial.label")}</strong><span>${typeof title === "string" ? title : ""}</span><button type="button" class="btn" onClick=${() => stop(true)}>${t("effectTrial.close")}</button></header>
    <div class="effect-trial-controls"><button type="button" class="btn" onClick=${() => stop(false)}>${t("effectTrial.stop")}</button></div>
    <div class="effect-trial-body"><div ref=${stage} class="effect-trial-stage" aria-hidden="true"></div></div>
    <p class="effect-trial-note">${t("effectTrial.note")}</p>
  </aside>`;
}
