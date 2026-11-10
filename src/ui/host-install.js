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
import { confirmedWrite } from "./settings-confirm.js";

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
    started: "Installing {0}…", confirm: "Install {0} on the AgEnD host",
    err_unsupported: "This CLI cannot be installed from here.", err_already: "{0} is already installed on this host.",
    err_busy: "Another install or sign-in is running. Wait for it to end, or cancel it.", err_shutting_down: "AgEnD is shutting down.",
    err_not_allowed: "Only a fleet admin signed in on this machine or its network can install a CLI.",
    err_install_needs_a_local_admin: "Only a fleet admin signed in on this machine or its network can install a CLI.",
    err_install_not_over_public_link: "Installing is not available over the public link. Open the dashboard on the machine running AgEnD.",
    err_failed: "The install could not start.", err_other: "That did not work.",
    cardLabelUpdate: "Update {0} on this AgEnD computer", err_expired: "The install was not confirmed in time.", err_rejected: "The install was turned down.", err_stale: "Settings changed before the install could start. Try again.",
    err_install_confirmation_required: "The install must be confirmed first.",
    err_latest_ack_required: "This page is out of date for this update. Refresh the page and try again.", err_latest_ack_mismatch: "This page is out of date for this update. Refresh the page and try again.",
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
    started: "正在安裝 {0}…", confirm: "在 AgEnD 主機上安裝 {0}",
    err_unsupported: "這個 CLI 不能從這裡安裝。", err_already: "這台主機已經安裝 {0}。",
    err_busy: "另一個安裝或登入正在進行。請等它結束，或先取消它。", err_shutting_down: "AgEnD 正在關閉。",
    err_not_allowed: "只有在這台機器或它的網路上登入的 fleet 管理員，才能安裝 CLI。",
    err_install_needs_a_local_admin: "只有在這台機器或它的網路上登入的 fleet 管理員，才能安裝 CLI。",
    err_install_not_over_public_link: "公開連結上不能安裝。請在執行 AgEnD 的機器上開啟儀表板。",
    err_failed: "安裝無法開始。", err_other: "沒有成功。",
    cardLabelUpdate: "在這台 AgEnD 電腦上更新 {0}", err_expired: "安裝沒有在時限內確認。", err_rejected: "安裝已被拒絕。", err_stale: "安裝開始前設定已經改變。請再試一次。",
    err_install_confirmation_required: "安裝必須先經過確認。",
    err_latest_ack_required: "這個頁面的版本已過期，無法進行這次更新。請重新整理頁面再試一次。", err_latest_ack_mismatch: "這個頁面的版本已過期，無法進行這次更新。請重新整理頁面再試一次。",
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
    updated: "{0} was updated from {1} to {2}.", updatedNoFrom: "{0} was updated to {1}.", updatedWarn: "Warning: the {0} installer finished (exit code 0), but the installed version is {1} and the audited version is {2}. It did not reach the audited version: read the installer's last lines below.",
    updatedNoVersion: "The {0} installer finished (exit code 0), but the installed version could not be read afterwards, so it is not known whether it reached the audited version, {1}.",
    failedUpdate: "The {0} update did not finish.", failedUpdateCode: "The {0} update exited with code {1}.",
    cancelledUpdate: "The {0} update was cancelled.", timeoutUpdate: "The {0} update took too long and was stopped.",
    err_not_installed: "{0} is not installed on this host.", err_version_unreadable: "AgEnD could not read the installed version of {0} just now, so it did not update it. Try again in a moment.", err_up_to_date: "{0} is already at the version AgEnD has audited (or newer): there is nothing to update.",
  },
  "zh-TW": {
    update: "更新到 {0}", updating: "更新中…", cancelUpdate: "取消更新",
    verCurrent: "已安裝 {0}，是最新的。AgEnD 稽核過的最新版本：{1}。",
    verBehind: "已安裝 {0}。AgEnD 稽核過的最新版本是 {1}：按「更新」會裝這個版本，不是最新釋出版。",
    verSelf: "已安裝 {0}。AgEnD 稽核過的最新版本是 {1}。這個 CLI 會在背景自己更新，所以這裡沒有「更新」按鈕。",
    verNewer: "已安裝 {0}，比 AgEnD 稽核過的最新版本 {1} 還新：尚未經 AgEnD 驗證。",
    verUnknown: "讀不到已安裝的版本。AgEnD 稽核過的最新版本：{0}。",
    runningUpdate: "正在把 {0} 更新到 {1}（從 {2} 啟動）。",
    updated: "{0} 已從 {1} 更新到 {2}。", updatedNoFrom: "{0} 已更新到 {1}。", updatedWarn: "警告：{0} 的安裝程式已結束（結束碼 0），但已安裝的版本是 {1}，AgEnD 稽核過的版本是 {2}，沒有更新到稽核版本。請看下方安裝程式的最後幾行。",
    updatedNoVersion: "{0} 的安裝程式已結束（結束碼 0），但之後讀不到已安裝的版本，不確定有沒有更新到稽核版本 {1}。",
    failedUpdate: "{0} 沒有更新完成。", failedUpdateCode: "{0} 的更新以結束碼 {1} 結束。",
    cancelledUpdate: "已取消 {0} 的更新。", timeoutUpdate: "{0} 的更新花太久，已停止。",
    err_not_installed: "這台主機沒有安裝 {0}。", err_version_unreadable: "AgEnD 剛才讀不到 {0} 目前安裝的版本，所以沒有更新。請稍後再試。", err_up_to_date: "{0} 已經是 AgEnD 稽核過的版本（或更新）：不需要更新。",
  },
});
// AGEND-153 (the maintainer's decision on #3539): the one named exception — a CLI that updates itself and whose own updater cannot choose a release (Antigravity). Its button goes to the LATEST
// release, which AgEnD has not audited, and says so on the button and in the line above it. Every other rule of an update (the held change, the asker's code, no public link) is the same.
register("hostinstall", {
  en: {
    updateLatest: "Update to latest (not audited by AgEnD)", cardLabelUpdateLatest: "Update {0} on this AgEnD computer to the latest release (not audited by AgEnD)",
    verLatestCurrent: "{0} is installed — the version AgEnD has audited ({1}). Update goes to the latest release the vendor serves, which AgEnD has NOT audited: this CLI updates itself and cannot be pinned.",
    verLatestBehind: "{0} is installed. The newest version AgEnD has audited is {1}. Update goes to the latest release the vendor serves, which AgEnD has NOT audited: this CLI updates itself and cannot be pinned.",
    verLatestNewer: "{0} is installed. That is newer than {1}, the newest version AgEnD has audited: not verified by AgEnD yet. Update goes to the latest release the vendor serves, also not audited.",
    runningUpdateLatest: "Updating {0} to the latest release, not audited by AgEnD (started on {2}).",
    updatedLatestSame: "{0} is already at {1}, the latest release the vendor serves (not audited by AgEnD).",
    updatedLatest: "{0} was updated from {1} to {2}, the latest release the vendor serves (not audited by AgEnD).", updatedLatestNoFrom: "{0} was updated to {1}, the latest release the vendor serves (not audited by AgEnD).",
    updatedLatestNoVersion: "The {0} updater finished (exit code 0), but the installed version could not be read afterwards, so it is not known which release it is now.",
  },
  "zh-TW": {
    updateLatest: "更新到最新版（未經盤點）", cardLabelUpdateLatest: "在這台 AgEnD 電腦上把 {0} 更新到最新版（未經 AgEnD 盤點）",
    verLatestCurrent: "已安裝 {0}，是 AgEnD 稽核過的版本（{1}）。按「更新」會更新到廠商釋出的最新版，這個版本 AgEnD 尚未稽核：這個 CLI 會自己更新，無法指定版本。",
    verLatestBehind: "已安裝 {0}。AgEnD 稽核過的最新版本是 {1}。按「更新」會更新到廠商釋出的最新版，這個版本 AgEnD 尚未稽核：這個 CLI 會自己更新，無法指定版本。",
    verLatestNewer: "已安裝 {0}，比 AgEnD 稽核過的最新版本 {1} 還新：尚未經 AgEnD 驗證。按「更新」會更新到廠商釋出的最新版，同樣未經稽核。",
    runningUpdateLatest: "正在把 {0} 更新到最新版，未經 AgEnD 盤點（從 {2} 啟動）。",
    updatedLatestSame: "{0} 已經是 {1}，也就是廠商釋出的最新版（未經 AgEnD 盤點）。",
    updatedLatest: "{0} 已從 {1} 更新到 {2}，廠商釋出的最新版（未經 AgEnD 盤點）。", updatedLatestNoFrom: "{0} 已更新到 {1}，廠商釋出的最新版（未經 AgEnD 盤點）。",
    updatedLatestNoVersion: "{0} 的更新程式已結束（結束碼 0），但之後讀不到已安裝的版本，不確定現在是哪個版本。",
  },
});
const th = (k, ...v) => t(`hostinstall.${k}`, ...v);
function installStyles() {
  if (typeof document === "undefined" || !document.head || document.querySelector('link[href="/assets/host-install.css"]')) return;
  const link = document.createElement("link");
  link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/host-install.css"); document.head.appendChild(link);
}
function revealPending(id) {
  const show = () => Array.from(document.querySelectorAll("[data-pending]")).find(n => n.getAttribute("data-pending") === id)?.scrollIntoView?.({ block: "center" });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(show));
  else setTimeout(show, 0);
}

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

