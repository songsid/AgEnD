// AGEND-133 (upstream #3521): the Install button of Settings → Agents → AI sign-ins and API keys — installing an AI CLI on the AgEnD host from the dashboard.
// A module of its own, its words registered here (a tab that kept an older accounts-view.js never meets a raw key).
//
// The page only names a CLI. POST /ui/host-install `{ backend }` — the server looks up the registry's command and runs it as `/login` does (web-host-install.ts);
// nothing here is ever a command. The current (or last, for ten minutes) install is read from GET /ui/host-install: while one runs, every two seconds and
// whenever the stream's `backend_login` event says something moved (accounts-view.js listens, once, and reads both); its last lines of output, its verdict and the version found come from there.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { toast } from "/assets/ui-toast.js";

register("hostinstall", {
  en: {
    install: "Install", installing: "Installing…", cancel: "Cancel install", dismiss: "Dismiss",
    notInstalled: "Not installed on this AgEnD host. Install runs the CLI's official installer here, for the user AgEnD runs as.",
    running: "Installing {0} (started on {1}).", runningNoOutput: "Waiting for the installer to print something…",
    ok: "{0} is installed.", okVersion: "{0} {1} is installed.",
    okUnverified: "The installer finished, but {0} was not found afterwards. Read its last lines below.",
    failed: "The {0} install did not finish.", failedCode: "The {0} installer exited with code {1}.",
    cancelled: "The {0} install was cancelled.", timeout: "The {0} install took too long and was stopped.",
    cleanup: "The install window could not be confirmed closed: check the AgEnD host.",
    output: "Installer output (last lines)",
    started: "Installing {0}…",
    err_unsupported: "This CLI cannot be installed from here.", err_already: "{0} is already installed on this host.",
    err_busy: "Another install or sign-in is running. Wait for it to end, or cancel it.", err_shutting_down: "AgEnD is shutting down.",
    err_not_allowed: "Only a fleet admin signed in on this machine or its network can install a CLI.",
    err_install_needs_a_local_admin: "Only a fleet admin signed in on this machine or its network can install a CLI.",
    err_install_not_over_public_link: "Installing is not available over the public link. Open the dashboard on the machine running AgEnD.",
    err_failed: "The install could not start.", err_other: "That did not work.",
  },
  "zh-TW": {
    install: "安裝", installing: "安裝中…", cancel: "取消安裝", dismiss: "關閉",
    notInstalled: "這台 AgEnD 主機還沒安裝。按「安裝」會在這裡，以 AgEnD 執行時的使用者身分，執行這個 CLI 的官方安裝程式。",
    running: "正在安裝 {0}（從 {1} 啟動）。", runningNoOutput: "等安裝程式印出內容…",
    ok: "{0} 已安裝。", okVersion: "{0} {1} 已安裝。",
    okUnverified: "安裝程式已結束，但之後找不到 {0}。請看下方它的最後幾行。",
    failed: "{0} 沒有安裝完成。", failedCode: "{0} 的安裝程式以結束碼 {1} 結束。",
    cancelled: "已取消 {0} 的安裝。", timeout: "{0} 的安裝花太久，已停止。",
    cleanup: "無法確認安裝視窗已關閉：請檢查 AgEnD 主機。",
    output: "安裝程式輸出（最後幾行）",
    started: "正在安裝 {0}…",
    err_unsupported: "這個 CLI 不能從這裡安裝。", err_already: "這台主機已經安裝 {0}。",
    err_busy: "另一個安裝或登入正在進行。請等它結束，或先取消它。", err_shutting_down: "AgEnD 正在關閉。",
    err_not_allowed: "只有在這台機器或它的網路上登入的 fleet 管理員，才能安裝 CLI。",
    err_install_needs_a_local_admin: "只有在這台機器或它的網路上登入的 fleet 管理員，才能安裝 CLI。",
    err_install_not_over_public_link: "公開連結上不能安裝。請在執行 AgEnD 的機器上開啟儀表板。",
    err_failed: "安裝無法開始。", err_other: "沒有成功。",
  },
});
// AGEND-136 (#3521): the Update button beside Install. The page names the CLI and nothing else (POST /ui/host-update { backend }); the server picks the command and the
// AUDITED release it goes to (cli-audited.ts), so the button always says which version it installs. A CLI that updates itself shows the versions and no button.
register("hostinstall", {
  en: {
    update: "Update to {0}", updating: "Updating…", cancelUpdate: "Cancel update",
    verCurrent: "{0} is installed — up to date. The newest version AgEnD has audited: {1}.",
    verBehind: "{0} is installed. The newest version AgEnD has audited is {1}: Update installs exactly that, not the newest release.",
    verSelf: "{0} is installed. The newest version AgEnD has audited is {1}. This CLI updates itself in the background, so there is no Update button.",
    verNewer: "{0} is installed. That is newer than {1}, the newest version AgEnD has audited: not verified by AgEnD yet.",
    verUnknown: "The installed version could not be read. The newest version AgEnD has audited: {0}.",
    runningUpdate: "Updating {0} to {1} (started on {2}).",
    updated: "{0} was updated from {1} to {2}.", updatedNoFrom: "{0} was updated to {1}.", updatedSame: "The {0} update finished, but it is still {1}. Read the installer's last lines below.",
    updatedNoVersion: "The {0} update finished.",
    failedUpdate: "The {0} update did not finish.", failedUpdateCode: "The {0} update exited with code {1}.",
    cancelledUpdate: "The {0} update was cancelled.", timeoutUpdate: "The {0} update took too long and was stopped.",
    err_not_installed: "{0} is not installed on this host.", err_up_to_date: "{0} is already at the version AgEnD has audited (or newer): there is nothing to update.",
  },
  "zh-TW": {
    update: "更新到 {0}", updating: "更新中…", cancelUpdate: "取消更新",
    verCurrent: "已安裝 {0}，是最新的。AgEnD 稽核過的最新版本：{1}。",
    verBehind: "已安裝 {0}。AgEnD 稽核過的最新版本是 {1}：按「更新」會裝這個版本，不是最新釋出版。",
    verSelf: "已安裝 {0}。AgEnD 稽核過的最新版本是 {1}。這個 CLI 會在背景自己更新，所以這裡沒有「更新」按鈕。",
    verNewer: "已安裝 {0}，比 AgEnD 稽核過的最新版本 {1} 還新：尚未經 AgEnD 驗證。",
    verUnknown: "讀不到已安裝的版本。AgEnD 稽核過的最新版本：{0}。",
    runningUpdate: "正在把 {0} 更新到 {1}（從 {2} 啟動）。",
    updated: "{0} 已從 {1} 更新到 {2}。", updatedNoFrom: "{0} 已更新到 {1}。", updatedSame: "{0} 的更新已結束，但版本仍是 {1}。請看下方安裝程式的最後幾行。",
    updatedNoVersion: "{0} 的更新已結束。",
    failedUpdate: "{0} 沒有更新完成。", failedUpdateCode: "{0} 的更新以結束碼 {1} 結束。",
    cancelledUpdate: "已取消 {0} 的更新。", timeoutUpdate: "{0} 的更新花太久，已停止。",
    err_not_installed: "這台主機沒有安裝 {0}。", err_up_to_date: "{0} 已經是 AgEnD 稽核過的版本（或更新）：不需要更新。",
  },
});
const th = (k, ...v) => t(`hostinstall.${k}`, ...v);

