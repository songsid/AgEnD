// M-2738 (#3332): updating AgEnD from the web — the app-wide line (a new version for admins, the update's progress in
// every open tab, its failure, and the reload a tab still on the old version needs) and the one confirmation, shared by
// the line, Settings → Advanced's "Version and update" card and /update typed in a chat. The update is the server's:
// POST /ui/update/start runs what chat /update runs; the page reads GET /ui/update. Nothing here names a host command.
// An older server (no /ui/update) answers 404: nothing is shown.
import { html, useEffect, useState } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { createStore, useStore } from "./app-store.js";
import { confirmDialog } from "./ui-confirm.js";
import { Dialog } from "./ui-dialog.js";
import { Icon } from "./ui-icons.js";
import { toast } from "./ui-toast.js";

register("update", {
  en: {
    available: "AgEnD v{0} is available (current v{1})", availableSub: "{0} · only admins see this", now: "Update now", later: "Later",
    channel_latest: "Stable", channel_beta: "Preview", channel_alpha: "Alpha preview",
    same_latest: "the same stable line", same_beta: "the same preview line", same_alpha: "the same alpha preview line",
    confirmTitle: "Update AgEnD?", confirmGo: "Update and restart",
    confirmBody: "This installs v{0} ({1}), then restarts AgEnD. Every Agent stops briefly and comes back on its own.",
    stage_preparing: "Preparing the update to {0}…", stage_downloading: "Downloading and installing {0}…",
    stage_installed: "{0} is installed — restarting AgEnD…", stage_starting: "Starting AgEnD {0}…", theNewVersion: "the new version",
    step: "Step {0} of 4 · {1} s elapsed", stepHint: "AgEnD restarts when it is done; Agents stop briefly.", closeOk: "Closing this page does not affect the update.",
    failed_network: "Update failed: the update source could not be reached.", failed_permission: "Update failed: no permission to install the new version.",
    failed_other: "Update failed: the update did not finish.", unchanged: "AgEnD is still v{0}; nothing was changed.",
    afterInstall: "The new version may be installed, but AgEnD did not finish restarting.", retry: "Try again", fullLog: "See the full log",
    logTitle: "Update log", logEmpty: "No update log yet.", logCause: "What the updater said",
    current: "AgEnD is up to date (v{0}).", updated: "AgEnD is updated to v{0}", reloadSub: "Reload this tab to use the new version.", reload: "Reload",
    dismiss: "Dismiss", adminOnly: "Only a fleet admin can update AgEnD.", running: "An update is already running.",
    upToDate: "AgEnD v{0} is up to date.", stableOnly: "v{0} (stable) is available. Updating from the web stays on this install's line.",
    failedToStart: "The update could not be started: {0}", startedToast: "Update started.",
  },
  "zh-TW": {
    available: "AgEnD v{0} 已推出（目前 v{1}）", availableSub: "{0} · 只有管理員看得到", now: "立即更新", later: "稍後",
    channel_latest: "穩定版", channel_beta: "預覽版", channel_alpha: "Alpha 預覽版",
    same_latest: "同為穩定版", same_beta: "同為預覽版", same_alpha: "同為 Alpha 預覽版",
    confirmTitle: "更新 AgEnD？", confirmGo: "更新並重新啟動",
    confirmBody: "會安裝 v{0}（{1}），然後重新啟動 AgEnD。所有 Agent 會短暫停下，之後自動回來。",
    stage_preparing: "正在準備更新到 {0}…", stage_downloading: "正在下載及安裝 {0}…",
    stage_installed: "已安裝 {0}，正在重新啟動 AgEnD…", stage_starting: "正在啟動 AgEnD {0}…", theNewVersion: "新版",
    step: "第 {0}／4 步 · 已經過 {1} 秒", stepHint: "完成後 AgEnD 會重新啟動，Agent 會短暫停下。", closeOk: "關掉這頁不影響更新。",
    failed_network: "更新失敗：連不上更新來源。", failed_permission: "更新失敗：沒有權限安裝新版。",
    failed_other: "更新失敗：更新沒有完成。", unchanged: "AgEnD 仍是 v{0}，沒有任何變更。",
    afterInstall: "新版可能已經安裝，但 AgEnD 沒能完成重新啟動。", retry: "再試一次", fullLog: "看完整紀錄",
    logTitle: "更新紀錄", logEmpty: "還沒有更新紀錄。", logCause: "更新程式回報的原因",
    current: "AgEnD 已是最新版（v{0}）。", updated: "AgEnD 已更新到 v{0}", reloadSub: "重新載入這個分頁即可使用新版。", reload: "重新載入",
    dismiss: "關閉", adminOnly: "只有 fleet 管理員可以更新 AgEnD。", running: "已經有一個更新在進行中。",
    upToDate: "AgEnD v{0} 已是最新版。", stableOnly: "v{0}（穩定版）已推出。網頁更新會留在這個安裝的版本線。",
    failedToStart: "無法開始更新：{0}", startedToast: "已開始更新。",
  },
});

