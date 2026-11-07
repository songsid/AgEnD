import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";

/**
 * #3190 Part 3b: install a CLI on a paired Windows computer, from Settings → Runtime. The page sends only a CLI id; the Runtime on that computer decides the
 * package, the exact version, the folder and the checks. It happens only while that computer's owner has turned the "install" switch on THERE (the page can
 * read the switch, never change it). Claude Code and Codex only; the other CLIs show their official command for the computer's owner to run.
 */
register("runtimeInstall", {
  en: { title: "Install a CLI", lead: "Installs the fixed version AgEnD pins, into this Runtime's own folder on that computer. No administrator, no PATH change, no vendor script.",
    old: "Update the Runtime on that computer to install CLIs from here.", offline: "That computer is offline.", unreadable: "Could not read this computer's setting. Try again.",
    switchOff: "The owner of that computer has not turned this on. On that computer, run:", switchOn: "Allowed by that computer's owner.", switchUntil: "Allowed until {0}.",
    installed: "Installed {0}", installedOther: "Installed {0} (not the version AgEnD installs)", notInstalled: "Not installed", install: "Install {0}", reinstall: "Install pinned {0}", installing: "Installing… this can take a few minutes",
    ask: "Install {0} {1} on {2}? It comes from the official npm registry, is checked against AgEnD's pinned hashes, the registry signatures and the publisher's Windows signature, and is kept in this Runtime's folder on that computer. The install is recorded there.",
    confirm: "Install", done: "{0} {1} is installed.", failed: "The install did not finish: {2}", failedShort: "The install did not finish.", requestFailed: "Could not start the install: {0}",
    othersTitle: "Other CLIs", othersLead: "AgEnD does not install these. The computer's owner can run the vendor's own command in PowerShell on that computer.", needsAdmin: "needs an administrator" },
  "zh-TW": { title: "安裝 CLI", lead: "安裝 AgEnD 固定的版本，裝在那台電腦上 Runtime 自己的資料夾。不需要系統管理員，不改 PATH，也不執行廠商腳本。",
    old: "請更新那台電腦上的 Runtime，才能從這裡安裝 CLI。", offline: "那台電腦目前離線。", unreadable: "無法讀取那台電腦的設定，請再試一次。",
    switchOff: "那台電腦的主人還沒有開啟這個功能。請在那台電腦執行：", switchOn: "那台電腦的主人已允許。", switchUntil: "已允許，到 {0} 為止。",
    installed: "已安裝 {0}", installedOther: "已安裝 {0}（不是 AgEnD 會安裝的版本）", notInstalled: "尚未安裝", install: "安裝 {0}", reinstall: "安裝固定版本 {0}", installing: "安裝中…可能需要幾分鐘",
    ask: "要在 {2} 安裝 {0} {1} 嗎？它來自官方 npm registry，會比對 AgEnD 內建的雜湊、registry 簽章與發行者的 Windows 數位簽章，並放在那台電腦上 Runtime 自己的資料夾。那台電腦會留下安裝紀錄。",
    confirm: "安裝", done: "{0} {1} 已安裝。", failed: "安裝沒有完成：{2}", failedShort: "安裝沒有完成。", requestFailed: "無法開始安裝：{0}",
    othersTitle: "其他 CLI", othersLead: "AgEnD 不會安裝這些。電腦的主人可以在那台電腦的 PowerShell 執行廠商自己的指令。", needsAdmin: "需要系統管理員" },
});
const text = (key, ...values) => t(`runtimeInstall.${key}`, ...values);

/** A command, not words: the same in every language. */
export const SWITCH_COMMAND = "agend-runtime remote-setup install on --for 2h";
/** The CLIs a Runtime can install, as AgEnD's own table names them; the Runtime enforces its own list. */
export const INSTALL_CLIS = [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }];
/** Vendor commands, for the computer's owner to run: AgEnD never sends them anywhere. */
export const OFFICIAL_COMMANDS = [
  { id: "grok", label: "Grok", command: "irm https://x.ai/cli/install.ps1 | iex" },
  { id: "antigravity", label: "Antigravity", command: "irm https://antigravity.google/cli/install.ps1 | iex" },
  { id: "kiro", label: "Kiro", command: "irm https://cli.kiro.dev/install.ps1 | iex", administrator: true },
];
/** A computer shows this only when its Runtime says it can (and it is a paired, approved one). */
/**
 * The version number inside what a CLI printed for `--version` ("codex-cli 0.165.0", "2.1.316 (Claude Code)"): the first x.y.z (a prerelease may follow),
 * not glued to other digits or dots. Null when there is none, which counts as "a different version".
 */
export const versionNumber = printed => typeof printed === "string" ? /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\d.])/.exec(printed)?.[0] ?? null : null;
export const offersCliInstall = machine => !!machine && !machine.isLocal && machine.runtimeInfo?.capabilities?.includes("cli-install") === true && ["online", "offline"].includes(machine.status);

// Ridge #3321 S06 / S09: the words of the loading state and the copyable commands.
register("runtimeInstall", {
  en: { loading: "Reading this computer's install setting…", copy: "Copy", copied: "Copied", switchCommand: "Command for that computer" },
  "zh-TW": { loading: "正在讀取這台電腦的安裝設定…", copy: "複製", copied: "已複製", switchCommand: "在那台電腦執行的指令" },
});
/** Ridge #3321 S09: a command to run on that computer — Runtime's labelled command card (runtime-install.css), with Copy. */
function CommandCard({ label, command }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { /* it is on screen to copy by hand */ } };
  return html`<div class="runtime-command-card"><span class="runtime-command-label">${label}</span><div class="runtime-command-row">
    <pre class="runtime-command-text" tabindex="0" aria-label=${label}><code>${command}</code></pre>
    <button type="button" class="btn btn-sm" onClick=${copy}>${text(copied ? "copied" : "copy")}</button></div></div>`;
}

