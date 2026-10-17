/** #1629: fixed host producer. Creates no frame or request; the admitted app controller owns its lease. */
import { html, useLayoutEffect, useRef } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createEffectTrialShadow } from "/assets/effect-trial-shadow.js";
import { createEffectTrialStage } from "/assets/effect-trial-stage.js";
register("effectTrial", {
  en: { label: "Trial", stop: "Stop trial", close: "Close", note: "A bounded sample. Nothing is applied or saved." },
  "zh-TW": { label: "試播", stop: "停止試播", close: "關閉", note: "僅在此區塊試播，不會套用或儲存。" },
});
/** The caller owns authenticated admission, lease/deadline and shared pool. No script/HTML is rendered here. */
export function EffectTrialPanel({ window: host = globalThis.window, binding, title, current, onStage, onStop, onClose }) {
  const panel = useRef(null), life = useRef(null), latest = useRef(null);
  latest.current = { current, onStage, onStop, onClose };
  const stop = close => {
    const entry = life.current; if (!entry || (close ? entry.closed : entry.dead)) return;
    if (close) entry.closed = true;
    if (!entry.dead) { entry.dead = true; entry.api?.dispose(); }
    try { (close ? entry.onClose : entry.onStop)?.("stopped"); } catch { /* lease already ended */ }
  };
  useLayoutEffect(() => {
    const entry = { dead: false, closed: false, api: null, shadow: null, onStop, onClose }; life.current = entry;
    const ended = reason => { if (entry.dead) return; entry.dead = true; try { entry.onStop?.(reason); } catch { /* never revive */ } };
    try {
      entry.shadow = createEffectTrialShadow({ window: host, panel: panel.current, title,
        labels: { label: t("effectTrial.label"), close: t("effectTrial.close"), stop: t("effectTrial.stop"), note: t("effectTrial.note") },
        onStop: () => stop(false), onClose: () => stop(true), onError: ended,
        onReady(shell) {
          if (entry.dead || life.current !== entry) return;
          entry.api = createEffectTrialStage({ window: host, panel: panel.current, stage: shell.stage, binding,
            current: own => !entry.dead && life.current === entry && latest.current.current?.(own) === true, onStop: ended });
          if (!entry.api) ended("stage_unavailable");
          else { try { latest.current.onStage?.(entry.api); } catch { entry.api.dispose(); ended("stage_unavailable"); } }
        } });
      if (!entry.shadow) ended("stage_unavailable");
    } catch { entry.api?.dispose(); ended("stage_unavailable"); }
    return () => { entry.api?.dispose(); ended("stopped"); entry.shadow?.dispose(); entry.dead = true; if (life.current === entry) life.current = null; };
  }, [host, binding]);
  useLayoutEffect(() => { life.current?.shadow?.text(title, { label: t("effectTrial.label"), close: t("effectTrial.close"), stop: t("effectTrial.stop"), note: t("effectTrial.note") }); });
  return html`<aside ref=${panel} data-trust="preview" class="pv-panel effect-trial-panel" aria-label=${t("effectTrial.label")}></aside>`;
}