/** What this page knows: the current (or last) install as the server shows it, and the ones the person has dismissed. */
export const hostInstallStore = createStore({ loaded: false, run: null, dismissed: [], starting: null });

let reading = null, again = false;
/** Read GET /ui/host-install (one read at a time; one asked for while another is on its way follows it, so the last change is never missed). */
export function refreshHostInstall() {
  if (reading) { again = true; return reading; }
  reading = fetch("/ui/host-install", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => { if (b) hostInstallStore.set({ loaded: true, run: b.install || null }); return b; })
    .catch(() => null)
    .finally(() => { reading = null; if (again) { again = false; void refreshHostInstall(); } });
  return reading;
}

async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { ok: res.ok, status: res.status, body: json };
  } catch { return { ok: false, status: 0, body: null }; }
}

const errorText = (code, backend) => {
  const key = `err_${code}`, text = th(key, backend);
  return text === `hostinstall.${key}` ? th("err_other") : text;
};

/** Install `backend` on the host. Resolves true when the server started it. The page sends the CLI's id and nothing else. */
export async function startHostInstall(backend) {
  if (hostInstallStore.get().starting) return false;
  hostInstallStore.set({ starting: backend });
  const r = await post("/ui/host-install", { backend });
  hostInstallStore.set({ starting: null });
  if (r.ok && r.body && r.body.install) { hostInstallStore.set({ loaded: true, run: r.body.install }); return true; }
  toast(errorText(r.body && r.body.error, backend));
  void refreshHostInstall();
  return false;
}

