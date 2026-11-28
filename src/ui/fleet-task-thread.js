// Comment threads on a card's page (Fleet › Tasks › a card; docs/design/task-board.md, "Comment threads"): what each comment of
// the activity stream offers — reply, react, edit, resolve a thread, copy, copy link, delete — as an issue tracker's comment
// menu does, and the recipient chip under the comment box (who a comment is for).
// Shared with the rest of the page, not new: the app's `Menu` (the ⋯ and the chip's list, `ui-menu.js`), the chat's reaction chip
// and quick picker (`.msg-reactions .reaction`, `QUICK_REACTIONS` of chat-thread.js), the chat's Markdown (`MdBody`), `confirmDialog`
// and `toast`. The rules themselves are the board's (scheduler/task-board.ts); this module only asks and shows — a refusal is
// said in the page's words (`tasks.err.*`). No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { QUICK_REACTIONS } from "/assets/chat-thread.js";

register("taskthread", {
  en: {
    reply: "Reply", react: "Add reaction", edit: "Edit", resolve: "Resolve thread", reopen: "Reopen thread", copy: "Copy", copyLink: "Copy link", delete: "Delete",
    more: "Comment actions", copied: "Copied", linkCopied: "Link to the comment copied", copyFailed: "Could not copy",
    edited: "edited", editedTip: "Edited {0}", save: "Save", cancel: "Cancel", editHint: "Ctrl+Enter saves · Esc drops the change", editLabel: "Edit the comment",
    deleted: "This comment was deleted", deleteTitle: "Delete this comment?", deleteMsg: "Its words, reactions and files go. A line stays where it was, so the replies under it still make sense.",
    reactions: "Reactions", reactedWith: "{0} reacted with {1}", reactedYou: "You", reactedMore: "{0} and {1} more", reactMine: "{0} (yours: press to take it back)",
    replyingTo: "Replying to {0}", replyTo: "Reply to {0}", replyHint: "Reply — @ names an instance (Ctrl+Enter sends)",
    resolved: "Resolved thread", resolvedBy: "Resolved by {0}", replyCount: "{0} replies", replyOne: "1 reply", showThread: "Show the thread", hideThread: "Hide the thread",
    toNobody: "No agent notified", toSend: "{0} · starts when sent", toLabel: "Who this comment is for", toTip: "Who is woken when you send this comment. An @name in the text still wakes that instance too.",
    toNobodyTip: "Nobody is woken (an @name in the text still is)", toWaits: "{0} · won't wake until the card is ready",
    toWaitsTip: "This card still waits for another card, so a plain comment does not wake {0} yet (it reads the card when it can start). Choose {0} in the list to wake it now; an @name wakes it too.", groupAssignee: "Assignee", groupDispatcher: "Handed out by", groupWatchers: "Watching the card",
    groupLead: "Project lead", groupLeadBoard: "Board leader", groupOthers: "Other instances", boardOff: "{0} (task board off)",
  },
  "zh-TW": {
    reply: "回覆", react: "新增反應", edit: "編輯", resolve: "解決討論串", reopen: "重新開啟討論串", copy: "複製", copyLink: "複製連結", delete: "刪除",
    more: "留言動作", copied: "已複製", linkCopied: "已複製這則留言的連結", copyFailed: "無法複製",
    edited: "已編輯", editedTip: "編輯於 {0}", save: "儲存", cancel: "取消", editHint: "Ctrl+Enter 儲存 · Esc 放棄修改", editLabel: "編輯留言",
    deleted: "這則留言已刪除", deleteTitle: "刪除這則留言？", deleteMsg: "內容、反應和附件都會移除。原位置會留一行，底下的回覆才讀得通。",
    reactions: "反應", reactedWith: "{0} 用 {1} 回應", reactedYou: "你", reactedMore: "{0} 等 {1} 人", reactMine: "{0}（你按的：再按一次收回）",
    replyingTo: "回覆 {0}", replyTo: "回覆 {0}", replyHint: "回覆 — 輸入 @ 可選 Agent（Ctrl+Enter 送出）",
    resolved: "已解決的討論串", resolvedBy: "由 {0} 解決", replyCount: "{0} 則回覆", replyOne: "1 則回覆", showThread: "展開討論串", hideThread: "收合討論串",
    toNobody: "不通知 Agent", toSend: "{0} · 送出後開始處理", toLabel: "這則留言要給誰", toTip: "送出時叫醒誰。文字裡的 @名稱照樣會叫醒該 Agent。",
    toNobodyTip: "不叫醒任何人（文字裡的 @名稱照樣會）", toWaits: "{0} · 卡片可以開始前不會叫醒",
    toWaitsTip: "這張卡還在等別張卡，所以一般留言暫時不會叫醒 {0}（它能開始時會讀到這張卡）。要現在叫醒它，請在清單裡選 {0}；寫 @名稱 也會叫醒。", groupAssignee: "負責人", groupDispatcher: "派工者", groupWatchers: "關注這張卡的",
    groupLead: "專案 leader", groupLeadBoard: "任務板 leader", groupOthers: "其他 Agent", boardOff: "{0}（任務板關閉）",
  },
});