export function CliInstall({ machine, lease, onChanged }) {
  const [view, setView] = useState(null), [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const last = useRef("");
  const online = machine.status === "online";
  const path = `/ui/runtimes/machines/${encodeURIComponent(machine.id)}/remote-setup`;
  const load = async () => {
    const response = await lease.fetch(path, { credentials: "same-origin" });
    const value = await response.json().catch(() => ({}));
    if (!lease.current()) return;
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    setView(value);
    return value;
  };
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (online) { setError(""); load().catch(() => { if (lease.current()) setError(text("unreadable")); }); } }, [lease, machine.id, online, attempt]);
  const job = view?.job, running = job?.state === "installing";
  // While an install runs the page asks again every few seconds; when it ends the computer's list is refreshed once.
  useEffect(() => {
    if (!running) return;
    const timer = lease.timeout(() => { load().catch(() => {}); }, 3000);
    return () => lease.clear(timer);
  }, [lease, running, view]);
  useEffect(() => {
    const key = job ? `${job.cli}:${job.startedAt}:${job.state}` : "";
    if (key === last.current) return;
    const before = last.current; last.current = key;
    if (before.endsWith(":installing") && job && job.state !== "installing") {
      const label = INSTALL_CLIS.find(cli => cli.id === job.cli)?.label || job.cli;
      setNote(job.state === "done" ? text("done", label, job.version || "") : job.error ? text("failed", label, job.version || "", job.error) : text("failedShort"));
      onChanged?.();
    }
  }, [job]);
  const switchState = view?.switches?.install;
  const allowed = switchState?.on === true;
  const row = cli => {
    const entry = (machine.inventory?.clis || []).find(item => item.id === cli.id && item.path);
    const pinned = view?.catalog?.find(item => item.id === cli.id)?.version || "";
    // What the CLI printed is compared by its version number, whole; the path says nothing (the owner's own copy of the same version is just as installed).
    const found = entry ? versionNumber(entry.version) : null, upToDate = !!entry && !!pinned && found === pinned;
    const state = !entry ? text("notInstalled") : upToDate ? text("installed", found) : text("installedOther", entry.version || "?");
    const start = async () => {
      if (busy || !pinned) return;
      if (!await confirmDialog({ message: text("ask", cli.label, pinned, machine.name), confirmLabel: text("confirm") })) return;
      if (!lease.current()) return;
      setBusy(true); setError(""); setNote("");
      try {
        const response = await lease.fetch(`/ui/runtimes/machines/${encodeURIComponent(machine.id)}/cli-install`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cli: cli.id }) });
        const value = await response.json().catch(() => ({}));
        if (!lease.current()) return;
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
        await load();
      } catch (e) { if (lease.current()) setError(text("requestFailed", e.message)); }
      finally { if (lease.current()) setBusy(false); }
    };
    return html`<li key=${cli.id} data-cli=${cli.id}><strong>${cli.label}</strong><span class="note">${state}</span>
      ${upToDate ? null : html`<button type="button" class="btn btn-sm" disabled=${!allowed || !online || busy || running || !pinned} onClick=${start}>${entry ? text("reinstall", pinned) : text("install", pinned)}</button>`}</li>`;
  };
  return html`<div class="runtime-cli-install"><h4>${text("title")}</h4><p class="note">${text("lead")}</p>
    ${!online ? html`<p class="note" role="status">${text("offline")}</p>`
      // Ridge #3321 S06: until the computer's setting and the pinned versions are read, the shared loading state — not a
      // settled-looking form of disabled buttons with empty versions; a first read that fails says so, with Retry.
      : !view ? (error ? html`<${ErrorState} message=${error} onRetry=${() => setAttempt((n) => n + 1)} />` : html`<${Skeleton} variant="rows" lines=${2} label=${text("loading")} />`)
      : !view.capable ? html`<p class="note" role="status">${text("old")}</p>` : html`
      <ul class="runtime-cli-install-list" aria-label=${text("title")}>${INSTALL_CLIS.map(row)}</ul>
      ${view && !view.switches ? html`<p class="note" role="status">${text("unreadable")}</p>` : null}
      ${switchState && !allowed ? html`<p class="note runtime-cli-install-off" role="status">${text("switchOff")}</p><${CommandCard} label=${text("switchCommand")} command=${SWITCH_COMMAND} />` : null}
      ${allowed ? html`<p class="note">${switchState.until ? text("switchUntil", new Date(switchState.until).toLocaleString()) : text("switchOn")}</p>` : null}
      ${running ? html`<p class="note" role="status" aria-busy="true"><span class="out-spin" aria-hidden="true"></span> ${text("installing")}</p>` : null}
      ${note ? html`<p class="note" role="status">${note}</p>` : null}
      ${error ? html`<p class="runtime-error" role="alert">${error}</p>` : null}`}
    <details class="runtime-cli-install-others"><summary>${text("othersTitle")}</summary><p class="note">${text("othersLead")}</p>
      <ul>${OFFICIAL_COMMANDS.map(item => html`<li key=${item.id}><${CommandCard} label=${item.administrator ? `${item.label} (${text("needsAdmin")})` : item.label} command=${item.command} /></li>`)}</ul></details>
  </div>`;
}
