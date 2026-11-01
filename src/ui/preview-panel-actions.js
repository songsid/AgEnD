// #2911: the preview panel's feedback actions — what a person tells the agent about the page it made (M-2217). The
// panel (preview-panel.js, M-2216's chrome) renders <PanelActions> in its bar, before Download; everything the actions
// do lives here, so neither side edits the other's file.
//
// Nothing here reads or relays the page. A preview's content is the agent's untrusted HTML, so only what the chat
// already holds goes into the message: a #2272 reply to the message the page came in, and the page's <title> or file
// name as one line of plain text in the composer — where the person edits it and sends it themselves. What goes is an
// ordinary message (Discord first): no new channel, nothing sent by itself.

import { html } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { closePanel, htmlTitle } from "./preview-panel.js";

/**
 * The chat registers how to reach its composer (panel-chat.js): { findMsg(instance, msgKey), startReply(instance, msg),
 * clearReply(instance), addToDraft(instance, line), focus() }. null: no chat is mounted, and the actions are not shown.
 */
let chat = null;
export function setPanelFeedback(deps) { chat = deps || null; }

/** The most of a page's title or file name the line carries. */
export const NAME_MAX = 80;

/** One line of plain text: whitespace and control characters collapsed, cut at NAME_MAX characters. */
export function plainName(value) {
  const s = String(value == null ? "" : value).replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").trim();
  const chars = [...s];
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("")}…` : s;
}

/** The composer's line naming the page: its <title>, else the attached file's name, else "this page". */
export function aboutLine(open) {
  if (!open) return "";
  const name = plainName(htmlTitle(open.code || "")) || plainName(open.att && open.att.name);
  return name ? t("chat.pvFbAboutNamed", name) : t("chat.pvFbAboutThis");
}

/**
 * Reply about the open page: a reply to the message it came in (while the thread still has it), and the line naming
 * the page added to the composer (never twice). Returns false when there is nothing to do it with.
 */
export function replyAboutPage(open, deps = chat) {
  if (!open || !deps) return false;
  const msg = open.msgKey ? deps.findMsg(open.instance, open.msgKey) : null;
  // The page's message gone from the thread: no reply — and not one to another message started earlier, which the
  // line naming this page would be sent as (#2913 review).
  if (msg) deps.startReply(open.instance, msg);
  else deps.clearReply(open.instance);
  deps.addToDraft(open.instance, aboutLine(open));
  deps.focus();
  return true;
}

const narrow = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 899px)").matches;

/** The bar's actions for the open page. props: open, name, run, view (as the panel has them). */
export function PanelActions({ open }) {
  if (!open || !chat) return null;
  // On a phone the panel is a sheet over the composer: it closes, so the composer is there to type in.
  const reply = () => { if (narrow()) closePanel(); replyAboutPage(open); };
  return html`<button type="button" class="btn btn-sm pv-fb-reply" title=${t("chat.pvFbReplyTitle")} onClick=${reply}><${Icon} name="chat" size=${14} /><span class="lbl">${t("chat.pvFbReply")}</span></button>`;
}