/** Why a confirmed install did not start, as the Settings gate reports it (`apply_rejected: busy`), else what the write itself answered. */
const refusalOf = (r) => {
  const outcome = r.confirmed && r.confirmed.outcome;
  const m = outcome && typeof outcome.detail === "string" ? /apply_rejected: ([a-z_]+)/.exec(outcome.detail) : null;
  if (m) return m[1];
  if (r.confirmed && ["expired", "rejected", "stale"].includes(r.confirmed.state)) return r.confirmed.state;
  return r.body && r.body.error;
};

/**
 * Install (or update) `backend` on the host. Resolves true when the server started it. The page sends the CLI's id and nothing else — and through the Settings gate (AGEND-144):
 * both are held changes like any other that acts on the host. Where the lenient default applies the change is applied at once; for an administrator who asked for their own code the
 * card asks for it, bound to the digest of this change. Whatever the gate answers, the run shown is the server's. (Which release an update goes to and which command runs are the server's.)
 */
async function startHostCli(path, backend, labelKey, extra = {}) {
  installStyles();
  if (hostInstallStore.get().starting) return false;
  hostInstallStore.set({ starting: backend });
  let r;
  try { r = await confirmedWrite(path, { body: { backend, ...extra }, label: th(labelKey, backend), displaySummary: () => [th(labelKey, backend)], onPending: revealPending }); }
  catch { r = { ok: false, body: null }; }
  finally { hostInstallStore.set({ starting: null }); }
  if (r.ok && r.body && r.body.install) { hostInstallStore.set({ loaded: true, run: r.body.install }); return true; }
  toast(errorText(refusalOf(r), backend));
  void refreshHostInstall();
  return false;
}
export const startHostInstall = (backend) => startHostCli("/ui/host-install", backend, "confirm");
/** Update `backend` on the host to the audited release (AGEND-136). */
/** AGEND-154 (Prism P2-1 on #3552): the update to the vendor's latest (`latest`, the one named exception) says so in the request — `acceptLatestUnaudited: true` — which is what lets the server run it; a page without this line sends `{ backend }`, and the server refuses. */
export const startHostUpdate = (backend, latest = false) => startHostCli("/ui/host-update", backend, latest ? "cardLabelUpdateLatest" : "cardLabelUpdate", latest ? { acceptLatestUnaudited: true } : {});

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
  installStyles();
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
  const text = u.latest ? th(u.state === "current" ? "verLatestCurrent" : u.state === "newer" ? "verLatestNewer" : "verLatestBehind", installed, u.audited)
    : u.state === "current" ? th("verCurrent", installed, u.audited)
    : u.state === "newer" ? th("verNewer", installed, u.audited)
    : u.state === "unknown" ? th("verUnknown", u.audited)
    : u.via === "self" ? th("verSelf", installed, u.audited)
    : th("verBehind", installed, u.audited);
  const run = runFor(state, row.backend);
  const updating = !!run && run.phase === "running" && run.mode === "update";
  const buttonLabel = u.latest ? th("updateLatest") : th("update", u.audited);
  return html`<div class="s-account-version" data-cli-update=${u.state} data-via=${u.via} data-latest=${u.latest ? "1" : "0"}>
    <p class="note s-account-why">${text}</p>
    ${u.button ? html`<span class="s-actions"><button type="button" class="btn btn-sm btn-primary s-account-update" aria-label=${`${label} — ${buttonLabel}`} disabled=${blocked || installRunning(state)} onClick=${() => { void startHostUpdate(row.backend, !!u.latest); }}>${updating ? th("updating") : buttonLabel}</button></span>` : null}
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
  if (run.phase === "running") text = update ? (run.latest ? th("runningUpdateLatest", label, "", run.startedOn) : th("runningUpdate", label, run.targetVersion || "?", run.startedOn)) : th("running", label, run.startedOn);
  else if (run.phase === "ok" && update) {
    // An update says the version before and after (the binary probe's own readings). Exit code 0 is not enough: when the version read afterwards is not the audited release (`reached`
    // false), or could not be read (null), it is a warning that names the installed and the audited version, not a success.
    const target = run.targetVersion || "?";
    if (!run.verified) { cls = "signin-message"; text = th("okUnverified", label); }
    // The named exception goes to the vendor's newest release, so there is no audited release to have reached: the page says what was read before and after, and that it is not audited.
    else if (run.latest) {
      if (!run.version) { cls = "signin-warn"; text = th("updatedLatestNoVersion", label); }
      else { cls = "signin-ok"; text = run.fromVersion === run.version ? th("updatedLatestSame", label, run.version) : run.fromVersion ? th("updatedLatest", label, run.fromVersion, run.version) : th("updatedLatestNoFrom", label, run.version); }
    }
    else if (run.reached === false) { cls = "signin-warn"; text = th("updatedWarn", label, run.version || "?", target); }
    else if (run.reached === null || !run.version) { cls = "signin-warn"; text = th("updatedNoVersion", label, target); }
    else { cls = "signin-ok"; text = run.fromVersion ? th("updated", label, run.fromVersion, run.version) : th("updatedNoFrom", label, run.version); }
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
