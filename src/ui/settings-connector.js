import { html, useEffect, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { connectorPrompt } from "/assets/connector-prompt.js";
import "./settings-connector-strings.js";
const tr = key => t(`connector.${key}`);
export function SettingsConnector() {
  const lease = useLease("settings-connector");
  const [info, setInfo] = useState(null), [error, setError] = useState(false), [app, setApp] = useState("claude");
  const [where, setWhere] = useState("local"), [distro, setDistro] = useState(""), [notice, setNotice] = useState("");
  const read = async () => {
    try {
      const response = await lease.fetch("/api/settings/connector"), value = await response.json();
      if (!response.ok) throw Error("unavailable");
      if (lease.current()) { setInfo(value); setDistro(value.wslDistro || ""); setWhere(value.wsl ? "windows" : "local"); setError(false); }
    } catch { if (lease.current()) setError(true); }
  };
  useEffect(() => { void read(); }, []);
  const name = distro.trim(), validDistro = name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name);
  const resolved = info && { ...info, windows: validDistro ? { command: "wsl.exe", args: ["-d", name, "--", "agend", ...info.local.args] } : info.windows };
  const prompt = resolved ? connectorPrompt(resolved, app, where, tr) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); if (lease.current()) setNotice("copied"); }
    catch { if (lease.current()) setNotice("failed"); }
  };
  return html`<section class="card s-group s-connector" id="connector"><link rel="stylesheet" href="/assets/settings-connector.css" /><div><h3>${tr("title")}</h3><p class="note">${tr("hint")}</p></div>
    <p class="note">${tr("scope")}</p>
    ${error ? html`<button class="btn s-connector-action" type="button" onClick=${read}>${tr("retry")}</button>`
      : !info ? html`<p role="status">${tr("loading")}</p>`
      : !info.supported ? html`<p role="status">${tr("unsupported")}</p>`
      : html`<div class="grid2"><label class="field"><span>${tr("app")}</span><select value=${app} onChange=${event => { setApp(event.target.value); setNotice(""); }}>
        <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="generic">${tr("generic")}</option></select></label>
        ${info.wsl ? html`<label class="field"><span>${tr("location")}</span><select value=${where} onChange=${event => { setWhere(event.target.value); setNotice(""); }}><option value="windows">${tr("windows")}</option><option value="local">${tr("wsl")}</option></select></label>` : null}</div>
        ${info.wsl && where === "windows" && !info.wslDistro ? html`<label class="field"><span>${tr("distro")}</span><input value=${distro} maxLength=${128} onInput=${event => { setDistro(event.target.value); setNotice(""); }} /><small>${tr("distroHint")}</small></label>` : null}
        <p class="note">${tr("noSecrets")}</p><button class="btn s-connector-action" type="button" disabled=${!prompt} onClick=${copy}>${tr("copy")}</button>
        ${notice ? html`<p role="status">${tr(notice)}</p>` : null}
        <details><summary>${tr("config")}</summary><div class="field"><textarea readOnly rows=${12} aria-label=${tr("config")} value=${prompt}></textarea></div></details>`}
  </section>`;
}
