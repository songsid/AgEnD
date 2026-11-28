// What became of a comment — the status line under it (Fleet › Tasks › a card; docs/design/task-board.md, "Comment status"). A
// comment that was written for an instance (the card's assignee, the recipient chip's choice, an `@name`) says where it stands, in a
// person's words, until the instance has answered: "Sent to test" → "test read it" → "test is working…" → "test replied". When it could not
// be sent it says why (the instance is offline or paused, its task board is off, the loop guard held it, the delivery failed).
// It is read from what the card read carries (`comment.wakes`, only for a session that can write — the board's own record and the
// delivery outbox's state, never a key or the notice's text) and from what the page already knows: the instance's state (the same
// inference as the card's "Running", fleet-task-run.js — an agent is one continuing session, so "working" says it is busy, not that
// it is on this very comment) and the card's comments (a later comment by that instance is its reply). Nothing here is stored.
// Shared with the rest of the page, not new: the status dot's states (`dotState` through `instanceStates`), `Icon`, the page's tags.
// No style attribute anywhere (the CSP).
import { html } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

register("taskwake", {
  en: {
    label: "Where this comment stands", sending: "Sent to {0}", queued: "Waiting for {0} to take it", offline: "{0} is offline — it gets this when it is back",
    paused: "{0} is paused — it gets this when it is resumed", delivered: "Delivered to {0}", read: "{0} read it", working: "{0} is working…", replied: "{0} replied",
    workingTip: "From {0}'s state: an agent is one continuing session, so it may be busy with something else", repliedTip: "Go to {0}'s reply",
    failed: "Could not deliver to {0}", uncertain: "Not sure {0} got it", withdrawn: "The notice to {0} was withdrawn: the card changed again, and {0} hears its new state",
    "skip.board_off": "{0} was not woken: its task board is off", "skip.contact_held": "{0} was not woken: this conversation may not reach another instance on its own",
    "skip.loop_guard": "{0} was not woken: agents have answered each other several times (loop guard) — it wakes again once a person writes",
    "skip.unknown": "There is no instance named {0}, so nobody was woken for it", "skip.cap": "{0} was not woken: an agent's comment wakes only a few instances",
    "skip.wakes_off": "{0} was not woken: comment wakes are switched off for this fleet", "skip.not_waiting": "{0} was not woken: the card no longer waits on it",
    "skip.not_taken": "{0} was not woken: the notice could not be queued", "skip.lost": "The notice to {0} was lost (AgEnD restarted before it was sent)",
    newMark: "New", newTip: "New since you last opened this card",
  },
  "zh-TW": {
    label: "這則留言目前的狀況", sending: "已送給 {0}", queued: "等 {0} 接手", offline: "{0} 離線，上線後就會收到",
    paused: "{0} 已暫停，恢復後就會收到", delivered: "已送達 {0}", read: "{0} 已讀", working: "{0} 處理中…", replied: "{0} 已回覆",
    workingTip: "由 {0} 目前的狀態推論：Agent 只有一個連續的對話，可能在處理別的事", repliedTip: "前往 {0} 的回覆",
    failed: "沒有送達 {0}", uncertain: "無法確認 {0} 是否收到", withdrawn: "給 {0} 的通知已撤回：卡片又有變動，{0} 會從新的通知得知最新狀態",
    "skip.board_off": "沒有叫醒 {0}：它的任務板是關閉的", "skip.contact_held": "沒有叫醒 {0}：這段對話不能直接聯絡其他 Agent",
    "skip.loop_guard": "沒有叫醒 {0}：Agent 之間已連續互相回覆多次（防迴圈），有人留言後才會再叫醒",
    "skip.unknown": "沒有叫 {0} 的 Agent，所以沒有叫醒任何人", "skip.cap": "沒有叫醒 {0}：一則 Agent 留言最多只叫醒幾個 Agent",
    "skip.wakes_off": "沒有叫醒 {0}：這個 fleet 關閉了留言喚醒", "skip.not_waiting": "沒有叫醒 {0}：這張卡已經不需要它處理",
    "skip.not_taken": "沒有叫醒 {0}：通知沒能排入傳送", "skip.lost": "給 {0} 的通知遺失了（送出前 AgEnD 重新啟動）",
    newMark: "新", newTip: "自上次開啟這張卡之後的新留言",
  },
});

/** A status older than this and settled (read, delivered, replied) is no longer worth a line; one that went wrong always is. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
/** A notice that is still on its way (the page reads the card again while any is). */
const MOVING = ["sending", "queued", "delivered"];

/** Each instance's comments on a card (not a person's, not a deleted one), by number — once per timeline, not once per status line. */
const byWriter = new WeakMap();
function writersOf(comments) {
  let index = byWriter.get(comments);
  if (!index) {
    index = new Map();
    for (const c of comments) {
      if (c.type !== "comment" || c.id === undefined || c.deleted || c.by === "person") continue;
      const list = index.get(c.who);
      if (list) list.push(c); else index.set(c.who, [c]);
    }
    for (const list of index.values()) list.sort((a, b) => a.id - b.id);
    byWriter.set(comments, index);
  }
  return index;
}

