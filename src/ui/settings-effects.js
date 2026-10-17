// #1629 B2: library management only. This module never loads Worker code or creates a preview/frame.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { OwnerEffects } from "./settings-owner-effects.js";
import { CardTitle } from "./settings-learn.js";

register("effectSettings", {
  en: {
    title: "Effects", lead: "Your effect files, and which one a chat uses.", folder: "Upload an effect folder", files: "effect.json + worker.js (and pictures), up to 1 MiB.",
    inUse: "This effect is still in use and cannot be deleted.", quota: "Your library reached its 10-effect or 8 MiB limit. Delete unused copies first.", rateLimited: "Too many changes. Wait a moment, then try again.",
    loading: "Loading effects…", retry: "Reload library", empty: "No effects in your library.", failed: "Couldn't load the library. Try again.", actionFailed: "Couldn't save this change. Try again.", savedRefresh: "Saved. Reload the library to see the result.",
    uploadFailed: "Couldn't upload this folder. Check its files and size, then try again.", public: "Effect management isn't available on a temporary public link.", readOnly: "Read-only session: sign in as an admin to change effects.",
    yours: "Your copy", shared: "Shared with you", share: "Share your copy with agents and people on this fleet", delete: "Delete your copy", deleteConfirm: "Delete your unused copy of this effect? Other people's copies are kept.",
    chat: "Chat", chooseChat: "Choose a chat", apply: "Save for this chat", remove: "Remove from this chat", saved: "Saved.", history: "Profile history", unmeasured: "Not measured yet", unavailable: "Profile unavailable", reported: "Reported host observations; they don't prove an effect's cost.",
    fps: "Host FPS p50 / p10", tasks: "Host long task p95", noTasks: "Not observed", standard: "Standard device", constrained: "Constrained device", params: "Parameters", badParams: "Check the parameter values.", more: "Show more", count: "{0} effects", one: "1 effect", profileFailed: "Couldn't read profile history. Try again.",
  },
  "zh-TW": {
    title: "效果", lead: "你的效果檔案，以及每個聊天使用哪一個。", folder: "上傳效果資料夾", files: "effect.json + worker.js（可加圖片），最多 1 MiB。",
    inUse: "這個效果仍在使用中，無法刪除。", quota: "你的程式庫已達 10 個效果或 8 MiB 上限，請先刪除未使用的副本。", rateLimited: "變更太頻繁，請稍候再試。",
    loading: "正在載入效果…", retry: "重新載入程式庫", empty: "程式庫中還沒有效果。", failed: "無法載入程式庫，請重試。", actionFailed: "無法儲存變更，請重試。", savedRefresh: "已儲存，請重新載入程式庫查看結果。",
    uploadFailed: "無法上傳這個資料夾，請檢查檔案與大小後重試。", public: "臨時公開連結不提供效果管理。", readOnly: "目前為唯讀登入，請以管理員身分登入才能修改效果。",
    yours: "你持有的副本", shared: "他人與你共享", share: "將你的副本共享給這個 fleet 的 agent 與使用者", delete: "刪除你的副本", deleteConfirm: "刪除你未使用的效果副本？其他人的副本會保留。",
    chat: "聊天", chooseChat: "選擇聊天", apply: "儲存到這個聊天", remove: "從這個聊天移除", saved: "已儲存。", history: "效能回報紀錄", unmeasured: "尚未測量", unavailable: "無法取得效能回報", reported: "這是主機觀測回報，不能證明效果本身的資源用量。",
    fps: "主機 FPS p50／p10", tasks: "主機長任務 p95", noTasks: "未觀測到", standard: "一般裝置", constrained: "受限裝置", params: "參數", badParams: "請檢查參數值。", more: "顯示更多", count: "{0} 個效果", one: "1 個效果", profileFailed: "無法讀取效能回報紀錄，請重試。",
  },
});
const tn = (key, ...args) => t(`effectSettings.${key}`, ...args);
const REFUSALS = Object.freeze({ effect_in_use: "inUse", effect_quota: "quota", rate_limited: "rateLimited" });
const refusal = (body, fallback) => tn(typeof body?.error === "string" && Object.hasOwn(REFUSALS, body.error) ? REFUSALS[body.error] : fallback);
const ID = /^[0-9a-f]{32}$/;
const PATH = /^(?:effect\.json|worker\.js|poster\.png|cursor\.png|assets\/[a-z0-9][a-z0-9_-]{0,63}\.(?:png|jpe?g|webp|gif))$/;
const RAW_MAX = 8 * 1024 * 1024, WIRE_MAX = 12 * 1024 * 1024;
const plain = (v) => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const publicLink = () => typeof document !== "undefined" && document.body?.dataset.publicLink === "1";