// ── Threads (pure: tests import these) ─────────────────────

/** The comment entries a thread is made of keep their order; `rootOf` walks a reply up to its thread's first comment. */
export function rootOf(entry, byId) {
  let cur = entry;
  for (let hops = 0; cur && cur.parentId !== undefined && cur.parentId !== null && hops < 64; hops++) {
    const up = byId.get(cur.parentId);
    if (!up) break;
    cur = up;
  }
  return cur;
}

/**
 * The stream's entries with each reply moved under its thread's first comment: `{ ...root, replies: [entries in time order] }`;
 * a comment whose parent is not among `all` (outside the page's window, left out of sight) stands alone. Only comments are
 * grouped; a progress note, a history line or a comment the filter hid keeps its place. `all`: every comment of the card
 * (a reply under a filter still finds its thread).
 */
export function threadize(entries, all) {
  const byId = new Map();
  for (const e of all) if (e.type === "comment" && e.id !== undefined) byId.set(e.id, e);
  const shown = new Set(entries.filter((e) => e.type === "comment" && e.id !== undefined).map((e) => e.id));
  const replies = new Map();
  const out = [];
  for (const e of entries) {
    if (e.type !== "comment" || e.parentId === undefined || e.parentId === null) { out.push(e); continue; }
    const root = rootOf(e, byId);
    if (!root || root === e || !shown.has(root.id)) { out.push(e); continue; }
    (replies.get(root.id) || replies.set(root.id, []).get(root.id)).push(e);
  }
  return out.map((e) => (e.type === "comment" && replies.has(e.id) ? { ...e, replies: replies.get(e.id) } : e));
}

/** A reaction as its chip says it: the emoji, the number, whether it is the viewer's, and who (the tooltip). */
export function reactionView(reaction, viewer) {
  const by = Array.isArray(reaction.by) ? reaction.by : [];
  // The host says whether the chip is the viewer's (by their key); a host that does not, by name and kind as before.
  const mine = typeof reaction.mine === "boolean" ? reaction.mine : !!viewer && by.some((b) => b.name === viewer.name && b.kind === viewer.kind);
  // The viewer's own entry is "You"; another account with the same name still reads as that name.
  let skipped = false;
  const others = by.filter((b) => { if (mine && !skipped && viewer && b.name === viewer.name && b.kind === viewer.kind) { skipped = true; return false; } return true; }).map((b) => b.name);
  const who = [...(mine ? [t("taskthread.reactedYou")] : []), ...others].slice(0, 3);
  const rest = by.length - who.length;
  const list = rest > 0 ? t("taskthread.reactedMore", who.join(", "), rest) : who.join(", ");
  return { emoji: reaction.emoji, count: by.length, mine, label: t("taskthread.reactedWith", list, reaction.emoji) };
}

/**
 * Whether the viewer wrote the comment (an edit is its author's). The host says (`mine`, from the writer's own key: two people who
 * are both "web-user" are not each other); a host that does not say is read by the same name and the same kind.
 */
export const wroteComment = (entry, viewer) => !!viewer && (typeof entry.mine === "boolean" ? entry.mine : entry.who === viewer.name && entry.by === viewer.kind);

