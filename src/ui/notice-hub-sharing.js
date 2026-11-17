import { html, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import * as updates from "/assets/app-update.js";
register("noticeHubSharing", {
  en: {
    "reason_not-owner": "The connected owner changed.",
    "reason_switched-off": "Sharing from the Hub page is turned off in this Fleet's Settings → Hub.",
    "reason_stale-list": "It changed after this list was shown. Refresh to check.",
    "reason_not-shareable": "This agent can't answer Hub questions.",
    "reason_limit": "This Fleet already shares 64 agents, the most allowed.",
    "reason_not-allowed": "The Hub hasn't allowed this share.",
    "reason_unknown-agent": "This agent is no longer available.",
    "reason_expired": "This request expired.",
    "reason_unavailable": "The Fleet could not confirm this change.",
    undoneBy: "A Fleet administrator undid this request.",
    pending: "{0} asked to change sharing with {1} from the Hub page. The result is not confirmed yet.",
    shared: "{0} shared {1} with {2} from the Hub page. Nobody can ask until {0} chooses who may ask.",
    stopped: "{0} stopped sharing {1} with {2} from the Hub page.",
    undoneShare: "{0}: no longer shared.", undoneStop: "{0}: shared again.", changed: "{0}: skipped because it changed or could not be restored.",
    refused: "{0}: not changed ({1}).", undo: "Undo", undoPending: "Not confirmed yet. Refresh Notices to check.",
    expired: "This can no longer be undone here. Use Settings → Hub.", done: "Undone. The notice shows which agents changed.",
    classic: "Hub questions and answers are not posted in its Discord or Telegram room, and the room's chat is not copied to the Hub. It is one agent with one memory: it may use what it learned in the room when it answers here.",
  },
  "zh-TW": {
    "reason_not-owner": "已連接的擁有者已變更。",
    "reason_switched-off": "這個 Fleet 的「設定 → Hub」關閉了從 Hub 頁面分享。",
    "reason_stale-list": "顯示名單之後，狀態已變更，請重新整理確認。",
    "reason_not-shareable": "這個 Agent 目前無法回答 Hub 的提問。",
    "reason_limit": "這個 Fleet 已經分享 64 個 Agent，達到上限。",
    "reason_not-allowed": "Hub 尚未允許這次分享。",
    "reason_unknown-agent": "這個 Agent 已無法使用。",
    "reason_expired": "這次要求已到期。",
    "reason_unavailable": "Fleet 無法確認這次變更。",
    undoneBy: "Fleet 管理員已復原這次變更。",
    pending: "{0} 從 Hub 頁面要求變更與 {1} 的分享，還沒有確認結果。",
    shared: "{0} 從 Hub 頁面把 {1} 分享到 {2}。在 {0} 選擇誰可以問之前，沒有人可以問它。",
    stopped: "{0} 從 Hub 頁面停止把 {1} 分享到 {2}。",
    undoneShare: "{0}：不再分享。", undoneStop: "{0}：已重新分享。", changed: "{0}：狀態已變更或無法還原，已略過。",
    refused: "{0}：沒有變更（{1}）。", undo: "復原", undoPending: "還沒有確認，請重新整理「通知」確認。",
    expired: "已經無法在這裡復原，請到「設定 → Hub」。", done: "已復原，通知會顯示哪些 Agent 已變更。",
    classic: "Hub 的提問與回答不會貼到它的 Discord 或 Telegram 房間，房間的聊天也不會複製到 Hub。但它是同一個 Agent、同一份記憶：在這裡回答時，可能用到它在房間裡得知的內容。",
  },
});
const tn = (key, ...args) => t(`noticeHubSharing.${key}`, ...args);
export function hubSharingLines(value) {
  if (!value || !Array.isArray(value.rows)) return [];
  if (value.state === "pending") return [tn("pending", value.byName, value.hubName)];
  const shared = value.rows.filter(row => row.state === "shared").map(row => row.name), stopped = value.rows.filter(row => row.state === "stopped").map(row => row.name);
  const lines = [value.state === "undone" ? tn("undoneBy") : null, shared.length ? tn("shared", value.byName, shared.join(", "), value.hubName) : null,
    stopped.length ? tn("stopped", value.byName, stopped.join(", "), value.hubName) : null].filter(Boolean);
  for (const row of value.rows) {
    if (row.state === "undone") lines.push(tn(row.action === "share" ? "undoneShare" : "undoneStop", row.name));
    if (row.state === "refused") lines.push(tn("refused", row.name, tn(`reason_${row.code || "unavailable"}`)));
    if (row.state === "changed") lines.push(tn("changed", row.name));
  }
  if (value.rows.some(row => row.kind === "classic-room" && row.action === "share" && row.state === "shared")) lines.push(tn("classic"));
  return lines;
}
export function HubSharingNotice({ notice }) {
  const value = notice?.hubSharing;
  const [busy, setBusy] = useState(false), [latest, setLatest] = useState(null), [feedback, setFeedback] = useState("");
  const update = updates.updateStore ? useStore(updates.updateStore) : null;
  const shown = latest || value;
  const undo = async () => {
    if (busy) return; setBusy(true); setFeedback("");
    try {
      const response = await fetch(`/api/settings/hub/sharing-notices/${encodeURIComponent(value.key)}/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (response.status === 200) { setLatest(result); }
      else setFeedback(response.status === 409 && result?.error === "expired" ? "expired" : "undoPending");
    } catch { setFeedback("undoPending"); }
    finally { setBusy(false); }
  };
  const expired = !shown || Date.now() >= shown.undoUntil;
  const offered = (shown?.state === "complete" || shown?.state === "undoing") && shown.rows.some(row => row.state === "shared" || row.state === "stopped");
  return html`<div class="n-detail notice-text">${hubSharingLines(shown).map((line, index) => html`<p key=${index}>${line}</p>`)}</div>
    ${offered && update?.info?.admin === true ? expired ? html`<p class="note">${tn("expired")}</p>`
      : html`<div class="n-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${undo}>${tn("undo")}</button></div>` : null}
    ${feedback ? html`<p class="note" role="status">${tn(feedback)}</p>` : null}`;
}
