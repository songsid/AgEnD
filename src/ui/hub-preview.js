// #3226 E: an answer's HTML page in the Hub's side panel — the fleet's own panel (/assets/preview-panel.js: versions,
// pages, Point at it, errors), run at the Hub's own preview address (hub.web.preview_port; the shell's data-preview-*).
// A module of its own: a tab that loaded panel-hub.js or the Hub's words before E keeps them, so E's words come only from
// here. What the fleet's panel has that the Hub has not (Files & changes, Share page) is never loaded here.
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import "/assets/preview.js";
import { claimPanel, closePanel, openMarkdown, openPanel, panelClaims, panelStore, panelVersion, shownKey } from "/assets/preview-panel.js";
import { setPanelFeedback } from "/assets/preview-panel-actions.js";

register("hubPreview", {
  en: {
    confirm: "Allow HTML previews in this browser?\n\nThis applies to this Hub in this browser only. A preview runs the agent's HTML in an isolated frame at the Hub's own preview address. It cannot use your Hub sign-in, but it may be able to send data out, and it can slow or freeze this tab. You still click Preview each time.",
    notOffered: "Previews are not offered on this Hub. You can still download the page.",
    whyOrigin: "Previews are off: this page is at {0}, but the Hub believes it is at {1}.",
    whyOptin: "Previews are off in this browser. Allow them from the card's menu.",
  },
  "zh-TW": {
    confirm: "要在這個瀏覽器允許 HTML 預覽嗎？\n\n只對這個瀏覽器裡的這個 Hub 有效。預覽會在 Hub 自己的預覽位址、一個隔離的框架裡執行 Agent 的 HTML。它用不到你的 Hub 登入，但可能把資料傳出去，也可能讓這個分頁變慢或卡住。每次仍要你按「預覽」才會執行。",
    notOffered: "這個 Hub 不提供預覽。你仍然可以下載這一頁。",
    whyOrigin: "預覽已關閉：這個頁面在 {0}，但 Hub 認為自己在 {1}。",
    whyOptin: "這個瀏覽器沒有允許預覽。可以從卡片的選單允許。",
  },
});
const hp = (key, ...v) => t(`hubPreview.${key}`, ...v);

const P = () => globalThis.AgendPreview;
/** preview.js's words that name the fleet (its settings, "every device where you are signed in") say the Hub's here. */
const OWN = { pvServer_notOffered: "notOffered", pvWhyOrigin: "whyOrigin", pvWhyOptin: "whyOptin" };

let bootedFor = null;   // the document the page's previews were set up for (one per page; a test's pages are several)
/**
 * Once per page: what this Hub's shell said about previews (data-preview-origin/-boot, or why not). An older shell
 * without them gives none — every card then says previews are not offered. The banner's "I understand" lasts for this
 * tab (the Hub has no fleet session handle).
 */
export function bootHubPreview(doc = typeof document !== "undefined" ? document : null) {
  const p = P();
  if (!p || !doc || !doc.body || bootedFor === doc) return;
  bootedFor = doc;
  p.init(doc.body.dataset, { text: (key, ...v) => {
    if (Object.hasOwn(OWN, key)) return hp(OWN[key], ...v);
    const k = `chat.${key}`, s = t(k, ...v);
    return s === k ? null : s;
  } });
  if (typeof p.setBannerScope === "function") p.setBannerScope(null);
}

/** This browser's opt-in for this Hub (its own origin's storage): asks once, in the Hub's words. As the fleet's
 *  setPreviewOptIn: commit(apply) runs the change (the panel's Allow wraps it). Resolves to the choice in force. */
export async function setHubPreviewOptIn(on, commit = (apply) => apply()) {
  const p = P();
  if (!p) return false;
  if (on && !p.optedIn() && !(await confirmDialog({ message: hp("confirm"), confirmLabel: t("chat.pvAllowButton") }))) on = false;
  commit(() => p.setOptIn(on));
  return p.optedIn();
}

/** The HTML as a file (application/octet-stream, never opened), as the fleet's chat saves it. */
export function downloadHtml(code, name) {
  const url = URL.createObjectURL(new Blob([code], { type: "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = typeof name === "string" && name.trim() ? name.trim() : "reply.html"; a.className = "offscreen";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The panel's key for one room: what its cards open the panel under (the fleet uses the instance's name). */
export const roomPanelKey = (roomId) => `hub-room:${roomId}`;

/** The thread's opts.panel for one room: the panel calls, each open put under the room's key. */
export function roomPanelOpts(key) {
  return {
    shown: shownKey, version: panelVersion, claim: claimPanel, claims: panelClaims,
    open: (spec, o) => openPanel({ ...spec, instance: key }, o),
    openMarkdown: (spec) => openMarkdown({ ...spec, instance: key }),
  };
}

/** Whether the panel shows a page of this room now. */
export const panelOpenFor = (key) => { const s = panelStore.get(); return !!(s && s.open && s.open.instance === key); };

/**
 * The panel's "Reply about this page", "Point at it" and errors put their lines in this room's composer. The Hub has
 * no reply-to (one asker, one conversation), so only the lines are added — each once — for the person to edit and
 * send. deps: { findMsg(key), addLine(line), focus() }. Returns the release (called when the room leaves).
 */
export function bindRoomFeedback(deps) {
  const mine = {
    findMsg: (_instance, key) => deps.findMsg(key),
    startReply: () => {}, clearReply: () => {},
    addToDraft: (_instance, line) => deps.addLine(line),
    focus: () => deps.focus(),
  };
  setPanelFeedback(mine);
  return () => { setPanelFeedback(null); if (shownKey() !== null) closePanel(); };
}

/** A line added to a draft, once: on its own line after what is there. */
export const draftWithLine = (d, line) => (!line || d.split("\n").includes(line) ? d : d ? `${d.replace(/\n+$/, "")}\n${line}` : line);