/**
 * Update `backend` on the host to the audited release (AGEND-136). Resolves true when the server started it. The page sends the CLI's id and nothing else; which release
 * and which command are the server's.
 */
export async function startHostUpdate(backend) {
  if (hostInstallStore.get().starting) return false;
  hostInstallStore.set({ starting: backend });
  const r = await post("/ui/host-update", { backend });
  hostInstallStore.set({ starting: null });
  if (r.ok && r.body && r.body.install) { hostInstallStore.set({ loaded: true, run: r.body.install }); return true; }
  toast(errorText(r.body && r.body.error, backend));
  void refreshHostInstall();
  return false;
}

export async function cancelHostInstall() {
  const r = await post("/ui/host-install/cancel", {});
  if (!r.ok) toast(errorText(r.body && r.body.error));
  void refreshHostInstall();
}

export function dismissHostInstall(id) {
  const s = hostInstallStore.get();
  hostInstallStore.set({ dismissed: [...s.dismissed.slice(-20), id] });
}

/** Installing is offered to a signed-in local admin; the public link's page never shows it. */
export const hostInstallOffered = () => !(typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1");

/** The run to show for `backend` in its row: not one the person dismissed. */
export function runFor(state, backend) {
  const run = state.run;
  return run && run.backend === backend && !state.dismissed.includes(run.id) ? run : null;
}

/** Is any install running right now (the window is one fleet-wide: a second one is refused)? */
export const installRunning = (state) => !!state.starting || !!(state.run && state.run.phase === "running");

/**
 * The Install button of a row whose CLI is not installed on the host. `backend`'s own run shows in the row (HostInstallRun below); while another install runs
 * (or a sign-in does: `blocked`), the button waits.
 */
export function InstallButton({ backend, blocked = false }) {
  const state = useStore(hostInstallStore);
  if (!hostInstallOffered()) return null;
  return html`<button type="button" class="btn btn-sm btn-primary s-account-install" disabled=${blocked || installRunning(state)} onClick=${() => { void startHostInstall(backend); }}>${th("install")}</button>`;
}

/**
 * The version line of an installed CLI and its Update button (AGEND-136). `row.cliUpdate` is the server's reading: the audited release, where the installed version stands
 * against it (`current`, `behind`, `newer`, `unknown`), whether the dashboard offers an update (`button`) and who updates it (`via`: "dashboard" or "self").
 */
export function VersionLine({ row, label, blocked = false }) {
  const state = useStore(hostInstallStore);
  const u = row.cliUpdate;
  if (!u || !hostInstallOffered()) return null;
  const installed = u.installed || row.version || "?";
  const text = u.state === "current" ? th("verCurrent", installed, u.audited)
    : u.state === "newer" ? th("verNewer", installed, u.audited)
    : u.state === "unknown" ? th("verUnknown", u.audited)
    : u.via === "self" ? th("verSelf", installed, u.audited)
    : th("verBehind", installed, u.audited);
  const run = runFor(state, row.backend);
  const updating = !!run && run.phase === "running" && run.mode === "update";
  return html`<div class="s-account-version" data-cli-update=${u.state} data-via=${u.via}>
    <p class="note s-account-why">${text}</p>
    ${u.button ? html`<span class="s-actions"><button type="button" class="btn btn-sm btn-primary s-account-update" aria-label=${`${label} — ${th("update", u.audited)}`} disabled=${blocked || installRunning(state)} onClick=${() => { void startHostUpdate(row.backend); }}>${updating ? th("updating") : th("update", u.audited)}</button></span>` : null}
  </div>`;
}

/** The progress and the verdict of this CLI's install, under its row; nothing when there is none (or it was dismissed). */
export function HostInstallRun({ backend, label }) {
  const state = useStore(hostInstallStore);
  const run = runFor(state, backend);
  const [busy, setBusy] = useState(false);
  const live = !!run && run.phase === "running";
  // Running: read it every 2 s too (a page whose stream is down still sees it move).
  useEffect(() => {
    if (!live) return undefined;
    const h = setInterval(() => { void refreshHostInstall(); }, 2000);
    return () => clearInterval(h);
  }, [live]);
  if (!run) return null;
  const lines = Array.isArray(run.lines) ? run.lines : [];
  let text, cls = "";
  const update = run.mode === "update";
  if (run.phase === "running") text = update ? th("runningUpdate", label, run.targetVersion || "?", run.startedOn) : th("running", label, run.startedOn);
  else if (run.phase === "ok" && update) {
    // An update says the version before and after (the binary probe's own readings); a version that did not move is said as such.
    cls = run.verified ? "signin-ok" : "signin-message";
    text = !run.verified ? th("okUnverified", label)
      : !run.version ? th("updatedNoVersion", label)
      : run.fromVersion && run.fromVersion === run.version ? (cls = "signin-message", th("updatedSame", label, run.version))
      : run.fromVersion ? th("updated", label, run.fromVersion, run.version) : th("updatedNoFrom", label, run.version);
  }
  else if (run.phase === "ok") { cls = run.verified ? "signin-ok" : "signin-message"; text = !run.verified ? th("okUnverified", label) : run.version ? th("okVersion", label, run.version) : th("ok", label); }
  else if (run.phase === "cancelled") text = th(update ? "cancelledUpdate" : "cancelled", label);
  else if (run.phase === "timeout") text = th(update ? "timeoutUpdate" : "timeout", label);
  else text = run.exitCode !== null && run.exitCode !== undefined ? th(update ? "failedUpdateCode" : "failedCode", label, run.exitCode) : th(update ? "failedUpdate" : "failed", label);
  const cancel = async () => { setBusy(true); await cancelHostInstall(); setBusy(false); };
  return html`<div class="s-account-install-run" data-phase=${run.phase} role="status">
    <p class=${`s-account-why ${cls}`}>${text}</p>
    ${lines.length ? html`<pre class="s-account-install-output" aria-label=${th("output")}>${lines.join("\n")}</pre>`
      : run.phase === "running" ? html`<small class="note">${th("runningNoOutput")}</small>` : null}
    ${run.cleanupFailed ? html`<p class="note">${th("cleanup")}</p>` : null}
    <div class="s-actions">${run.phase === "running"
      ? html`<button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${cancel}>${th(update ? "cancelUpdate" : "cancel")}</button>`
      : html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => dismissHostInstall(run.id)}>${th("dismiss")}</button>`}</div>
  </div>`;
}

export { th as hostInstallText };
