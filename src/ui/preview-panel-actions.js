// #2911: the preview panel's feedback actions — what a person tells the agent about the page it made (M-2217). The
// panel (preview-panel.js, M-2216's chrome) renders <PanelActions> in its bar, before Download; everything the actions
// do lives here, so neither side edits the other's file.
//
// Nothing here reads or relays the page. A preview's content is the agent's untrusted HTML, so only what the chat
// already holds goes into the message: a #2272 reply to the message the page came in, and the page's <title> or file
// name as one line of plain text in the composer — where the person edits it and sends it themselves. What goes is an
// ordinary message (Discord first): no new channel, nothing sent by itself.

import { html, useEffect, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { closePanel, frameKey, htmlTitle } from "./preview-panel.js";

const P = () => globalThis.AgendPreview;

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

/**
 * #2911: the lines the errors chip adds — a header saying the text below is the page's, then each kept error quoted
 * ("> "), already one line of plain text (preview.js), and how many more there were. `log`: P().errors(key).
 */
export function errorLines(log) {
  if (!log || !log.count) return [];
  const kind = { error: "", rejection: t("chat.pvFbErrRejection"), console: "console.error: " };
  const lines = [t(log.count === 1 ? "chat.pvFbErrHeadOne" : "chat.pvFbErrHead", String(log.count))];
  for (const x of log.items) lines.push(`> ${kind[x.kind] ?? ""}${plainName(x.message)}${x.line ? ` (${t("chat.pvFbErrAt", String(x.line), String(x.col))})` : ""}`);
  const more = log.count - log.items.length;
  if (more > 0) lines.push(t("chat.pvFbErrMore", String(more)));
  return lines;
}

/** The errors chip's click: reply about the page, then the error lines (each once) — the person edits and sends. */
export function sendErrors(open, log, deps = chat) {
  if (!replyAboutPage(open, deps)) return false;
  for (const line of errorLines(log)) deps.addToDraft(open.instance, line);
  deps.focus();
  return true;
}

/**
 * #2911: the line a picked element adds — where in the page (the selector the page's frame built, as code) and its
 * words, marked as the page's text. Backticks are taken out of the selector so it stays one code span.
 */
export function pickLine(result) {
  if (!result) return "";
  const where = plainName(String(result.selector || "").replace(/`/g, "")) || "?";
  const words = plainName(result.text);
  return words ? t("chat.pvFbPickWords", where, words) : t("chat.pvFbPickAt", where);
}

/** A picked element: reply about the page, then its line — the person writes what to change after it. */
export function sendPick(open, result, deps = chat) {
  if (!result || !replyAboutPage(open, deps)) return false;
  deps.addToDraft(open.instance, pickLine(result));
  deps.focus();
  return true;
}

/** Whether the open page's frame is in pick mode, and its answer handed to sendPick. */
function usePick(open) {
  const key = open ? frameKey(open.key) : null;
  const [on, setOn] = useState(() => !!(key && P() && P().picking && P().picking(key)));
  useEffect(() => {
    setOn(!!(key && P() && P().picking && P().picking(key)));
    if (!key || !P() || typeof P().onPick !== "function") return undefined;
    return P().onPick((k, result, now) => {
      if (k !== key) return;
      setOn(!!now);
      if (result) { if (narrow()) closePanel(); sendPick(open, result); }
    });
  }, [key]);
  return on;
}

/** The errors the open page's frame reported, re-read when they change. */
function useErrors(open) {
  const key = open ? frameKey(open.key) : null;
  const read = () => (key && P() && typeof P().errors === "function" ? P().errors(key) : null);
  const [log, setLog] = useState(read);
  useEffect(() => {
    setLog(read());
    if (!key || !P() || typeof P().onErrors !== "function") return undefined;
    return P().onErrors((k) => { if (k === key) setLog(read()); });
  }, [key]);
  return log;
}

const narrow = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 899px)").matches;

/** The bar's actions for the open page. props: open, name, run, view (as the panel has them). */
export function PanelActions({ open, run }) {
  const log = useErrors(open);
  const picking = usePick(open);
  if (!open || !chat) return null;
  // On a phone the panel is a sheet over the composer: it closes, so the composer is there to type in.
  const reply = () => { if (narrow()) closePanel(); replyAboutPage(open); };
  const send = () => { const now = P().errors(frameKey(open.key)); if (narrow()) closePanel(); sendErrors(open, now); };
  const n = log ? log.count : 0;
  const key = open && frameKey(open.key);
  const canPick = run && run.state === "running" && typeof P().pick === "function";
  const point = () => { P().pick(key, !picking); };
  return html`${canPick ? html`<button type="button" class=${`btn btn-sm pv-fb-pick${picking ? " on" : ""}`} aria-pressed=${picking ? "true" : "false"}
      title=${t(picking ? "chat.pvFbPickCancelTitle" : "chat.pvFbPickTitle")} onClick=${point}><${Icon} name="edit" size=${14} /><span class="lbl">${t(picking ? "chat.pvFbPickCancel" : "chat.pvFbPick")}</span></button>` : null}${n ? html`<button type="button" class="btn btn-sm pv-fb-errors" title=${t("chat.pvFbErrTitle")} onClick=${send}><${Icon} name="alert" size=${14} /><span class="pv-fb-n">${n >= P().ERRORS.maxCount ? `${n}+` : String(n)}</span><span class="lbl">${t(n === 1 ? "chat.pvFbErrOne" : "chat.pvFbErrMany")}</span></button>` : null}<button type="button" class="btn btn-sm pv-fb-reply" title=${t("chat.pvFbReplyTitle")} onClick=${reply}><${Icon} name="chat" size=${14} /><span class="lbl">${t("chat.pvFbReply")}</span></button>`;
}