/** File metadata bounds are checked before reading. No directory path reaches the server. */
export async function encodeEffectFolder(input, signal) {
  const files = Array.from(input || []);
  if (files.length < 2 || files.length > 20) throw Error("effect_files");
  const nested = files.some(f => !!f?.webkitRelativePath), paths = new Set(); let root = null, raw = 0, assets = 0;
  const rows = files.map(file => {
    if (!file || typeof file.name !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || (raw += file.size) > RAW_MAX || typeof file.arrayBuffer !== "function") throw Error("effect_files");
    let path = file.name;
    if (nested) {
      const relative = file.webkitRelativePath;
      if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\")) throw Error("effect_files");
      const at = relative.indexOf("/"); if (at < 1) throw Error("effect_files");
      const prefix = relative.slice(0, at); if (root === null) root = prefix; if (root !== prefix) throw Error("effect_files");
      path = relative.slice(at + 1);
    }
    if (!PATH.test(path) || paths.has(path) || (path.startsWith("assets/") && ++assets > 16)) throw Error("effect_files");
    paths.add(path); return { file, path };
  });
  if (!paths.has("effect.json") || !paths.has("worker.js")) throw Error("effect_files");
  const encoded = [];
  for (const { file, path } of rows) {
    if (signal?.aborted) throw Error("cancelled");
    const buffer = await file.arrayBuffer(); if (signal?.aborted) throw Error("cancelled");
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size) throw Error("effect_files");
    const bytes = new Uint8Array(buffer), chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    encoded.push({ path, data_b64: btoa(chunks.join("")) });
  }
  const body = JSON.stringify(encoded); if (new TextEncoder().encode(body).byteLength > WIRE_MAX) throw Error("effect_files");
  return body;
}
export function effectCatalog(body) {
  if (!plain(body) || typeof body.canWrite !== "boolean" || !Array.isArray(body.effects)) return null;
  const seen = new Set(), effects = [];
  for (const e of body.effects) {
    if (!plain(e) || typeof e.id !== "string" || !ID.test(e.id) || seen.has(e.id) || !plain(e.manifest) || typeof e.manifest.title !== "string" || e.manifest.title.length < 1 || e.manifest.title.length > 40 || !Number.isInteger(e.bytes) || e.bytes < 1 || e.bytes > 1048576 || typeof e.ownClaim !== "boolean" || typeof e.sharedByYou !== "boolean" || !e.ownClaim && e.sharedByYou) return null;
    if (effectParamOverrides(e.manifest) === null) return null;
    seen.add(e.id); effects.push(e);
  }
  return { canWrite: body.canWrite, effects };
}
/** UI draft conversion only; the host independently checks the manifest and every override on apply. */
export function effectParamOverrides(manifest, draft = {}) {
  if (!plain(manifest) || !plain(draft) || manifest.params !== undefined && !plain(manifest.params)) return null;
  const defs = manifest.params || {}, out = Object.create(null);
  if (Object.keys(defs).length > 16 || Object.keys(draft).some(k => !Object.hasOwn(defs, k))) return null;
  for (const [key, d] of Object.entries(defs)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || !plain(d)) return null;
    const supplied = Object.hasOwn(draft, key); let v = supplied ? draft[key] : d.default;
    if (d.type === "int" || d.type === "number") {
      if (supplied && typeof v === "string" && v.trim() !== "") v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isFinite(d.min) || !Number.isFinite(d.max) || v < d.min || v > d.max || d.type === "int" && !Number.isSafeInteger(v)) return null;
      if (d.type === "number" && d.step !== undefined) {
        const n = (v - d.min) / d.step;
        if (!(d.step > 0) || !Number.isFinite(n) || Math.abs(n - Math.round(n)) > 1e-8) return null;
      }
    } else if (d.type === "bool") { if (typeof v !== "boolean") return null; }
    else if (d.type === "enum") { if (!Array.isArray(d.values) || d.values.length > 16 || typeof v !== "string" || !d.values.includes(v)) return null; }
    else if (d.type === "color") { if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) return null; v = v.toLowerCase(); }
    else return null;
    if (v !== d.default) out[key] = v;
  }
  return out;
}
function Params({ manifest, draft, update, disabled }) {
  const defs = plain(manifest.params) ? Object.entries(manifest.params).slice(0, 16) : [];
  if (!defs.length) return null;
  return html`<fieldset class="s-fx-params" disabled=${disabled}><legend>${tn("params")}</legend>${defs.map(([key, d]) => {
    const value = Object.hasOwn(draft, key) ? draft[key] : d.default;
    if (d.type === "bool") return html`<label key=${key} class="check"><input data-param=${key} type="checkbox" checked=${value} onChange=${e => update(key, e.target.checked)} />${key}</label>`;
    if (d.type === "enum") return html`<label key=${key}>${key}<select data-param=${key} value=${value} onChange=${e => update(key, e.target.value)}>${d.values.map(v => html`<option key=${v} value=${v}>${v}</option>`)}</select></label>`;
    return html`<label key=${key}>${key}<input data-param=${key} type=${d.type === "color" ? "color" : "number"} min=${d.min} max=${d.max} step=${d.type === "int" ? 1 : d.step || "any"} value=${value} onInput=${e => update(key, e.target.value)} /></label>`;
  })}</fieldset>`;
}
async function call(path, init, signal) {
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init, signal });
    let body = null; try { body = await res.json(); } catch { /* unknown response refuses */ }
    return { ok: res.ok && !body?.error, body };
  } catch { return { ok: false, body: null }; }
}

