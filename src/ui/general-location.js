// The location is a separate revision-bound Settings operation, never an agent-config patch.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore, guestPage } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { toast } from "/assets/ui-toast.js";
import { confirmedWrite, newKey } from "./settings-confirm.js";
import { ModelSelect } from "./settings-dialogs.js";
register("generalLocation", {
  en: {
    label: "Run General on", host: "This AgEnD host", windows: "Paired Windows PC",
    offline: "General’s Windows PC is offline. AgEnD is still running here. Reconnect that PC, or switch General back to this host in Settings. Pending or uncertain requests will not be sent again automatically.",
    exit: "General was not switched: the previous process has not been confirmed stopped. Reconnect its PC or use the existing stopped-process recovery, then try again. No replacement was started.",
    start: "General’s location was saved, but it could not start. Check Needs you and choose Start or switch back. Its previous conversation is kept; no input was replayed.",
    history: "Host and Windows conversations stay separate. Switching does not copy or merge their history.",
  },
  "zh-TW": {
    label: "General 執行位置", host: "這台 AgEnD 主機", windows: "已配對的 Windows 電腦",
    offline: "General 所在的 Windows 電腦已離線。AgEnD 仍在這台主機運作。請重新連線那台電腦，或到設定把 General 切回這台主機。待處理或結果不明的請求不會自動重送。",
    exit: "General 尚未切換：還無法確認前一個程序已停止。請重新連線那台電腦，或完成現有的程序停止復原，再重試。沒有啟動替代程序。",
    start: "General 的執行位置已儲存，但未能啟動。請查看「等你處理」，選擇啟動或切回原位置。先前的對話已保留，沒有重送輸入。",
    history: "主機與 Windows 各自保留對話，切換時不會複製或合併對話紀錄。",
  },
});
const tr = key => t(`generalLocation.${key}`);
export function GeneralLocation({ name, attentionOnly = false }) {
  const app = useStore(appStore);
  const attentionKey = JSON.stringify((app.needs || []).filter(item => item.generalLocation && (!name || item.instance === name)).map(item => item.id));
  const lease = useLease("general-location"), [data, setData] = useState(null), [error, setError] = useState(null);
  const read = async () => {
    try { const response = await lease.fetch("/api/settings/general-location"); const result = await response.json();
      if (lease.current()) { if (response.ok) { setData(result); setError(null); } else setError(result.error); }
    } catch (err) { if (lease.current()) setError(err.message); }
  };
  useEffect(() => { if (!guestPage()) void read(); }, [name, attentionKey]);
  if (guestPage()) return null;
  // alpha.6 feedback (#3): the same card as the Shared agent settings below it (card s-group: a title and its note, then
  // labelled fields in the grid, then the actions) — not a heading, a bare inline select and a full-width button. A select
  // is as wide as its longest option unless bounded: a paired PC's long name ran the card off the right edge.
  const rows = (data?.generals || []).filter(row => !name || row.name === name);
  return html`<section id="general-location" class="card s-group general-location"><div><h3>${tr("label")}</h3>${!attentionOnly ? html`<p class="note">${tr("history")}</p>` : null}</div>
    ${error ? html`<p role="alert">${error}</p>` : null}
    ${rows.map(row => html`<${LocationRow} key=${row.name + row.revision} row=${row} machines=${data.machines || []} attentionOnly=${attentionOnly} refresh=${read} />`)}
    ${!attentionOnly && !rows.length ? html`<div class="general-location-actions"><button type="button" class="btn btn-sm" onClick=${read}>${t("settings.refresh")}</button></div>` : null}
  </section>`;
}
function LocationRow({ row, machines, attentionOnly, refresh }) {
  const [target, setTarget] = useState("host"), [cli, setCli] = useState("claude-code"), [model, setModel] = useState("");
  const [busy, setBusy] = useState(false), flight = useRef(false);
  const lease = useLease("general-location-row");
  const machine = machines.find(item => item.id === target);
  // The rendered revision stays with this click. Never re-read and silently retry a stale proposal.
  const propose = async next => {
    if (flight.current || !lease.current()) return; flight.current = true; setBusy(true);
    try { const result = await confirmedWrite("/api/settings/general-location", { body: { name: row.name, revision: row.revision, target: next }, key: newKey("general"), label: tr("label") });
      if (lease.current()) { toast(result.body?.message || result.body?.error || t(result.ok ? "app.saved" : "app.failed"), result.ok); await refresh(); }
    } catch (err) { if (lease.current()) toast(err.message, false); }
    finally { flight.current = false; if (lease.current()) setBusy(false); }
  };
  if (attentionOnly && !row.offline && !row.hold) return null;
  const id = `gl-${row.name}`;
  const recover = row.canSwitchBack || row.hold === "start";
  return html`<div class="general-location-row" data-general=${row.name}>
    <p class="general-location-now"><strong>${row.displayName}</strong><span>${row.location === "host" ? tr("host") : `${machines.find(item => item.id === row.machineId)?.name || tr("windows")} · ${row.cli}`}</span></p>
    ${row.offline || row.hold ? html`<p role="alert">${tr(row.hold || "offline")}</p>` : null}
    ${attentionOnly ? html`<p class="note">${tr("history")}</p>` : null}
    ${recover ? html`<div class="general-location-actions">
      ${row.canSwitchBack ? html`<button type="button" class="btn" disabled=${busy || row.switching} onClick=${() => propose({ location: "host" })}>${tr("host")}</button>` : null}
      ${row.hold === "start" ? html`<button type="button" class="btn" disabled=${busy || row.switching} onClick=${() => propose(row.retryTarget || (row.location === "host" ? { location: "host" } : { location: "windows", machineId: row.machineId, cli: row.cli, model: row.model }))}>${t("chat.start")}</button>` : null}
    </div>` : null}
    ${!attentionOnly ? html`<div class="grid2">
      <div class="field"><label for=${`${id}-target`}>${tr("label")}</label><select id=${`${id}-target`} value=${target} disabled=${busy || row.switching} onChange=${e => { setTarget(e.target.value); setModel(""); }}>
        <option value="host">${tr("host")}</option>${machines.map(item => html`<option value=${item.id} disabled=${!item.online}>${item.name}</option>`)}
      </select></div>
      ${target !== "host" ? html`<div class="field"><label for=${`${id}-cli`}>${t("settings.backend")}</label><select id=${`${id}-cli`} value=${cli} onChange=${e => { setCli(e.target.value); setModel(""); }}>
        ${["claude-code", "codex"].map(id => html`<option value=${id} disabled=${!machine?.clis.some(item => item.id === id)}>${id}</option>`)}
      </select></div>` : null}
    </div>
    ${target !== "host" ? html`<${ModelSelect} value=${model} onChange=${setModel} backend=${cli} runtime="windows" machineId=${target} instance=${row.name} />` : null}
    <div class="general-location-actions">
      <button type="button" class="btn btn-sm" onClick=${refresh}>${t("settings.refresh")}</button>
      <button type="button" class="btn btn-primary btn-sm" disabled=${busy || row.switching || target === "host" && !row.canSwitchBack || target !== "host" && (!machine?.online || !machine.clis.some(item => item.id === cli))} onClick=${() => propose(target === "host" ? { location: "host" } : { location: "windows", machineId: target, cli, model })}>${t("settings.save")}</button>
    </div>` : null}
  </div>`;
}
