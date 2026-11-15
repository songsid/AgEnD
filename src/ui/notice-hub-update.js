// M-3145 (docs/design/hub-fleet-versions.md §4.4; contract M-3144): on a Fleet, a Notices entry about an update this
// Hub's administrator asked for (WebNotice kind "update" with `hubUpdate`): what happened, in the owner's words, by
// state — waiting, done, rolled back, expired, cancelled, failed. {Hub}, {administrator}, the version asked for and,
// after a rollback, the version it is back on. The actions (Update now, Cancel update, the full log) are the request's
// own, bound to its id; they are drawn when the page gives them (`actions`; the Notices page gives
// `hubUpdateActions()` to an admin). A notice without `hubUpdate` (anything else, or an older Fleet) keeps its plain text.
// The Fleet routes (M-3144 #3963): GET /api/settings/hub/fleet-updates/:id, POST …/:id/cancel {}, and
// POST /ui/update/start { hubRequestId } (in app-update.js, which rereads the request first: a notice is not authority).
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { useStore } from "/assets/app-store.js";
// A namespace import: a tab still holding an older app-update.js lacks these, and must not fail the Notices page.
import * as updates from "/assets/app-update.js";

register("noticeHubUpdate", {
  en: {
    waiting: "{1} ({0}) asked to update this Fleet to AgEnD v{2}. It will start when your agents are idle.",
    done: "AgEnD is updated to v{2}, as {1} ({0}) asked.",
    rolledBack: "The update to v{2} did not work. AgEnD is back on v{3}; nothing else changed.",
    expired: "The update {1} ({0}) asked for did not start: your agents were busy for 24 hours. You can update from here when ready.",
    cancelled: "Update cancelled. The result will be reported to {1} ({0}).",
    failed: "The update to v{2} that {1} ({0}) asked for did not finish.",
    updateNow: "Update now", cancelUpdate: "Cancel update", fullLog: "See the full log",
    cancelledToast: "Update cancelled.", cancelRunning: "The update has already started and can't be cancelled.",
    cancelFailed: "The update was not cancelled. Try again.",
  },
  "zh-TW": {
    waiting: "{1}（{0}）要求把這個 Fleet 更新到 AgEnD v{2}。會等你的 Agent 都閒置才開始。",
    done: "AgEnD 已依 {1}（{0}）的要求更新到 v{2}。",
    rolledBack: "更新到 v{2} 沒有成功。AgEnD 已回到 v{3}，其他都沒有變更。",
    expired: "{1}（{0}）要求的更新沒有開始：你的 Agent 連續 24 小時都在忙。方便時可以從這裡更新。",
    cancelled: "已取消更新，結果會回報給 {1}（{0}）。",
    failed: "{1}（{0}）要求的 v{2} 更新沒有完成。",
    updateNow: "立即更新", cancelUpdate: "取消更新", fullLog: "看完整紀錄",
    cancelledToast: "已取消更新。", cancelRunning: "更新已經開始，無法取消。",
    cancelFailed: "沒有取消更新，請再試一次。",
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

/** Cancel update: the Fleet's own copy of the request, by its id; an update already running answers 409 update_running. */
export async function cancelHubRequestedUpdate(requestId) {
  let r = null, body = null;
  try {
    r = await fetch(`/api/settings/hub/fleet-updates/${encodeURIComponent(String(requestId || ""))}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    try { body = await r.json(); } catch { body = null; }
  } catch { r = null; }
  if (r && r.ok) { toast(tn("cancelledToast")); return { ok: true }; }
  toast(tn(r && r.status === 409 && body?.error === "update_running" ? "cancelRunning" : "cancelFailed"), false);
  return { ok: false };
}

/**
 * The actions the Notices page gives an admin: Update now (app-update.js asks and starts it by the request's id), Cancel
 * update, the full log. Null on a tab whose app-update.js is older than these (the words alone).
 */
export function hubUpdateActions() {
  if (typeof updates.openHubRequestedUpdate !== "function") return null;
  return { updateNow: (hu) => updates.openHubRequestedUpdate(hu), cancelUpdate: (hu) => cancelHubRequestedUpdate(hu.requestId),
    fullLog: typeof updates.openUpdateLog === "function" ? () => updates.openUpdateLog() : null };
}

/** For the Notices page: the actions, to an admin of this Fleet only (the routes are an admin's; others see the words). */
export function useHubUpdateActions() {
  const st = updates.updateStore ? useStore(updates.updateStore) : null;   // static per load: the hook order never changes
  return st?.info?.admin === true ? hubUpdateActions() : null;
}

/**
 * One notice's body. `actions` (optional): { updateNow(hubUpdate), cancelUpdate(hubUpdate), fullLog() } —
 * drawn only when given, so a page without them shows the words alone.
 */
export function HubUpdateNotice({ notice, actions = null }) {
  const hu = notice?.hubUpdate, text = hubUpdateNoticeText(hu);
  if (!text) return html`<p class="n-detail notice-text">${notice?.text ?? ""}</p>`;
  const offered = actions ? hubUpdateNoticeActions(hu) : [];
  return html`<p class="n-detail notice-text">${text}</p>
    ${offered.some((a) => typeof actions[a] === "function") ? html`<div class="n-actions">${offered.map((a) => typeof actions[a] !== "function" ? null
      : html`<button key=${a} type="button" class=${`btn btn-sm${a === "updateNow" ? " btn-primary" : a === "fullLog" ? " btn-ghost" : ""}`} onClick=${() => actions[a](hu)}>${tn(a)}</button>`)}</div>` : null}`;
}
