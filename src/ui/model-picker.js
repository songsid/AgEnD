// M-2731: feature-owned words/styles travel with lazy panels, including tabs with an older shell/catalog module.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { ErrorState } from "/assets/ui-states.js";
import * as catalogStore from "./settings-catalog.js";
register("modelPicker", {
  en: { refresh: "Refresh models", refreshing: "Refreshing models…", refreshed: "Model list refreshed.", failed: "Could not refresh models. The previous list and selection are kept.", more: "More models…", backend: "Choose backend", model: "Choose model", next: "Choose a backend; next choose its model and reasoning effort.", current: "Selected", nativeFailed: "Could not refresh models on this computer. Update its Runtime if needed and check that its owner allows account access. The previous list and selection are kept.", keep: "Refreshing keeps the selected model.", selectionHint: "Refresh keeps your selection; choose a model to apply it.", accountSource: "Source: selected account’s model listing.", effort: "Choose reasoning effort", effortFor: "Choose the effort for {0}", effortAuto: "Auto" },
  "zh-TW": { refresh: "重新整理模型", refreshing: "正在重新整理模型…", refreshed: "模型清單已更新。", failed: "無法重新整理模型。已保留原清單與選擇。", more: "更多模型…", backend: "選擇後端", model: "選擇模型", next: "選擇後端；下一步選模型與推理強度", current: "已選擇", nativeFailed: "無法在這台電腦重新整理模型。請確認 Runtime 已更新，且電腦擁有者允許存取帳號；已保留原清單與選擇。", keep: "重新整理會保留已選模型。", selectionHint: "重新整理只更新清單；選擇模型才會套用。", accountSource: "來源：已選帳號的模型清單。", effort: "選擇推理強度", effortFor: "選擇 {0} 的推理強度", effortAuto: "自動" },
});
export const mw = (key, ...args) => t(`modelPicker.${key}`, ...args);
export function modelPickerStyles() {
  if (typeof document === "undefined" || !document.head || document.querySelector('link[href="/assets/model-picker.css"]')) return;
  const link = document.createElement("link"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/model-picker.css"); document.head.appendChild(link);
}
const answers = new Map(); // share only in-flight passive reads; the server owns catalog freshness
export function forgetModelPickerCatalogs() { answers.clear(); catalogStore.forgetCatalogs?.(); }
/** Selection remains owned by the form; rediscovery never calls its onChange or stages a change. */
export function useRefreshableModels(backend, instance, context = {}) {
  const { runtime, machineId, profile } = context;
  const target = { backend, ...(instance ? {instance} : {}), ...(runtime === "windows" ? {runtime} : {}), ...(machineId ? {machineId} : {}), ...(profile !== undefined ? {profile} : {}) };
  const key = JSON.stringify(target);
  const [state, set] = useState({ key, models: [], phase: "loading" });
  const generation = useRef(0);
  const current = useRef(key), flight = useRef(null), mounted = useRef(true);
  current.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true; const gen = ++generation.current;
    const url = `/ui/models?${new URLSearchParams(target)}`;
    if (!backend) { set({ key, models: [], phase: "idle" }); return () => { live = false; }; }
    const hit = answers.get(key), fresh = !!hit;
    const promise = fresh ? hit.promise : typeof catalogStore.readModelCatalogSnapshot === "function" ? catalogStore.readModelCatalogSnapshot(target)
      : typeof catalogStore.readModelCatalog === "function" ? catalogStore.readModelCatalog(target).then(models => ({ models }))
      : fetch(url, { credentials: "same-origin" }).then(async r => { if (!r.ok) throw Error(); const data = await r.json(); if (!Array.isArray(data.models)) throw Error(); return data; });
    if (!fresh) { answers.set(key, { promise }); if (answers.size > 64) answers.delete(answers.keys().next().value); }
    set({ key, models: [], phase: "loading" }); flight.current = null;
    promise.finally(() => { if (answers.get(key)?.promise === promise) answers.delete(key); }).catch(() => {});
    promise.then(data => { if (live && gen === generation.current) set({ key, models: data.models, source: data.source, phase: "idle" }); }, () => { if (answers.get(key)?.promise === promise) answers.delete(key); if (live && gen === generation.current) set({ key, models: [], phase: "load_error" }); });
    return () => { live = false; };
  }, [key]);
  const shown = state.key === key ? state : { key, models: [], phase: "loading" };
  async function refresh() {
    if (flight.current || !backend) return;
    const token = {}; flight.current = token; generation.current++;
    set({ ...shown, phase: "busy" });
    try {
      const r = await fetch("/ui/models/refresh", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
      const data = await r.json();
      if (!r.ok || data.refreshed !== true || !Array.isArray(data.models)) throw Error();
      if (!mounted.current || current.current !== key || flight.current !== token) return;
      answers.delete(key); // Retire the earlier passive flight before a remount can borrow it.
      catalogStore.rememberModelCatalog?.(target, data);
      set({ key, models: data.models, source: data.source, phase: "done" });
    } catch { if (mounted.current && current.current === key && flight.current === token) set({ ...shown, phase: "error" }); }
    finally { if (flight.current === token) flight.current = null; }
  }
  return { ...shown, loading: shown.phase === "loading", refresh, native: runtime === "windows" };
}
export function ModelRefresh({ state, disabled, initialFailure }) {
  modelPickerStyles();
  return html`<div class="model-refresh model-catalog-status"><button type="button" class="btn" disabled=${disabled || state.phase === "busy"} onClick=${state.refresh}>
    <${Icon} name="restart" size=${16} />${mw(state.phase === "busy" ? "refreshing" : "refresh")}</button>
    <p class="note">${mw("keep")}</p>
    ${(state.phase === "error" || state.phase === "load_error") ? html`<${ErrorState} message=${state.phase === "load_error" && initialFailure || mw(state.native ? "nativeFailed" : "failed")} onRetry=${disabled ? undefined : state.refresh} />`
      : state.phase === "done" ? html`<p class="note" role="status">${mw("refreshed")}</p>` : null}</div>`;
}
export const modelLabel = value => ({ sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" }[value] || value);
