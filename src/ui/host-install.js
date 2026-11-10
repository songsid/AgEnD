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

/** Install `backend` on the host. Resolves true when the server started it. The page sends the CLI's id and nothing else. */
export async function startHostInstall(backend) {
  installStyles();
  if (hostInstallStore.get().starting) return false;
  hostInstallStore.set({ starting: backend });
  let r;
  try { r = await confirmedWrite("/ui/host-install", { body: { backend }, label: th("confirm", backend), displaySummary: () => [th("confirm", backend)], onPending: revealPending }); }
  catch { r = { ok: false, body: null }; }
  finally { hostInstallStore.set({ starting: null }); }
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
  installStyles();
  const state = useStore(hostInstallStore);
  if (!hostInstallOffered()) return null;
  return html`<button type="button" class="btn btn-sm btn-primary s-account-install" disabled=${blocked || installRunning(state)} onClick=${() => { void startHostInstall(backend); }}>${th("install")}</button>`;
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
  if (run.phase === "running") text = th("running", label, run.startedOn);
  else if (run.phase === "ok") { cls = run.verified ? "signin-ok" : "signin-message"; text = !run.verified ? th("okUnverified", label) : run.version ? th("okVersion", label, run.version) : th("ok", label); }
  else if (run.phase === "cancelled") text = th("cancelled", label);
  else if (run.phase === "timeout") text = th("timeout", label);
  else text = run.exitCode !== null && run.exitCode !== undefined ? th("failedCode", label, run.exitCode) : th("failed", label);
  const cancel = async () => { setBusy(true); await cancelHostInstall(); setBusy(false); };
  return html`<div class="s-account-install-run" data-phase=${run.phase} role="status">
    <p class=${`s-account-why ${cls}`}>${text}</p>
    ${lines.length ? html`<pre class="s-account-install-output" aria-label=${th("output")}>${lines.join("\n")}</pre>`
      : run.phase === "running" ? html`<small class="note">${th("runningNoOutput")}</small>` : null}
    ${run.cleanupFailed ? html`<p class="note">${th("cleanup")}</p>` : null}
    <div class="s-actions">${run.phase === "running"
      ? html`<button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${cancel}>${th("cancel")}</button>`
      : html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => dismissHostInstall(run.id)}>${th("dismiss")}</button>`}</div>
  </div>`;
}

export { th as hostInstallText };