const ACTIVE = new Set(["preparing", "downloading", "installed", "stopping", "starting"]);
const STEP = { preparing: 1, downloading: 2, installed: 3, stopping: 3, starting: 4 };
/** Per-viewer conveniences (a private window may refuse them: then nothing is remembered, nothing breaks). */
function remembered(key) { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* this page only */ } }
const LATER_KEY = "agend_update_later", DISMISSED_KEY = "agend_update_dismissed";

/**
 * `info`: GET /ui/update's answer (null: none — an older server, a guest, signed out). `loadedVersion`: the version this
 * tab was loaded on (the first answer's): a later answer naming another one means this tab runs the old page.
 */
export const updateStore = createStore({ info: null, loadedVersion: null, skew: 0, starting: false, later: remembered(LATER_KEY),
  dismissed: remembered(DISMISSED_KEY), reloadDismissed: null, log: null });

export function updateActive(info) { return !!(info && info.progress && ACTIVE.has(info.progress.stage)); }

/** Ask the server; a failed read keeps what was known (the server may be restarting). */
export async function refreshUpdate() {
  let r;
  try { r = await fetch("/ui/update", { cache: "no-store" }); } catch { return null; }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403 || r.status === 404) updateStore.set({ info: null });
    return null;
  }
  let body = null;
  try { body = await r.json(); } catch { return null; }
  if (!body || typeof body !== "object" || typeof body.current !== "string") return null;
  const s = updateStore.get();
  updateStore.set({ info: body, loadedVersion: s.loadedVersion || body.current, skew: typeof body.now === "number" ? Date.now() - body.now : 0 });
  return body;
}

