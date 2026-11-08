// M-2682 (leader, cid-hubname-ui): fleet Settings → Hub → "Run this Hub" (host owner, on a fleet with an initialized Hub).
// The switch behind hub.enabled, saved and confirmed like the retention card. Stopping the Hub signs everyone out of it and
// stops every shared agent's chats there, so turning it off asks once first (the shared confirmation, as for a restart);
// turning it on doesn't. Own lazy module with its own words, so an older tab's strings still work.
import { html, useEffect, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubRun", {
  en: {
    title: "Run this Hub", on: "This Hub is running",
    hint: "When this is off, the Hub stops: nobody can sign in to it, and chats with shared agents wait until it runs again. Its settings, people and records are kept.",
    stopTitle: "Stop this Hub?", stopAsk: "Everyone signed in to the Hub is signed out, and chats with shared agents stop until you turn it on again. Nothing is deleted.",
    stopGo: "Stop the Hub", saved_on: "The Hub is starting.", saved_off: "The Hub is stopped.",
    busy: "Another change to the Hub's settings is still finishing. Try again in a moment.",
    failed: "The change could not be saved. Reload and try again.",
    unavailable: "This switch applies once this fleet's Hub is set up.",
  },
  "zh-TW": {
    title: "執行這個 Hub", on: "這個 Hub 正在執行",
    hint: "關閉後 Hub 會停止：沒有人能登入，與分享的 Agent 的對話會暫停，直到再次開啟。設定、人員和紀錄都會保留。",
    stopTitle: "要停止這個 Hub 嗎？", stopAsk: "所有登入 Hub 的人都會被登出，與分享的 Agent 的對話會暫停，直到你再次開啟。不會刪除任何資料。",
    stopGo: "停止 Hub", saved_on: "Hub 正在啟動。", saved_off: "Hub 已停止。",
    busy: "Hub 設定的另一項變更還在完成中，請稍後再試。",
    failed: "無法儲存這項變更。請重新整理後再試。",
    unavailable: "這個 Fleet 的 Hub 設定完成後，才能使用這個開關。",
  },
});
const copy = (key) => t(`hubRun.${key}`);

export function HubRunSettings() {
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("");
  useEffect(() => {
    let live = true;
    api("/api/settings/hub/run").then((r) => {
      if (!live) return;
      if (r.ok && r.body?.initialized) setView(r.body); else setMessageKey("unavailable");
    }, () => { if (live) setMessageKey("unavailable"); });
    return () => { live = false; };
  }, []);
  const toggle = async (e) => {
    const on = e.target.checked;
    e.target.checked = !on;                         // the saved state stays shown until the save answers
    if (!view || busy) return;
    if (!on && !(await confirmDialog({ title: copy("stopTitle"), message: copy("stopAsk"), confirmLabel: copy("stopGo"), danger: true }))) return;
    setBusy(true); setMessageKey("");
    try {
      const r = await confirmedWrite("/api/settings/hub/run", { method: "PUT", label: copy("title"), body: { enabled: on } });
      if (r.ok && r.body?.ok) { setView(r.body); setMessageKey(r.body.enabled ? "saved_on" : "saved_off"); }
      else setMessageKey(r.body?.error === "busy" ? "busy" : "failed");
    } catch { setMessageKey("failed"); } finally { setBusy(false); }
  };
  return html`<section class="card hub-run-settings"><h3>${copy("title")}</h3>
    <p class="note">${copy("hint")}</p>
    ${!view && !messageKey ? html`<${Skeleton} variant="form" lines=${2} />` : null}
    ${view ? html`<label class="check"><input type="checkbox" class="s-ui-toggle" id="hubRunOn" checked=${view.enabled} disabled=${busy} onChange=${toggle} /> ${copy("on")}</label>` : null}
    ${messageKey ? html`<p role="status" class=${messageKey === "busy" || messageKey === "failed" ? "err" : "note"}>${copy(messageKey)}</p>` : null}
  </section>`;
}
