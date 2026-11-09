// M-2731: feature-owned words/styles travel with lazy panels, including tabs with an older shell/catalog module.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { ErrorState } from "/assets/ui-states.js";
register("modelPicker", {
  en: { refresh: "Refresh models", refreshing: "Refreshing models…", refreshed: "Model list refreshed.", failed: "Could not refresh models. The previous list and selection are kept.", more: "More models…", backend: "Choose backend", model: "Choose model", next: "Choose a backend; next choose its model and reasoning effort.", current: "Selected", keep: "Refreshing keeps the selected model.", selectionHint: "Refresh keeps your selection; choose a model to apply it." },
  "zh-TW": { refresh: "重新整理模型", refreshing: "正在重新整理模型…", refreshed: "模型清單已更新。", failed: "無法重新整理模型。已保留原清單與選擇。", more: "更多模型…", backend: "選擇後端", model: "選擇模型", next: "選擇後端；下一步選模型與推理強度", current: "已選擇", keep: "重新整理會保留已選模型。", selectionHint: "重新整理只更新清單；選擇模型才會套用。" },
});
export const mw = key => t(`modelPicker.${key}`);
export function modelPickerStyles() {
  if (typeof document === "undefined" || !document.head || document.querySelector('link[href="/assets/model-picker.css"]')) return;
  const link = document.createElement("link"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/model-picker.css"); document.head.appendChild(link);
}
const answers = new Map(), TTL = 30_000;
export function forgetModelPickerCatalogs() { answers.clear(); }
/** Selection remains owned by the form; rediscovery never calls its onChange or stages a change. */
export function useRefreshableModels(backend, instance) {
  const key = JSON.stringify([backend, instance || null]);
  const [state, set] = useState({ key, models: [], phase: "loading" });
  const generation = useRef(0);
  const current = useRef(key), flight = useRef(null), mounted = useRef(true);
  current.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true; const gen = ++generation.current;
    const url = `/ui/models?backend=${encodeURIComponent(backend || "")}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}`;
    const hit = answers.get(key), fresh = hit && performance.now() - hit.at < TTL;
    const promise = fresh ? hit.promise : fetch(url, { credentials: "same-origin" }).then(async r => { if (!r.ok) throw Error(); const data = await r.json(); return Array.isArray(data.models) ? data.models : []; });
    if (!fresh) { answers.set(key, { at: performance.now(), promise }); if (answers.size > 64) answers.delete(answers.keys().next().value); }
    set({ key, models: [], phase: "loading" }); flight.current = null;
    promise.then(models => { if (live && gen === generation.current) set({ key, models, phase: "idle" }); }, () => { answers.delete(key); if (live && gen === generation.current) set({ key, models: [], phase: "error" }); });
    return () => { live = false; };
  }, [key]);
  const shown = state.key === key ? state : { key, models: [], phase: "loading" };
  async function refresh() {
    if (flight.current || !backend) return;
    const token = {}; flight.current = token; generation.current++;
    set({ ...shown, phase: "busy" });
    try {
      const r = await fetch("/ui/models/refresh", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backend, ...(instance ? { instance } : {}) }) });
      const data = await r.json();
      if (!r.ok || data.refreshed !== true || !Array.isArray(data.models)) throw Error();
      if (!mounted.current || current.current !== key || flight.current !== token) return;
      answers.set(key, { at: performance.now(), promise: Promise.resolve(data.models) });
      set({ key, models: data.models, phase: "done" });
    } catch { if (mounted.current && current.current === key && flight.current === token) set({ ...shown, phase: "error" }); }
    finally { if (flight.current === token) flight.current = null; }
  }
  return { ...shown, refresh };
}
export function ModelRefresh({ state, disabled }) {
  modelPickerStyles();
  return html`<div class="model-refresh"><button type="button" class="btn" disabled=${disabled || state.phase === "busy"} onClick=${state.refresh}>
    <${Icon} name="restart" size=${16} />${mw(state.phase === "busy" ? "refreshing" : "refresh")}</button>
    <p class="note">${mw("keep")}</p>
    ${state.phase === "error" ? html`<${ErrorState} message=${mw("failed")} onRetry=${disabled ? undefined : state.refresh} />`
      : state.phase === "done" ? html`<p class="note" role="status">${mw("refreshed")}</p>` : null}</div>`;
}
export const modelLabel = value => ({ sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" }[value] || value);
