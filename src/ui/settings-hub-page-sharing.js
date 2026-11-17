import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";

register("hubPageSharing", {
  en: {
    title: "Sharing from the Hub", switch: "Let me share agents from the Hub page",
    hint: "When on, this Fleet sends the Hub your agents' names and descriptions, which only you can see there, and applies a share or stop you make on the Hub page without asking again. A notice with Undo is posted here each time.",
    pending: "Waiting for owner confirmation…", unavailable: "This setting is unavailable. Check again.",
    unknown: "The change is not confirmed. Check the saved setting before trying again.", retry: "Check again",
  },
  "zh-TW": {
    title: "從 Hub 分享", switch: "允許我從 Hub 頁面分享 Agent",
    hint: "開啟後，這個 Fleet 會把你的 Agent 名稱與說明傳給 Hub（在 Hub 上只有你看得到），並直接套用你在 Hub 頁面做的分享或停止，不再另外確認。每次都會在這裡發出可以復原的通知。",
    pending: "等待擁有者確認…", unavailable: "目前無法使用這個設定，請再次檢查。",
    unknown: "尚未確認變更，請先檢查儲存的設定再試一次。", retry: "再次檢查",
  },
});
const copy = key => t(`hubPageSharing.${key}`);
const path = "/api/settings/hub/share-from-hub";
export function HubPageSharingSettings() {
  const [enabled, setEnabled] = useState(null), [busy, setBusy] = useState(false), [phase, setPhase] = useState("");
  const owner = useRef({ live: true, seq: 0, busy: false });
  const read = async () => {
    const seq = ++owner.current.seq;
    let result; try { result = await api(path); } catch { result = null; }
    if (!owner.current.live || owner.current.seq !== seq) return;
    if (result?.ok && typeof result.body?.enabled === "boolean") { setEnabled(result.body.enabled); setPhase(""); }
    else { setEnabled(null); setPhase("unavailable"); }
  };
  useEffect(() => { owner.current.live = true; void read(); return () => { owner.current.live = false; owner.current.seq++; }; }, []);
  const change = async value => {
    if (enabled === null || owner.current.busy) return;
    owner.current.busy = true; owner.current.seq++; setBusy(true); setPhase("");
    try {
      const result = await confirmedWrite(path, { method: "PUT", body: { enabled: value }, resendable: true, label: copy("title"),
        onPending: () => { if (owner.current.live) setPhase("pending"); } });
      if (!owner.current.live) return;
      if (result.ok) await read();
      else { setEnabled(null); setPhase("unknown"); }
    } catch { if (owner.current.live) { setEnabled(null); setPhase("unknown"); } }
    finally { owner.current.busy = false; if (owner.current.live) setBusy(false); }
  };
  return html`<div class="hub-update-consent">
    <label class="check hub-update-switch"><input class="s-ui-toggle" type="checkbox" role="switch" id="hubShareFromHub"
      checked=${enabled === true} disabled=${enabled === null || busy} aria-describedby="hubShareFromHub-note"
      onChange=${event => { void change(event.target.checked); }} /><span>${copy("switch")}</span></label>
    <p class="note" id="hubShareFromHub-note">${copy("hint")}</p>
    ${phase ? html`<p role="status">${copy(phase)}</p>` : null}
    ${enabled === null && !busy && phase ? html`<button class="btn btn-sm" type="button" onClick=${read}>${copy("retry")}</button>` : null}
  </div>`;
}