/** A comment's address: the card's page, the comment's anchor (`#c42`, which scrolls to it and lights it). */
export const commentHash = (id) => `#c${id}`;
export function commentUrl(href, cardId, id) {
  const u = new URL(href);
  u.searchParams.set("card", cardId);
  u.hash = commentHash(id);
  return u.toString();
}
/** The comment an address names (`#c42`), or null. */
export const commentInHash = (hash) => { const m = /^#c(\d{1,12})$/.exec(String(hash || "")); return m ? Number(m[1]) : null; };

/**
 * Whom a comment may be for, as the recipient chip lists them: groups in order — the card's assignee, who handed it out, who
 * watches it, its leader, then every other instance of the fleet — each name once (the first group that has it). `fleet`:
 * [{ name, off }] (the fleet's instances; one with the task board off is listed, not choosable). `detail`: the card read
 * (watchers, inheritedWatchers, leader).
 */
export function recipientGroups({ card, detail, fleet }) {
  const known = new Map((fleet || []).map((n) => [n.name, n]));
  const seen = new Set();
  const take = (names) => names.filter((n) => known.has(n) && !seen.has(n) && (seen.add(n), true)).map((n) => known.get(n));
  const groups = [];
  const add = (key, title, names) => { const list = take(names); if (list.length) groups.push({ key, title, names: list }); };
  add("assignee", "taskthread.groupAssignee", card.assignee ? [card.assignee] : []);
  add("dispatcher", "taskthread.groupDispatcher", card.dispatcher && card.dispatcher.kind === "instance" ? [card.dispatcher.name] : []);
  add("watchers", "taskthread.groupWatchers", [...((detail && detail.watchers) || []), ...((detail && detail.inheritedWatchers) || [])]);
  const lead = detail && detail.leader;
  add("lead", lead && lead.via === "board" ? "taskthread.groupLeadBoard" : "taskthread.groupLead", lead ? [lead.name] : []);
  add("others", "taskthread.groupOthers", (fleet || []).map((n) => n.name));
  return groups;
}

/**
 * Who the comment box starts with (null: nobody is notified). A reply: the author of the comment it answers, when that is an
 * instance the board can wake. Otherwise the card's assignee, when it is an instance the board can wake and the card is not
 * finished (a finished card's talk is rarely an order; choosing someone still wakes them). A person or no assignee: nobody.
 * On a card that still waits on another card the assignee is the chip's name but `holdsRecipient` says it is not woken yet.
 */
export function defaultRecipient({ card, reply = null, fleet }) {
  const live = (name) => !!name && (fleet || []).some((n) => n.name === name && !n.off);
  if (reply && reply.by === "instance" && live(reply.who)) return reply.who;
  const finished = card.status === "done" || card.status === "cancelled";
  if (!finished && live(card.assignee)) return card.assignee;
  return null;
}

/**
 * Whether the chip's starting name is held back: a new comment (not a reply) on an open card that still waits on another card, whose
 * assignee is the name the chip starts with. The comment then goes with no recipient list, as #4367's rule has it: the assignee reads it
 * when the card can start, and is not woken now. Choosing it in the list is asking for it by name — that sends it and wakes it.
 */
export function holdsRecipient({ card, reply = null, initial }) {
  if (reply || !initial || initial !== card.assignee) return false;
  return card.status === "open" && ((card.unmetDeps || []).length > 0 || card.hiddenUnmet > 0);
}

// ── The recipient chip ─────────────────────────────────────

/** The chip under the comment box: who this comment is for ("dev · starts when sent"); a click lists the others. `held`: the name is the card's assignee, not woken until the card is ready. */
export function RecipientChip({ groups, value, onChange, disabled = false, held = false }) {
  const label = value ? t(held ? "taskthread.toWaits" : "taskthread.toSend", value) : t("taskthread.toNobody");
  const items = [];
  for (const g of groups) {
    items.push({ key: `h-${g.key}`, heading: true, label: t(g.title) });
    for (const n of g.names) items.push({ key: `n-${n.name}`, label: n.off ? t("taskthread.boardOff", n.name) : n.name, checked: value === n.name, disabled: !!n.off, title: n.off ? t("tasks.boardOffHint") : undefined, onSelect: () => onChange(n.name) });
  }
  items.push({ key: "nobody", label: t("taskthread.toNobody"), checked: value === null, title: t("taskthread.toNobodyTip"), onSelect: () => onChange(null) });
  return html`<${Menu} cls="tc-to-menu" label=${t("taskthread.toLabel")} fit disabled=${disabled} items=${items} triggerClass="tc-to"
    trigger=${html`<${Icon} name=${value ? "bot" : "bell"} size=${14} /><span class="tc-to-text" title=${value ? (held ? t("taskthread.toWaitsTip", value) : t("taskthread.toTip")) : t("taskthread.toNobodyTip")}>${label}</span><${Icon} name="chevron" size=${14} />`} />`;
}

// ── A comment's tools ──────────────────────────────────────

/** The ⋯ menu's items for one comment (pure: tests import it). `ctx`: { writable, viewer, root, resolved }, `act(name)` runs one. */
export function commentMenuItems(entry, ctx, act) {
  const writable = !!ctx.writable && !!ctx.viewer;
  const mine = writable && wroteComment(entry, ctx.viewer);
  return [
    writable && !entry.deleted ? { key: "reply", label: t("taskthread.reply"), icon: "reply", onSelect: () => act("reply") } : null,
    writable && !entry.deleted ? { key: "react", label: t("taskthread.react"), icon: "smile", onSelect: () => act("react") } : null,
    mine && !entry.deleted && entry.kind === "comment" ? { key: "edit", label: t("taskthread.edit"), icon: "edit", onSelect: () => act("edit") } : null,
    writable && ctx.root ? { key: "resolve", label: ctx.resolved ? t("taskthread.reopen") : t("taskthread.resolve"), icon: "check", onSelect: () => act("resolve") } : null,
    !entry.deleted ? { key: "copy", label: t("taskthread.copy"), icon: "copy", onSelect: () => act("copy") } : null,
    { key: "link", label: t("taskthread.copyLink"), icon: "link", onSelect: () => act("link") },
    writable && !entry.deleted ? { key: "delete", label: t("taskthread.delete"), icon: "trash", danger: true, onSelect: () => act("delete") } : null,
  ].filter(Boolean);
}

/** The reaction button and the ⋯ menu at a comment's top right. */
export function CommentTools({ entry, ctx, act }) {
  const items = commentMenuItems(entry, ctx, act);
  const writable = !!ctx.writable && !!ctx.viewer && !entry.deleted;
  return html`<span class="tl-tools">
    ${writable ? html`<button type="button" class="icon-btn tl-tool" title=${t("taskthread.react")} aria-label=${t("taskthread.react")} aria-haspopup="true" aria-expanded=${ctx.picking === entry.id ? "true" : "false"}
      onClick=${() => act("react")}><${Icon} name="smile" size=${16} /></button>` : null}
    <${Menu} cls="tl-menu" label=${t("taskthread.more")} fit items=${items} />
  </span>`;
}

/** The quick reactions (the chat's own set), shown under a comment while "Add reaction" is open. */
export function ReactionPicker({ onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const first = ref.current && ref.current.querySelector("button");
    if (first) first.focus({ preventScroll: true });
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !(e.target.closest && e.target.closest(".tl-tools"))) onClose(); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", away, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", away, true); };
  }, []);
  return html`<div class="react-pick tl-pick" ref=${ref} role="group" aria-label=${t("taskthread.reactions")}>${QUICK_REACTIONS.map((e) =>
    html`<button key=${e} type="button" class="chip-btn react-opt" aria-label=${e} onClick=${() => onPick(e)}>${e}</button>`)}</div>`;
}

