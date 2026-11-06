// Pure lazy owner Settings while off. Hub clients/pairing UI load only after a saved on state and a member page mark.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubMembership", {
  en: {
    title: "Hub membership", enabled: "Allow this fleet to connect to a Hub",
    hint: "Off by default. Enabling does not pair a Hub or share an agent; choose those separately below.",
    off: "Turning this off stops new Hub work and answer disclosure. Existing agent conversations remain.",
    loading: "Reading membership settings…", pending: "Waiting for owner confirmation…",
    failed: "The membership change could not be verified. Check again before trying another change.",
    unavailable: "Membership settings are unavailable. Open this fleet's own owner Settings and check again.",
    retry: "Check again", reload: "Reload page", reloadHint: "Reload the page to refresh the Hub controls.",
  },
  "zh-TW": {
    title: "Hub 成員功能", enabled: "允許這個艦隊連線至 Hub",
    hint: "預設關閉。啟用不會自動配對 Hub 或分享代理；請在下方另外選擇。",
    off: "關閉後會停止新的 Hub 工作與回答傳送，既有代理對話會保留。",
    loading: "正在讀取成員設定…", pending: "等待擁有者確認…",
    failed: "無法確認成員設定是否已變更。請再次檢查，再嘗試其他變更。",
    unavailable: "目前無法使用成員設定。請開啟這個艦隊自己的擁有者設定頁面，再次檢查。",
    retry: "再次檢查", reload: "重新整理頁面", reloadHint: "請重新整理頁面以更新 Hub 控制項。",
  },
});
const copy = key => t(`hubMembership.${key}`);
const path = "/api/settings/hub/membership";
const markedMember = () => String(globalThis.document?.body?.dataset?.hub || "").split(/\s+/).includes("member");
export function HubMembershipSettings() {
  const publicPage = globalThis.document?.body?.dataset?.publicLink === "1";
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("loading");
  const [Connect, setConnect] = useState(null);
  const owner = useRef({ mounted: true, seq: 0, busy: false });
  const read = async () => {
    const seq = ++owner.current.seq;
    let result; try { result = await api(path); } catch { result = null; }
    if (!owner.current.mounted || owner.current.seq !== seq) return;
    if (result?.ok && typeof result.body?.enabled === "boolean") { setView({ enabled: result.body.enabled }); setMessageKey(""); }
    else { setView(null); setMessageKey("unavailable"); }
  };
  useEffect(() => {
    owner.current.mounted = true;
    if (!publicPage) read();
    return () => { owner.current.mounted = false; owner.current.seq++; };
  }, [publicPage]);
  useEffect(() => {
    let live = true;
    if (!publicPage && view?.enabled && markedMember()) import("./settings-hub.js").then(m => { if (live) setConnect(() => m.HubConnectCard); }, () => {});
    return () => { live = false; };
  }, [publicPage, view?.enabled]);
  const change = async enabled => {
    if (publicPage || !view || owner.current.busy) return;
    owner.current.busy = true; owner.current.seq++; setBusy(true); setMessageKey("");
    try {
      const result = await confirmedWrite(path, { method: "PUT", body: { enabled }, label: copy("title"),
        onPending: () => { if (owner.current.mounted) setMessageKey("pending"); } });
      if (!owner.current.mounted) return;
      if (result.ok) await read();
      else { setView(null); setMessageKey("failed"); }
    } catch { if (owner.current.mounted) { setView(null); setMessageKey("failed"); } }
    finally { owner.current.busy = false; if (owner.current.mounted) setBusy(false); }
  };
  if (publicPage) return null;
  return html`<div class="form hub-membership-settings"><section class="card">
    <h3>${copy("title")}</h3><p class="note">${copy("hint")}</p>
    <label class="check"><input class="s-ui-toggle" type="checkbox" role="switch" checked=${view?.enabled === true}
      disabled=${!view || busy} onChange=${e => change(e.target.checked)} /><span>${copy("enabled")}</span></label>
    <p class="note">${copy("off")}</p>
    ${messageKey ? html`<p role="status">${copy(messageKey)}</p>` : null}
    ${!view && !busy && messageKey !== "loading" ? html`<button class="btn btn-sm" type="button" onClick=${read}>${copy("retry")}</button>` : null}
    ${view && view.enabled !== markedMember() ? html`<p class="note">${copy("reloadHint")} <button class="btn btn-sm" type="button" disabled=${busy} onClick=${() => location.reload()}>${copy("reload")}</button></p>` : null}
  </section>${view?.enabled && markedMember() && Connect ? html`<${Connect} />` : null}</div>`;
}