/** The comment an instance answered with: its first one after this comment (not a person's, not a deleted one), or null. */
export function repliedBy(entry, to, comments) {
  if (!comments || entry.id === undefined) return null;
  const list = writersOf(comments).get(to);
  if (!list) return null;
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].id <= entry.id) lo = mid + 1; else hi = mid; }
  return list[lo] || null;
}

/**
 * The lines under one comment (pure: tests import it), one per instance it was written for: `{ key, to, tone, text, tip?, replyId? }`.
 * `tone`: `wait` (on its way), `ok` (taken), `busy` (working), `done` (replied), `bad` (not sent), `muted` (withdrawn).
 * `entry`: the timeline's comment (`wakes` as the card read carried them); `comments`: the card's timeline comments; `states`: the
 * instances' dot states by name (`instanceStates`); `now`: epoch ms.
 */
export function wakeLines(entry, comments, states, now = Date.now()) {
  if (!entry || entry.deleted || !Array.isArray(entry.wakes)) return [];
  const fresh = now - (Date.parse(entry.at) || 0) < FRESH_MS;
  const out = [];
  for (const w of entry.wakes) {
    const to = w.to;
    const key = `${entry.id}:${to}`;
    const state = states && states.get ? states.get(to) : undefined;
    const reply = w.state === "skipped" || w.state === "failed" || w.state === "uncertain" || w.state === "withdrawn" || w.state === "unknown" || w.state === "sending" ? null : repliedBy(entry, to, comments);
    if (w.state === "unknown") continue;
    if (w.state === "skipped") { out.push({ key, to, tone: "bad", text: t(`taskwake.skip.${w.skip}`, to) }); continue; }
    if (w.state === "failed") { out.push({ key, to, tone: "bad", text: t("taskwake.failed", to) }); continue; }
    if (w.state === "uncertain") { out.push({ key, to, tone: "bad", text: t("taskwake.uncertain", to) }); continue; }
    if (w.state === "withdrawn") { if (fresh) out.push({ key, to, tone: "muted", text: t("taskwake.withdrawn", to) }); continue; }
    if (reply) { if (fresh) out.push({ key, to, tone: "done", text: t("taskwake.replied", to), tip: t("taskwake.repliedTip", to), replyId: reply.id }); continue; }
    if (w.state === "sending") { out.push({ key, to, tone: "wait", text: t("taskwake.sending", to) }); continue; }
    if (w.state === "queued") {
      const gone = state === "stopped" || state === "crashed";
      out.push({ key, to, tone: "wait", text: gone ? t("taskwake.offline", to) : state === "paused" ? t("taskwake.paused", to) : t("taskwake.queued", to) });
      continue;
    }
    // Delivered, or read: busy while the instance is working (the card's "Running" inference); otherwise where it stands.
    if (state === "working") { out.push({ key, to, tone: "busy", text: t("taskwake.working", to), tip: t("taskwake.workingTip", to) }); continue; }
    if (!fresh) continue;
    out.push({ key, to, tone: "ok", text: t(w.state === "read" ? "taskwake.read" : "taskwake.delivered", to) });
  }
  return out;
}

/** Whether any comment of the card has a notice still on its way, so that the page reads the card again soon (the stream's ping is the first way, this the second). */
export function wakesMoving(detail, now = Date.now()) {
  for (const e of (detail && detail.comments) || []) {
    if (e.deleted || !Array.isArray(e.wakes) || now - (Date.parse(e.at) || 0) > 3 * 60_000) continue;
    if (e.wakes.some((w) => MOVING.includes(w.state))) return true;
  }
  return false;
}

/** The names a card's comments were written for, for the page to read the instances' states of. */
export function wakeNames(detail) {
  const names = new Set();
  for (const e of (detail && detail.comments) || []) for (const w of e.wakes || []) names.add(w.to);
  return [...names];
}

const ICON = { wait: "clock", ok: "check", busy: "clock", done: "check", bad: "alert", muted: "info" };

/** The status line(s) under a comment; nothing when it was written for nobody. */
export function WakeStatus({ entry, comments, states, onOpen }) {
  const lines = wakeLines(entry, comments, states);
  if (!lines.length) return null;
  return html`<ul class="tl-wakes" aria-label=${t("taskwake.label")}>${lines.map((l) => html`<li key=${l.key} class=${`tl-wake wk-${l.tone}`} title=${l.tip || undefined}>
    <${Icon} name=${ICON[l.tone]} size=${13} cls=${l.tone === "busy" ? "wk-spin" : ""} />
    ${l.replyId !== undefined && onOpen ? html`<button type="button" class="tb-link" onClick=${() => onOpen(l.replyId)}>${l.text}</button>` : html`<span>${l.text}</span>`}</li>`)}</ul>`;
}