/** A comment's reactions as the chat's chips: the emoji and the number; the viewer's is accented, and pressing it takes it back. */
export function ReactionBar({ entry, ctx, onReact }) {
  const list = (entry.reactions || []).map((r) => reactionView(r, ctx.viewer)).filter((r) => r.count > 0);
  if (!list.length) return null;
  const live = !!ctx.writable && !!ctx.viewer;
  return html`<div class="msg-reactions react-bar tl-reacts" role="group" aria-label=${t("taskthread.reactions")}>${list.map((r) => live
    ? html`<button key=${r.emoji} type="button" class=${`reaction react-chip${r.mine ? " mine" : ""}`} aria-pressed=${r.mine ? "true" : "false"} title=${r.mine ? t("taskthread.reactMine", r.label) : r.label} aria-label=${r.label}
        onClick=${() => onReact(r.emoji, !r.mine)}><span class="e">${r.emoji}</span><span class="n">${r.count}</span></button>`
    : html`<span key=${r.emoji} class=${`reaction react-chip${r.mine ? " mine" : ""}`} role="img" title=${r.label} aria-label=${r.label}><span class="e">${r.emoji}</span><span class="n">${r.count}</span></span>`)}</div>`;
}

/** Editing a comment's words in place: Ctrl+Enter or Save keeps them, Esc or Cancel drops the change. `onSave(text)` resolves "ok" when it is kept. */
export function EditBox({ entry, onSave, onCancel }) {
  const [text, setText] = useState(entry.text);
  const [saving, setSaving] = useState(false);
  const box = useRef(null);
  useEffect(() => { const el = box.current; if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* no selection API */ } } }, []);
  const same = text.trim() === entry.text.trim();
  async function save() {
    if (saving || !text.trim() || same) { if (same) onCancel(); return; }
    setSaving(true);
    try { if ((await onSave(text.trim())) === "ok") onCancel(); } finally { setSaving(false); }
  }
  return html`<div class="tl-edit">
    <textarea ref=${box} rows="3" value=${text} aria-label=${t("taskthread.editLabel")} onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void save(); }
      }}></textarea>
    <div class="tl-edit-foot"><span class="muted tl-edit-hint">${t("taskthread.editHint")}</span>
      <button type="button" class="btn btn-sm" onClick=${onCancel}>${t("taskthread.cancel")}</button>
      <button type="button" class="btn btn-primary btn-sm" disabled=${saving || !text.trim()} onClick=${() => void save()}>${t("taskthread.save")}</button></div>
  </div>`;
}