function Profile({ value }) {
  if (!value || value.error || !Array.isArray(value.records)) return html`<p class="sub">${tn("unavailable")}</p>`;
  if (value.status === "unmeasured" || !value.records.length) return html`<p class="sub">${tn("unmeasured")}</p>`;
  return html`<div class="s-fx-profile"><p class="sub">${tn("reported")}</p>${value.records.map((p, i) => {
    const valid = p && ["standard", "constrained"].includes(p.device) && [p.fps_p50, p.fps_p10].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000);
    if (!valid) return html`<p key=${i} class="sub">${tn("unavailable")}</p>`;
    return html`<div key=${i}><strong>${tn(p.device)}</strong><p class="sub">${tn("fps")}: ${p.fps_p50} / ${p.fps_p10} · ${tn("tasks")}: ${typeof p.long_task_p95 === "number" && Number.isFinite(p.long_task_p95) ? `${p.long_task_p95} ms` : tn("noTasks")}</p></div>`;
  })}</div>`;
}

/** Admin changes remain authoritative on the host; canWrite is a display hint only. */
export function EffectsCard() {
  const app = useStore(appStore), [view, setView] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  const [target, setTarget] = useState(""), [limit, setLimit] = useState(50), [history, setHistory] = useState({}), [drafts, setDrafts] = useState({});
  const uploadInput = useRef(null);
  const life = useRef({ alive: false, seq: 0, controller: null, pending: false });
  const current = (seq) => life.current.alive && seq === life.current.seq;
  const begin = () => { if (!life.current.alive || life.current.pending || publicLink()) return null; life.current.pending = true; life.current.controller?.abort(); const controller = new AbortController(), seq = ++life.current.seq; life.current.controller = controller; return { seq, signal: controller.signal }; };
  const finish = seq => { if (current(seq)) { life.current.pending = false; setBusy(false); } };
  const load = async (op) => {
    const r = await call("/ui/effects", {}, op.signal); if (!current(op.seq)) return false;
    const data = r.ok ? effectCatalog(r.body) : null; setView(data); setHistory({}); setError(data ? null : tn("failed")); return !!data;
  };
  const reload = async () => { const op = begin(); if (!op) return; setBusy(true); setMessage(null); await load(op); finish(op.seq); };
  useEffect(() => {
    life.current.alive = true;
    if (!publicLink()) reload();
    return () => { life.current.alive = false; life.current.seq++; life.current.controller?.abort(); };
  }, []);
  if (publicLink()) return html`<section class="card s-appearance s-effects"><h3>${tn("title")}</h3><p class="sub">${tn("public")}</p></section>`;
  const names = app.ready ? [...new Set((app.instances || []).map(i => i?.name).filter(n => typeof n === "string" && n.length > 0 && n.length <= 128))] : [];
  const selected = names.includes(target) ? target : "";
  const change = async (path, body, method = "POST") => {
    if (busy || !view?.canWrite) return;
    const op = begin(); if (!op) return; setBusy(true); setMessage(null);
    const r = await call(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }, op.signal);
    if (!current(op.seq)) return;
    if (!r.ok) setMessage(refusal(r.body, "actionFailed")); else { const refreshed = await load(op); if (current(op.seq)) setMessage(tn(refreshed ? "saved" : "savedRefresh")); }
    finish(op.seq);
  };
  const upload = async (event) => {
    const input = event.currentTarget, files = Array.from(input.files || []); input.value = "";
    if (busy || !view?.canWrite || !files.length) return;
    const op = begin(); if (!op) return; setBusy(true); setMessage(null);
    try {
      const body = await encodeEffectFolder(files, op.signal); if (!current(op.seq)) return;
      const r = await call("/ui/effects/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body }, op.signal);
      if (!current(op.seq)) return;
      if (!r.ok) setMessage(refusal(r.body, "uploadFailed")); else { const refreshed = await load(op); if (current(op.seq)) setMessage(tn(refreshed ? "saved" : "savedRefresh")); }
    } catch { if (current(op.seq)) setMessage(tn("uploadFailed")); }
    finish(op.seq);
  };
  const profile = async (id) => {
    if (busy) return; const op = begin(); if (!op) return; setBusy(true);
    const r = await call(`/ui/effects/profile/${id}`, {}, op.signal); if (!current(op.seq)) return;
    if (r.ok && r.body && Array.isArray(r.body.records) && r.body.records.length <= 40) setHistory(h => ({ ...h, [id]: r.body })); else setMessage(tn("profileFailed"));
    finish(op.seq);
  };
  const askDelete = async id => {
    if (!view?.canWrite) return; const op = begin(); if (!op) return; setBusy(true);
    const yes = await confirmDialog({ message: tn("deleteConfirm"), confirmLabel: tn("delete"), danger: true });
    if (!current(op.seq)) return; finish(op.seq);
    if (yes) await change(`/ui/effects/${id}`, undefined, "DELETE");
  };
  return html`<section class="card s-appearance s-effects"><${CardTitle} title=${tn("title")} topic="effects" /><p class="sub">${tn("lead")}</p>
    <div class="s-fx-actions"><button type="button" class="btn" disabled=${busy} onClick=${reload}>${tn("retry")}</button>
      ${view?.canWrite ? html`<button class="btn s-fx-choose" type="button" disabled=${busy} onClick=${() => uploadInput.current?.click()}>${tn("folder")}</button><input ref=${uploadInput} class="offscreen s-fx-upload" aria-label=${tn("folder")} tabindex="-1" type="file" webkitdirectory=${true} directory=${true} multiple disabled=${busy} onChange=${upload} />` : null}</div>
    ${busy ? html`<p class="sub" role="status">${tn("loading")}</p>` : null}${error ? html`<p class="err" role="status">${error}</p>` : null}${message ? html`<p class="sub" role="status">${message}</p>` : null}
    ${view ? html`<p class="sub">${tn(view.effects.length === 1 ? "one" : "count", view.effects.length)}${!view.canWrite ? ` · ${tn("readOnly")}` : ""}</p>` : null}
    ${view?.canWrite ? html`<p class="sub">${tn("files")}</p><label class="s-fx-chat">${tn("chat")}<select class="s-fx-target" value=${selected} disabled=${busy} onChange=${e => setTarget(e.target.value)}><option value="">${tn("chooseChat")}</option>${names.map(n => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>` : null}
    ${view && !view.effects.length ? html`<p class="sub">${tn("empty")}</p>` : null}
    <${OwnerEffects} catalog=${view} busy=${busy} />
    <div class="s-fx-list">${(view?.effects || []).slice(0, limit).map(e => html`<article class="s-fx-item" key=${e.id} data-effect-id=${e.id}><h4>${e.manifest.title}</h4><p class="sub"><code>${e.id.slice(0, 8)}</code> · ${Math.ceil(e.bytes / 1024)} KiB · ${tn(e.ownClaim ? "yours" : "shared")}</p>
      ${e.manifest.poster === "poster.png" ? html`<img class="s-fx-poster" src=${`/ui/effects/image/${e.id}/poster.png`} alt="" loading="lazy" />` : null}
      <${Profile} value=${history[e.id] || e.profiles} />
      ${view.canWrite ? html`<${Params} manifest=${e.manifest} draft=${drafts[e.id] || {}} disabled=${busy} update=${(key, value) => setDrafts(s => ({ ...s, [e.id]: { ...(s[e.id] || {}), [key]: value } }))} />` : null}<div class="s-fx-actions"><button class="btn" type="button" disabled=${busy} onClick=${() => profile(e.id)}>${tn("history")}</button>
      ${view.canWrite ? html`<button class="btn s-fx-apply" type="button" disabled=${busy || !selected} onClick=${() => { const params = effectParamOverrides(e.manifest, drafts[e.id] || {}); if (params === null) setMessage(tn("badParams")); else change("/ui/effects/apply", { instance: selected, id: e.id, params }); }}>${tn("apply")}</button><button class="btn s-fx-remove" type="button" disabled=${busy || !selected} onClick=${() => change("/ui/effects/remove", { instance: selected, id: e.id })}>${tn("remove")}</button>` : null}
      ${view.canWrite && e.ownClaim ? html`<button class="btn s-fx-delete" type="button" disabled=${busy} onClick=${() => askDelete(e.id)}>${tn("delete")}</button>` : null}</div>
      ${view.canWrite && e.ownClaim ? html`<label class="check"><input class="s-fx-share" type="checkbox" checked=${e.sharedByYou} disabled=${busy} onChange=${event => change("/ui/effects/share", { id: e.id, shared: event.target.checked })} />${tn("share")}</label>` : null}
    </article>`)}</div>
    ${view && limit < view.effects.length ? html`<button class="btn" type="button" onClick=${() => setLimit(n => n + 50)}>${tn("more")}</button>` : null}
  </section>`;
}