/** POST /ui/update/check: look now. The answer replaces what was known. */
export async function checkUpdateNow() {
  let r;
  try { r = await fetch("/ui/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { return { ok: false, status: 0 }; }
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (r.ok && body && typeof body.current === "string") updateStore.set({ info: body });
  return { ok: r.ok, status: r.status, body };
}

function channelWord(channel) { return t(`update.channel_${channel === "alpha" || channel === "latest" ? channel : "beta"}`); }
function sameLine(channel) { return t(`update.same_${channel === "alpha" || channel === "latest" ? channel : "beta"}`); }

/** The one confirmation (the leader's D1: the admin's own, no General card), then the start. From the line, Settings or /update. */
export async function openUpdateDialog() {
  let info = updateStore.get().info;
  if (!info) info = await refreshUpdate();
  if (!info || !info.admin) { toast(t("update.adminOnly"), false); return { ok: false }; }
  if (updateActive(info)) { toast(t("update.running")); return { ok: false }; }
  const offer = info.offer;
  if (!offer) { toast(t("update.upToDate", info.current)); return { ok: false }; }
  if (!offer.installable) { toast(t("update.stableOnly", offer.version), false); return { ok: false }; }
  const yes = await confirmDialog({ title: t("update.confirmTitle"), confirmLabel: t("update.confirmGo"),
    message: t("update.confirmBody", offer.version, sameLine(offer.channel)) });
  if (!yes) return { ok: false };
  updateStore.set({ starting: true });
  const key = `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let res = null, body = null;
  try {
    res = await fetch("/ui/update/start", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ confirm: "update-agend" }) });
    try { body = await res.json(); } catch { body = null; }
  } catch { res = null; }
  updateStore.set({ starting: false });
  if (res && (res.status === 202 || (res.status === 409 && body && body.error === "update_running"))) {
    if (res.status === 202) toast(t("update.startedToast"));
    await refreshUpdate();
    return { ok: true };
  }
  toast(t("update.failedToStart", (body && body.error) || (res ? String(res.status) : "network")), false);
  await refreshUpdate();
  return { ok: false };
}

/** Polls while mounted: every 2 s during an update (and while the server is away in one), else once a minute. */
function usePolling() {
  const { info, starting } = useStore(updateStore);
  const fast = starting || updateActive(info);
  useEffect(() => {
    let stopped = false, timer = null;
    const tick = async () => { if (stopped) return; await refreshUpdate(); if (!stopped) timer = setTimeout(tick, fast ? 2000 : 60_000); };
    timer = setTimeout(tick, fast ? 2000 : 0);
    const onShow = () => { if (document.visibilityState === "visible") { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onShow); };
  }, [fast]);
}

function Line({ tone, icon, spinner, title, sub = [], children, progress }) {
  return html`<div data-trust="status" class=${`conn update-line${tone ? ` ${tone}` : ""}`} role=${tone === "bad" ? "alert" : "status"}>
    <div class="update-text">
      ${spinner ? html`<span class="update-spinner" aria-hidden="true"></span>` : icon ? html`<span class="update-icon"><${Icon} name=${icon} size=${18} /></span>` : null}
      <div class="update-words"><div class="update-title">${title}</div>
        ${sub.filter(Boolean).map((s) => html`<div class="update-sub">${s}</div>`)}
        ${progress ? html`<div class="update-bar" role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow=${progress}><span class=${`update-fill s${progress}`}></span></div>` : null}</div>
    </div>
    ${children ? html`<div class=${`update-actions${icon || spinner ? " indent" : ""}`}>${children}</div>` : null}
  </div>`;
}
function Dismiss({ onClick }) {
  return html`<button type="button" class="btn btn-sm update-x" aria-label=${t("update.dismiss")} title=${t("update.dismiss")} onClick=${onClick}><${Icon} name="close" size=${16} /></button>`;
}

/** The updater's own words, on request (never on the line itself). */
async function openLog() {
  let body = null;
  try { const r = await fetch("/ui/update/log", { cache: "no-store" }); if (r.ok) body = await r.json(); } catch { body = null; }
  updateStore.set({ log: { text: body && typeof body.text === "string" ? body.text : "", error: body && typeof body.error === "string" ? body.error : "" } });
}
function LogDialog() {
  const { log } = useStore(updateStore);
  if (!log) return null;
  const close = () => updateStore.set({ log: null });
  return html`<${Dialog} title=${t("update.logTitle")} wide onClose=${close}
    actions=${html`<button type="button" class="btn btn-primary" onClick=${close}>${t("app.close")}</button>`}>
    ${log.error ? html`<p class="update-log-cause"><strong>${t("update.logCause")}</strong><br />${log.error}</p>` : null}
    ${log.text ? html`<pre class="update-log">${log.text}</pre>` : html`<p class="muted">${t("update.logEmpty")}</p>`}
  </${Dialog}>`;
}

/** The app-wide line. Admins see the offer, the progress and its failure; any signed-in tab on an old version, the reload. */
export function UpdateLine() {
  usePolling();
  const s = useStore(updateStore);
  const [, tick] = useState(0);
  const info = s.info;
  const active = updateActive(info);
  useEffect(() => { if (!active) return undefined; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [active]);
  if (!info) return html`<${LogDialog} />`;
  const p = info.progress;
  let line = null;
  if (s.loadedVersion && info.current !== s.loadedVersion && s.reloadDismissed !== info.current) {
    line = html`<${Line} tone="ok" icon="check" title=${t("update.updated", info.current)} sub=${[t("update.reloadSub")]}>
      <button type="button" class="btn btn-sm btn-primary" onClick=${() => location.reload()}>${t("update.reload")}</button>
      <${Dismiss} onClick=${() => updateStore.set({ reloadDismissed: info.current })} /></${Line}>`;
  } else if (!info.admin) {
    line = null;
  } else if (active) {
    const v = p.version ? `v${p.version}` : t("update.theNewVersion");
    const key = p.stage === "stopping" ? "installed" : p.stage;
    const elapsed = Math.max(0, Math.floor((Date.now() - s.skew - p.started_at) / 1000));
    line = html`<${Line} spinner title=${t(`update.stage_${key}`, v)} progress=${STEP[p.stage]}
      sub=${[t("update.step", STEP[p.stage], elapsed), t("update.stepHint"), t("update.closeOk")]} />`;
  } else if (p && p.stage === "failed" && s.dismissed !== String(p.started_at)) {
    const early = !p.failed_stage || p.failed_stage === "preparing" || p.failed_stage === "downloading";
    const retry = info.offer && info.offer.installable;
    line = html`<${Line} tone="bad" icon="alert" title=${t(`update.failed_${p.cause || "other"}`)}
      sub=${[early ? t("update.unchanged", info.current) : t("update.afterInstall")]}>
      ${retry ? html`<button type="button" class="btn btn-sm btn-primary" onClick=${openUpdateDialog}>${t("update.retry")}</button>` : null}
      <button type="button" class="btn btn-sm" onClick=${openLog}>${t("update.fullLog")}</button>
      <${Dismiss} onClick=${() => { remember(DISMISSED_KEY, String(p.started_at)); updateStore.set({ dismissed: String(p.started_at) }); }} /></${Line}>`;
  } else if (p && p.stage === "complete" && p.web && s.dismissed !== String(p.started_at)) {
    line = html`<${Line} tone="ok" icon="check" title=${t("update.current", info.current)}>
      <${Dismiss} onClick=${() => { remember(DISMISSED_KEY, String(p.started_at)); updateStore.set({ dismissed: String(p.started_at) }); }} /></${Line}>`;
  } else if (info.offer && info.offer.installable && s.later !== info.offer.version) {
    const o = info.offer;
    line = html`<${Line} title=${t("update.available", o.version, info.current)} sub=${[t("update.availableSub", channelWord(o.channel))]}>
      <button type="button" class="btn btn-sm btn-primary" disabled=${s.starting} onClick=${openUpdateDialog}>${t("update.now")}</button>
      <button type="button" class="btn btn-sm" onClick=${() => { remember(LATER_KEY, o.version); updateStore.set({ later: o.version }); }}>${t("update.later")}</button></${Line}>`;
  }
  return html`${line}<${LogDialog} />`;
}
