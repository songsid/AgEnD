// M-3145 (docs/design/hub-fleet-versions.md §4.4; contract M-3144): on a Fleet, a Notices entry about an update this
// Hub's administrator asked for (WebNotice kind "update" with `hubUpdate`): what happened, in the owner's words, by
// state — waiting, done, rolled back, expired, cancelled, failed. {Hub}, {administrator}, the version asked for and,
// after a rollback, the version it is back on. The actions (Update now, Cancel update, the full log) are the request's
// own, bound to its id; they are drawn when the page gives them (`actions`). A notice without `hubUpdate` (anything
// else, or an older Fleet) keeps its plain text.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("noticeHubUpdate", {
  en: {
    waiting: "{1} ({0}) asked to update this Fleet to AgEnD v{2}. It will start when your agents are idle.",
    done: "AgEnD is updated to v{2}, as {1} ({0}) asked.",
    rolledBack: "The update to v{2} did not work. AgEnD is back on v{3}; nothing else changed.",
    expired: "The update {1} ({0}) asked for did not start: your agents were busy for 24 hours. You can update from here when ready.",
    cancelled: "Update cancelled. {1} ({0}) has been told.",
    failed: "The update to v{2} that {1} ({0}) asked for did not finish.",
    updateNow: "Update now", cancelUpdate: "Cancel update", fullLog: "See the full log",
  },
  "zh-TW": {
    waiting: "{1}（{0}）要求把這個 Fleet 更新到 AgEnD v{2}。會等你的 Agent 都閒置才開始。",
    done: "AgEnD 已依 {1}（{0}）的要求更新到 v{2}。",
    rolledBack: "更新到 v{2} 沒有成功。AgEnD 已回到 v{3}，其他都沒有變更。",
    expired: "{1}（{0}）要求的更新沒有開始：你的 Agent 連續 24 小時都在忙。方便時可以從這裡更新。",
    cancelled: "已取消更新，並已通知 {1}（{0}）。",
    failed: "{1}（{0}）要求的 v{2} 更新沒有完成。",
    updateNow: "立即更新", cancelUpdate: "取消更新", fullLog: "看完整紀錄",
  },
});
const tn = (key, ...a) => t(`noticeHubUpdate.${key}`, ...a);
const KEY = { waiting: "waiting", done: "done", "rolled-back": "rolledBack", expired: "expired", cancelled: "cancelled", failed: "failed" };

/** The notice's sentence for its state, or null when it is not one of ours (the page keeps the notice's own text). */
export function hubUpdateNoticeText(hu) {
  const key = hu && KEY[hu.state];
  if (!key) return null;
  return tn(key, hu.hubName || "", hu.requestedBy?.name || hu.requestedBy || "", hu.version || "", hu.currentVersion || "");
}

/** Which of the request's actions a state offers (§4.4): waiting — Update now, Cancel update; expired — Update now; rolled back — the log. */
export function hubUpdateNoticeActions(hu) {
  return hu?.state === "waiting" ? ["updateNow", "cancelUpdate"] : hu?.state === "expired" ? ["updateNow"] : hu?.state === "rolled-back" ? ["fullLog"] : [];
}

/**
 * One notice's body. `actions` (optional): { updateNow(requestId), cancelUpdate(requestId), fullLogHref } from the page —
 * drawn only when given, so a page without them shows the words alone.
 */
export function HubUpdateNotice({ notice, actions = null }) {
  const hu = notice?.hubUpdate, text = hubUpdateNoticeText(hu);
  if (!text) return html`<p class="n-detail notice-text">${notice?.text ?? ""}</p>`;
  const offered = actions ? hubUpdateNoticeActions(hu) : [];
  return html`<p class="n-detail notice-text">${text}</p>
    ${offered.length ? html`<div class="n-actions">${offered.map((a) => a === "fullLog"
      ? (actions.fullLogHref ? html`<a key=${a} class="btn btn-sm btn-ghost" href=${actions.fullLogHref}>${tn("fullLog")}</a>` : null)
      : typeof actions[a] === "function" ? html`<button key=${a} type="button" class=${`btn btn-sm${a === "updateNow" ? " btn-primary" : ""}`} onClick=${() => actions[a](hu.requestId)}>${tn(a)}</button>` : null)}</div>` : null}`;
}
