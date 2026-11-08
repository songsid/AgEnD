// M-2682 part B: fleet Settings → Hub → "HTML previews on this Hub" (host owner, on a fleet that runs a Hub). The switch and
// port behind hub.web.preview_port, saved and confirmed like the retention card; the server checks the port against the
// Hub's own listeners, this fleet's ports and a free bind before it saves. The Hub reloads to apply it (the runtime's
// reload key includes this setting). Own lazy module with its own words, so an older tab's strings still work.
import { html, useEffect, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubPreview", {
  en: {
    title: "HTML previews on this Hub",
    hint: "When this is on, an HTML page an agent sends in a Hub chat can open as a preview. The Hub serves previews on their own port, which people's browsers must be able to reach.",
    on: "Allow HTML previews", port: "Preview port", portHint: "1–65535, not one of the Hub's or this fleet's own ports.",
    save: "Save previews", saved: "Saved. The Hub reloads to apply it.",
    invalid_port: "Use a whole number from 1 to 65535.",
    port_conflict: "That port is already one of the Hub's or this fleet's own. Pick another.",
    port_in_use: "Something on this computer is already using that port. Pick another.",
    busy: "Another change to the Hub's settings is still finishing. Try again in a moment.",
    failed: "Previews could not be saved. Reload and try again.",
    unavailable: "Previews can be set here once this fleet runs its Hub.",
  },
  "zh-TW": {
    title: "這個 Hub 的 HTML 預覽",
    hint: "開啟後，Agent 在 Hub 對話中傳送的 HTML 頁面可以開成預覽。Hub 用另一個連接埠提供預覽，使用者的瀏覽器必須連得到這個連接埠。",
    on: "允許 HTML 預覽", port: "預覽連接埠", portHint: "1 到 65535，不能是 Hub 或這個 Fleet 自己使用的連接埠。",
    save: "儲存預覽設定", saved: "已儲存。Hub 會重新載入以套用。",
    invalid_port: "請輸入 1 到 65535 的整數。",
    port_conflict: "這個連接埠已經是 Hub 或這個 Fleet 自己在用的，請換一個。",
    port_in_use: "這台電腦上已經有程式在使用這個連接埠，請換一個。",
    busy: "Hub 設定的另一項變更還在完成中，請稍後再試。",
    failed: "無法儲存預覽設定。請重新整理後再試。",
    unavailable: "這個 Fleet 執行自己的 Hub 之後，才能在這裡設定預覽。",
  },
});
const copy = (key) => t(`hubPreview.${key}`);
const REFUSALS = new Set(["invalid_port", "port_conflict", "port_in_use", "busy"]);
const validPort = (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export function HubPreviewSettings() {
  const [view, setView] = useState(null), [on, setOn] = useState(false), [port, setPort] = useState("");
  const [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("");
  const show = (v) => { setView(v); setOn(v.enabled); setPort(v.port !== null ? String(v.port) : v.suggested !== null ? String(v.suggested) : ""); };
  useEffect(() => {
    let live = true;
    api("/api/settings/hub/preview").then((r) => {
      if (!live) return;
      if (r.ok && r.body?.hosted) show(r.body); else setMessageKey("unavailable");
    }, () => { if (live) setMessageKey("unavailable"); });
    return () => { live = false; };
  }, []);
  const changed = view && (on !== view.enabled || (on && String(view.port ?? "") !== port));
  const save = async (e) => {
    e.preventDefault();
    if (!view || busy || !changed || (on && !validPort(port))) return;
    setBusy(true); setMessageKey("");
    try {
      const r = await confirmedWrite("/api/settings/hub/preview", { method: "PUT", label: copy("title"), body: on ? { enabled: true, port: Number(port) } : { enabled: false } });
      if (r.ok && r.body?.ok) { show(r.body); setMessageKey("saved"); }
      else setMessageKey(REFUSALS.has(r.body?.error) ? r.body.error : "failed");
    } catch { setMessageKey("failed"); } finally { setBusy(false); }
  };
  return html`<section class="card hub-preview-settings"><h3>${copy("title")}</h3>
    <p class="note">${copy("hint")}</p>
    ${!view && !messageKey ? html`<${Skeleton} variant="form" lines=${3} />` : null}
    ${view ? html`<form class="form" onSubmit=${save}>
      <label class="check"><input type="checkbox" class="s-ui-toggle" id="hubPreviewOn" checked=${on} disabled=${busy} onChange=${(e) => { setOn(e.target.checked); setMessageKey(""); }} /> ${copy("on")}</label>
      ${on ? html`<label class="field">${copy("port")}<input id="hubPreviewPort" type="number" min="1" max="65535" step="1" inputmode="numeric" value=${port} disabled=${busy}
        onInput=${(e) => { setPort(e.target.value); setMessageKey(""); }} /><small class="note">${copy("portHint")}</small></label>` : null}
      <button class="btn" type="submit" disabled=${busy || !changed || (on && !validPort(port))}>${copy("save")}</button></form>` : null}
    ${messageKey ? html`<p role="status" class=${REFUSALS.has(messageKey) || messageKey === "failed" ? "err" : "note"}>${copy(messageKey)}</p>` : null}
  </section>`;
}
