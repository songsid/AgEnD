// A card's activity (Fleet › Tasks › a card's page): the comments, the progress log and the history are one timeline, oldest
// first, with the comment box under it. The card API still returns the three lists apart (comments, logs, history); they are
// merged here, so nothing on the server changes. A history line that only repeats a comment or a log entry ("commented",
// "logged") is dropped from the merge — the entry itself is shown. The one
// "logged" line with no entry of its own, a change of the card's watchers (`data.watchers`), stays as a history line.
// The timeline is read for progress, so what people and agents SAY and DO leads it: a comment has no box — a name and a time,
// the text under it, drawn by the chat's own Markdown renderer (safe by construction: it escapes first); a progress note is a
// line with its words in the text colour; the history is the quietest thing on the page (small, grey, a run of the same line
// from the same hand is one line "×3"); and a day change is a thin separator.
// The comment box completes `@` with the fleet's instance names: it only types `@<instance name>` into the text; what an
// @ does to that instance is the board's business (it reads the same plain text), not this box's.
// A comment written for an instance carries its status under it (fleet-task-wake.js: sent, read, working, replied — or why not), and a
// comment that is new for this person is tagged "New" until they leave the card (task-unread.js).
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import "/assets/chat-strings.js";
import { Icon } from "/assets/ui-icons.js";
import { BoardOffNote, boardOffTargets, relTime } from "./fleet-task-common.js";
import { AgentTag, instanceStates } from "./fleet-task-run.js";
import { WakeStatus, wakeNames } from "./fleet-task-wake.js";
import { appStore } from "/assets/app-store.js";
import { WhoCard } from "./fleet-task-owner.js";
import { insertAtTrigger, triggerAt, withoutCode } from "./trigger-complete.js";
import { dateTimeText } from "/assets/clock-text.js";
import { FileList } from "./fleet-task-files.js";
import { MdBody, commentHtml, copyText, decorateCode, storedWrap } from "./fleet-task-md.js";
import { CommentTools, EditBox, ReactionBar, ReactionPicker, RecipientChip, commentInHash, commentUrl, defaultRecipient, recipientGroups, rootOf, threadize } from "./fleet-task-thread.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";

// The Markdown pieces moved to fleet-task-md.js (the card's fields draw them too); these stay importable from here.
export { MdBody, commentHtml, decorateCode };

export const TIMELINE_FILTERS = ["all", "comments", "log", "history"];
const RANK = { event: 0, log: 1, comment: 2 };   // at one instant: the move first, then the words that came with it

const when = (iso) => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };

/**
 * The card detail's three lists as one timeline, oldest first (pure: tests import it). Each entry:
 * { key, type: "comment" | "log" | "event", at, who, by, text?, kind?, authorKind?, ev? } — `ev` is the history event;
 * `by` is who made it (person | instance | script | system) when the server said, else "" (an older entry): an instance's is
 * marked in the timeline.
 */
export function timelineOf(detail) {
  const out = [];
  const files = (detail && detail.attachments) || [];
  // A comment also carries what the threads add (docs/design/task-board.md, "Comment threads"): its number, the comment it answers,
  // an edit, a deletion, a resolved thread and its reactions — each only when the board sent it (an older host sends none).
  for (const e of (detail && detail.comments) || []) out.push({ key: `c${e.id}`, type: "comment", id: e.id, at: e.at, who: e.author, by: e.authorKind || "", text: e.text, kind: e.kind, authorKind: e.authorKind, files: files.filter((f) => f.entryId === e.id),
    ...(e.parentId !== undefined ? { parentId: e.parentId } : {}), ...(e.editedAt ? { editedAt: e.editedAt } : {}), ...(e.deleted ? { deleted: e.deleted } : {}), ...(e.resolved ? { resolved: e.resolved } : {}), ...(e.reactions ? { reactions: e.reactions } : {}), ...(typeof e.mine === "boolean" ? { mine: e.mine } : {}), ...(e.wakes ? { wakes: e.wakes } : {}) });
  for (const e of (detail && detail.logs) || []) out.push({ key: `l${e.id}`, type: "log", at: e.at, who: e.author, by: e.authorKind || "", text: e.text });
  for (const ev of (detail && detail.history) || []) {
    if (ev.type === "commented" || ev.type === "reordered") continue;
    if (ev.type === "logged" && !(ev.data && ev.data.watchers)) continue;   // a log entry is shown as itself; a watcher change has none (the board writes the event only)
    out.push({ key: `h${ev.id}`, type: "event", at: ev.at, who: ev.actor, by: ev.actorKind || "", ev });
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => when(a.e.at) - when(b.e.at) || RANK[a.e.type] - RANK[b.e.type] || a.i - b.i).map((x) => x.e);
}

/** The entries a filter shows: everything, or one kind of them. */
export function timelineShown(entries, filter) {
  const type = { comments: "comment", log: "log", history: "event" }[filter];
  return type ? entries.filter((e) => e.type === type) : entries;
}

// ── Completing an @ ───────────────────────────────────────

// The word at the caret and its replacement are the shared trigger-complete.js's, with the trigger "@": the list
// is offered only where the board would read the name as a mention (task-board-mentions.ts), and what is typed in is read
// back as that instance. withoutCode is the board's own, re-exported for the tests.
export { withoutCode };

/** The `@name` being typed at the caret, or null: { start: where the "@" is, query: the characters after it }. */
export const mentionAt = (text, caret) => triggerAt(text, caret, "@");

/** The names that complete a query: those starting with it first, then those containing it; case does not matter. */
export function mentionMatches(names, query, limit = 8) {
  const q = query.toLocaleLowerCase();
  const lower = (n) => n.toLocaleLowerCase();
  const starts = names.filter((n) => lower(n).startsWith(q));
  const inside = names.filter((n) => !lower(n).startsWith(q) && lower(n).includes(q));
  return [...starts, ...inside].slice(0, limit);
}

/**
 * The text with the `@query` at `m` replaced by `@name ` (one space after, unless one is already there), and where the
 * caret goes. `names`: the fleet's — the board reads the longest instance name that fits, so a name that the text after the
 * caret would run on into a longer one gets a space of its own.
 */
export const insertMention = (text, m, caret, name, names = []) => insertAtTrigger(text, m, caret, "@", name, names);

// ── The timeline ──────────────────────────────────────────

const fullTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? dateTimeText(d) : ""; };

/**
 * A run of the same history line from the same hand ("web-user changed acceptance" three times in a row) is one entry with a
 * `count` and the latest time (pure: tests import it). Only history lines merge; a comment or a progress note never does.
 * `describe(ev)` words a history event (the page's).
 */
export function collapseEvents(entries, describe) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && e.type === "event" && prev.type === "event" && prev.who === e.who && prev.by === e.by && describe(prev.ev) === describe(e.ev)) {
      out[out.length - 1] = { ...prev, count: (prev.count || 1) + 1, at: e.at };
      continue;
    }
    out.push(e);
  }
  return out;
}

/** The device's calendar day of a time ("2026-11-18"), or "" when it is none. */
export function dayKey(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** A day's name for the separator: Today, Yesterday, else "Wed, Nov 11" (with the year when it is not this one). */
export function dayLabel(iso, now = Date.now()) {
  const key = dayKey(iso);
  if (!key) return "";
  if (key === dayKey(now)) return t("taskcard.today");
  if (key === dayKey(new Date(now).setDate(new Date(now).getDate() - 1))) return t("taskcard.yesterday");
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(lang() === "zh-TW" ? "zh-TW" : "en-US", { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * The stream's items (pure: tests import it): what people and agents SAY — a comment, a progress note — is a card each; the
 * system's lines (history) between two cards are a run, of any length, and a run is folded into one "› N activities" row at first
 *. `entries` are what the filter shows (a run of equal history lines already one line: `collapseEvents`); `group:
 * false` (the History filter, which asks to see them) keeps every line on its own, open.
 * Each item: { kind: "card", entry } | { kind: "run", key, entries, fold } — `fold`: the run starts closed.
 */
export function streamOf(entries, group = true) {
  const out = [];
  for (const entry of entries) {
    if (entry.type !== "event") { out.push({ kind: "card", entry }); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === "run") last.entries.push(entry);
    else out.push({ kind: "run", key: `run-${entry.key}`, entries: [entry] });
  }
  for (const item of out) if (item.kind === "run") item.fold = group;
  return out;
}

const timeOf = (entry) => html`<time class="muted tl-time" dateTime=${entry.at} title=${fullTime(entry.at)}>${relTime(entry.at)}</time>`;

/**
 * One entry. A comment and a progress note are each a card (the same: a head with the avatar — an instance's with its state
 * dot —, the name, an "Agent" badge, a tag for what it is, and the time; the text under the name); a history line is a thin row
 * with an icon (a status change's is the status's), the sentence and the time, no box. `who`: the board's cards and the project's
 * lead, for the avatar's info card.
 */
function Entry({ entry, describe, who, ctx = null, reply = false, root = false, resolved = false }) {
  const time = timeOf(entry);
  const agent = entry.by === "instance";
  const mark = agent ? " by-agent" : "";
  const kind = entry.by === "person" ? "person" : entry.by === "instance" ? "instance" : entry.by ? "none" : "";
  const author = html`<${WhoCard} name=${entry.who} kind=${kind} presence=${agent} cards=${who && who.cards} lead=${who && who.lead} />`;
  if (entry.type === "comment") {
    const here = ctx ? { ...ctx, root, resolved } : { writable: false, viewer: null, root: false };
    const lit = (here.flash === entry.id ? " tl-flash" : "") + (here.fresh && here.fresh.has(entry.id) ? " tl-unread" : "");
    // A deleted comment stays as a line where it was, so the replies under it still hang from something.
    if (entry.deleted) {
      return html`<li id=${`c${entry.id}`} data-comment=${entry.id} class=${`tl-item tl-card tl-comment tl-deleted${reply ? " tl-reply" : ""}${lit}`}>
        <p class="tl-gone muted"><${Icon} name="trash" size=${14} /><span>${t("taskthread.deleted")}</span>${time}</p></li>`;
    }
    const body = commentHtml(entry.text);
    const editing = here.editing === entry.id && ctx;
    return html`<li id=${entry.id !== undefined ? `c${entry.id}` : undefined} data-comment=${entry.id} class=${`tl-item tl-card tl-comment${entry.authorKind === "person" ? " person" : ""}${mark}${reply ? " tl-reply" : ""}${lit}`}>
      <div class="tl-head">${author}${agent ? html`<${AgentTag} />` : null}
        ${entry.kind === "reject" ? html`<span class="tb-tag st-blocked">${t("taskcard.rejectTag")}</span>` : null}
        ${entry.kind === "approve" ? html`<span class="tb-tag st-done">${t("taskcard.approveTag")}</span>` : null}
        ${here.fresh && here.fresh.has(entry.id) ? html`<span class="tb-tag tl-new" title=${t("taskwake.newTip")}>${t("taskwake.newMark")}</span>` : null}
        ${time}${entry.editedAt ? html`<span class="muted tl-edited" title=${t("taskthread.editedTip", fullTime(entry.editedAt))}>${t("taskthread.edited")}</span>` : null}
        ${entry.id !== undefined && ctx ? html`<${CommentTools} entry=${entry} ctx=${here} act=${(name) => ctx.act(entry, name)} />` : null}</div>
      ${editing ? html`<${EditBox} entry=${entry} onSave=${(text) => ctx.edit(entry, text)} onCancel=${() => ctx.stop("editing")} />`
        : body ? html`<${MdBody} body=${body} />` : html`<div class="tl-body">${entry.text}</div>`}
      ${entry.files && entry.files.length ? html`<${FileList} files=${entry.files} cls="tl-files" />` : null}
      ${ctx && here.wake && entry.wakes ? html`<${WakeStatus} entry=${entry} comments=${here.wake.comments} states=${here.wake.states} onOpen=${here.wake.open} />` : null}
      ${ctx && entry.id !== undefined ? html`<${ReactionBar} entry=${entry} ctx=${here} onReact=${(emoji, on) => ctx.react(entry, emoji, on)} />` : null}
      ${ctx && here.picking === entry.id ? html`<${ReactionPicker} onPick=${(emoji) => ctx.react(entry, emoji, true)} onClose=${() => ctx.stop("picking")} />` : null}</li>`;
  }
  if (entry.type === "log") {
    return html`<li class=${`tl-item tl-card tl-log${mark}`}>
      <div class="tl-head">${author}${agent ? html`<${AgentTag} />` : null}<span class="tb-tag tl-kind" title=${t("taskcard.logTip")}>${t("taskcard.show.log")}</span>${time}</div>
      <div class="tl-body">${entry.text}</div></li>`;
  }
  const to = entry.ev && entry.ev.type === "moved" && entry.ev.data ? entry.ev.data.to : null;
  return html`<li class="tl-item tl-line tl-event"><span class="tl-mark" aria-hidden="true"><span class=${`tb-dot${to ? ` st-${to}` : ""}`}></span></span>
    <span class="tl-sentence"><span class="tl-who"><b>${entry.who}</b>${agent ? html` <${AgentTag} />` : null}</span> <span class="tl-text">${describe(entry.ev)}${entry.count > 1 ? html` <span class="tl-count" title=${t("taskcard.repeated", entry.count)}>×${entry.count}</span>` : null}</span></span>${time}</li>`;
}

/** A run of system lines: one "› N activities" button that opens and closes them (the History filter's runs are always open, no button). */
function Run({ run, describe, open, onToggle }) {
  const n = run.entries.length;
  return html`<li class="tl-run">
    ${run.fold ? html`<button type="button" class="tl-more" aria-expanded=${open ? "true" : "false"} onClick=${onToggle}>
      <span class="tl-mark" aria-hidden="true"><${Icon} name="chevron" size=${14} cls=${open ? "tb-chev open" : "tb-chev"} /></span><span>${n === 1 ? t("taskcard.activity1") : t("taskcard.activities", n)}</span></button>` : null}
    ${open ? html`<ul class="tl-lines">${run.entries.map((e) => html`<${Entry} key=${e.key} entry=${e} describe=${describe} />`)}</ul>` : null}
  </li>`;
}

const brief = (text, max = 80) => { const chars = [...String(text || "").replace(/\s+/g, " ").trim()]; return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join(""); };

/**
 * The activity stream with its filter (all, comments, progress log, history). `describe(ev)` words a history event.
 * Comment threads (docs/design/task-board.md, "Comment threads"): `thread` — { writable, viewer, send, edit, react, resolve,
 * remove } — makes each comment's ⋯ menu and reactions live; without it (an older host) comments read as they always did. A reply
 * is drawn under its thread's first comment, indented; a resolved thread folds into one line that opens again. `names`: the fleet's
 * instances [{ name, off }] for the recipient chip of an inline reply. `fresh`: the numbers of the comments that are new for this person (tagged).
 */
export function Timeline({ detail, describe, cards = [], lead = null, thread = null, names = [], fresh = [] }) {
  const [filter, setFilter] = useState("all");
  const [toggled, setToggled] = useState({});
  const [ui, setUi] = useState({ replying: null, editing: null, picking: null });
  const [flash, setFlash] = useState(null);
  const all = timelineOf(detail);
  const comments = all.filter((e) => e.type === "comment");
  const byId = new Map(comments.filter((e) => e.id !== undefined).map((e) => [e.id, e]));
  const card = detail && detail.card;
  // The number of entries on a filter button is the number of lines the list shows for it: a run of equal history lines is one.
  const count = (f) => collapseEvents(timelineShown(all, f), describe).length;
  const shown = threadize(collapseEvents(timelineShown(all, filter), describe), comments);
  // A day change is a separator — only when the stream spans more than one day (one day needs no heading); a run never crosses it.
  const days = new Set(shown.map((e) => dayKey(e.at)).filter(Boolean));
  const parts = [];
  let day = "";
  for (const e of shown) {
    const k = dayKey(e.at);
    if (!parts.length || (days.size > 1 && k && k !== day)) parts.push({ day: days.size > 1 && k ? e.at : "", entries: [] });
    if (k) day = k;
    parts[parts.length - 1].entries.push(e);
  }
  const who = { cards, lead };

  // A link to a comment (`#c42`) opens the card, scrolls to that comment and lights it for a moment (a resolved thread opens first).
  const target = commentInHash(globalThis.location && globalThis.location.hash);
  const landed = useRef(null);
  useEffect(() => {
    if (target === null || !card || landed.current === `${card.id}${target}`) return undefined;
    const hit = byId.get(target);
    if (!hit) return undefined;
    landed.current = `${card.id}${target}`;
    const top = rootOf(hit, byId);
    if (top.resolved) setToggled((cur) => ({ ...cur, [`t${top.id}`]: true }));
    setFlash(target);
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [target, card && card.id, comments.length]);
  useEffect(() => {
    if (flash === null) return;
    const el = document.getElementById(`c${flash}`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  }, [flash]);

  const viewer = thread ? thread.viewer || null : null;
  const copy = async (text, doneKey) => toast(await copyText(text) ? t(doneKey) : t("taskthread.copyFailed"), true);
  // Where each comment written for an instance stands (fleet-task-wake.js): the instance's state is the page's own (the card's "Running" inference);
  // read at each draw — the card page draws again with the store.
  const wakeStates = thread && card ? instanceStates(appStore.get(), wakeNames(detail)) : null;
  const jump = (id) => { setFlash(id); setTimeout(() => setFlash((cur) => (cur === id ? null : cur)), 2400); };
  const ctx = thread && card ? {
    writable: !!thread.writable, viewer, picking: ui.picking, editing: ui.editing, flash, fresh: fresh.length ? new Set(fresh) : null,
    wake: { comments, states: wakeStates, open: jump },
    stop: (key) => setUi((u) => ({ ...u, [key]: null })),
    edit: (entry, text) => thread.edit(entry, text),
    react: (entry, emoji, on) => { setUi((u) => ({ ...u, picking: null })); return thread.react(entry, emoji, on); },
    act: (entry, name) => {
      if (name === "reply") setUi((u) => ({ ...u, replying: entry.id, editing: null, picking: null }));
      else if (name === "react") setUi((u) => ({ ...u, picking: u.picking === entry.id ? null : entry.id, editing: null }));
      else if (name === "edit") setUi((u) => ({ ...u, editing: entry.id, picking: null }));
      else if (name === "resolve") { const now = !entry.resolved; setToggled((cur) => ({ ...cur, [`t${entry.id}`]: !now })); void thread.resolve(entry, now); }
      else if (name === "copy") void copy(entry.text, "taskthread.copied");
      else if (name === "link") void copy(commentUrl(globalThis.location.href, card.id, entry.id), "taskthread.linkCopied");
      else if (name === "delete") {
        void confirmDialog({ title: t("taskthread.deleteTitle"), message: t("taskthread.deleteMsg"), confirmLabel: t("taskthread.delete"), danger: true }).then((yes) => { if (yes) void thread.remove(entry); });
      }
    },
  } : null;

  /** A comment, with the replies under it (and the box that answers one); a resolved thread is one line until it is opened. */
  function commentRow(entry) {
    if (!ctx) return html`<${Entry} key=${entry.key} entry=${entry} describe=${describe} who=${who} />`;
    const replies = entry.replies || [];
    const first = entry.parentId === undefined;
    const open = toggled[`t${entry.id}`] === true;
    if (entry.resolved && !entry.deleted && !open) {
      const n = replies.length;
      return html`<li key=${entry.key} class="tl-item tl-resolved"><button type="button" class="tl-more tl-resolved-btn" aria-expanded="false" title=${t("taskthread.showThread")}
        onClick=${() => setToggled((cur) => ({ ...cur, [`t${entry.id}`]: true }))}>
        <span class="tl-mark" aria-hidden="true"><${Icon} name="check" size=${14} /></span>
        <span class="tl-resolved-text"><b>${t("taskthread.resolved")}</b> · ${entry.resolved.by ? t("taskthread.resolvedBy", entry.resolved.by) : ""} · ${entry.who}: ${brief(entry.text)}${n ? ` · ${n === 1 ? t("taskthread.replyOne") : t("taskthread.replyCount", n)}` : ""}</span></button></li>`;
    }
    const replyingHere = ui.replying !== null && (ui.replying === entry.id || replies.some((r) => r.id === ui.replying));
    if (!replies.length && !replyingHere && !entry.resolved) return html`<${Entry} key=${entry.key} entry=${entry} describe=${describe} who=${who} ctx=${ctx} root=${first} />`;
    const target = replyingHere ? byId.get(ui.replying) : null;
    const groups = replyingHere ? recipientGroups({ card, detail, fleet: names }) : [];
    return html`<li key=${entry.key} class="tl-item tl-thread">
      ${entry.resolved ? html`<div class="tl-resolved-note muted"><${Icon} name="check" size=${14} /><span>${entry.resolved.by ? t("taskthread.resolvedBy", entry.resolved.by) : t("taskthread.resolved")}</span>
        <button type="button" class="tb-link" onClick=${() => setToggled((cur) => ({ ...cur, [`t${entry.id}`]: false }))}>${t("taskthread.hideThread")}</button></div>` : null}
      <ol class="tl-thread-list">
        <${Entry} entry=${entry} describe=${describe} who=${who} ctx=${ctx} root=${first} resolved=${!!entry.resolved} />
        ${replies.map((r) => html`<${Entry} key=${r.key} entry=${r} describe=${describe} who=${who} ctx=${ctx} reply />`)}
        ${target ? html`<li class="tl-reply-box" key="reply-box">
          <${Composer} variant="reply" autoFocus names=${names} placeholder=${t("taskthread.replyTo", target.who)} recipients=${{ groups, initial: defaultRecipient({ card, reply: target, fleet: names }) }}
            onCancel=${() => ctx.stop("replying")} onSend=${async (text, to) => { const r = await thread.send(text, { replyTo: target.id, to: to ? [to] : [] }); if (r === "ok") ctx.stop("replying"); return r; }} /></li>` : null}
      </ol></li>`;
  }

  const rows = [];
  for (const part of parts) {
    if (part.day) rows.push(html`<li key=${`d${dayKey(part.day)}`} class="tl-day" role="presentation"><span>${dayLabel(part.day)}</span></li>`);
    for (const item of streamOf(part.entries, filter === "all")) {
      if (item.kind === "card") rows.push(item.entry.type === "comment" ? commentRow(item.entry) : html`<${Entry} key=${item.entry.key} entry=${item.entry} describe=${describe} who=${who} />`);
      else {
        const open = item.fold ? toggled[item.key] === true : true;
        rows.push(html`<${Run} key=${item.key} run=${item} describe=${describe} open=${open} onToggle=${() => setToggled((cur) => ({ ...cur, [item.key]: !open }))} />`);
      }
    }
  }
  return html`<section class=${`tl${storedWrap() ? " wrap-code" : ""}`} aria-label=${t("taskcard.activity")}>
    <div class="tl-bar"><h3>${t("taskcard.activity")}</h3>
      <div class="tb-seg tl-filter" role="group" aria-label=${t("taskcard.activityShow")}>${TIMELINE_FILTERS.map((f) =>
        html`<button key=${f} type="button" aria-pressed=${filter === f ? "true" : "false"} class=${`tb-seg-btn${filter === f ? " active" : ""}`} title=${f === "log" ? t("taskcard.logTip") : undefined} onClick=${() => setFilter(f)}>${t(`taskcard.show.${f}`)}${f === "all" ? "" : ` ${count(f)}`}</button>`)}</div></div>
    ${shown.length ? html`<ol class="tl-list">${rows}</ol>`
      : html`<p class="muted tl-none">${t(all.length ? "taskcard.nothingHere" : "taskcard.noActivity")}</p>`}
  </section>`;
}

// ── The comment box ───────────────────────────────────────

/**
 * The comment box: Ctrl+Enter or Send posts it; typing `@` offers the instance names (arrows and Enter or Tab choose, Esc
 * closes the list, not the box). `names`: [{ name, off }] — an instance with the task board off is listed, not choosable; one the
 * comment would reach (the chosen recipient, an @name in the text) with the board off is named under the box, with where to turn it on.
 * `recipients` { groups, initial, held }: the chip under the box says whom the comment is for ("dev · starts when sent", or "No agent
 * notified") and lists the others; it starts as `initial` and follows it until the person chooses. `held`: `initial` is the assignee of a
 * card that still waits on another card, so the chip says it is not woken until the card is ready, and nothing is sent about recipients
 * until the person chooses. `onSend(text, to, held)` resolves "ok" for the text to clear; `to` is the chosen instance's name or null,
 * `held` true when the person did not choose and the chip is held (send no recipient list). `variant: "reply"`: the box under a thread (Cancel, focused).
 */
export function Composer({ placeholder, names, assignee, onSend, recipients = null, variant = "", autoFocus = false, onCancel = null }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState(null);      // null: the person has not chosen — the chip follows the card's default
  const busy = useRef(false);
  const box = useRef(null);
  const pending = useRef(null);   // where the caret goes once the inserted name is in the box
  const to = recipients ? (chosen ? chosen.name : recipients.initial) : undefined;
  const held = !!recipients && !chosen && !!recipients.held;
  const m = hidden ? null : mentionAt(text, caret);
  const found = m ? mentionMatches(names.map((n) => n.name), m.query).map((n) => names.find((x) => x.name === n)) : [];
  const open = found.length > 0;
  useEffect(() => { setActive(0); }, [m ? m.query : null, open]);
  useEffect(() => {
    if (pending.current === null || !box.current) return;
    const c = pending.current;
    pending.current = null;
    try { box.current.focus(); box.current.setSelectionRange(c, c); } catch { /* no selection API */ }
  });
  useEffect(() => { if (autoFocus && box.current) { try { box.current.focus({ preventScroll: false }); } catch { /* no focus API */ } } }, []);
  const note = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);
  function choose(item) {
    if (!item || item.off || !m) return;
    const r = insertMention(text, m, caret, item.name, names.map((n) => n.name));
    pending.current = r.caret;
    setText(r.text);
    setCaret(r.caret);
  }
  async function send() {
    if (!text.trim() || busy.current) return;
    busy.current = true;
    setSending(true);
    try { if ((await onSend(text.trim(), to === undefined ? undefined : to, held)) === "ok") { setText(""); setCaret(0); } } finally { setSending(false); busy.current = false; }
  }
  function onKey(e) {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length); return; }
    if (open && (e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      if (found[active] && !found[active].off) { e.preventDefault(); choose(found[active]); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (open) setHidden(true); else if (onCancel) onCancel(); else e.currentTarget.blur(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
  }
  // The card's assignee with the board off is named before anything is typed (that is why the chip starts at nobody) — until the person
  // chooses someone else, or nobody; an @name in the words with the board off is named as it is typed.
  return html`<${BoardOffNote} names=${boardOffTargets(names, chosen ? chosen.name : assignee, text)} textKey="tasks.boardOffCommentNote" />
  <div class=${`tc-composer${variant ? ` tc-${variant}` : ""}`}>
    <div class="tc-compose-box">
      ${open ? html`<ul class="tc-mentions" role="listbox" aria-label=${t("taskcard.mentionList")}>${found.map((n, i) => html`<li key=${n.name} role="option" aria-selected=${i === active ? "true" : "false"} class=${i === active ? "active" : ""}>
        <button type="button" tabindex="-1" disabled=${!!n.off} title=${n.off ? t("tasks.boardOffHint") : undefined}
          onPointerDown=${(e) => e.preventDefault()} onClick=${() => choose(n)}>
          <span class="tc-mention-name">@${n.name}</span>${n.off ? html`<span class="muted">${t("taskcard.boardOffShort")}</span>` : null}</button></li>`)}</ul>` : null}
      <textarea ref=${box} rows=${variant === "reply" ? 2 : 3} value=${text} placeholder=${placeholder} aria-label=${t("taskcard.commentHint")}
        aria-autocomplete="list" aria-expanded=${open ? "true" : "false"}
        onInput=${(e) => { setText(e.target.value); setHidden(false); note(e); }} onClick=${note} onKeyUp=${(e) => { if (/^(Arrow|Home$|End$)/.test(String(e.key || ""))) note(e); }}
        onKeyDown=${onKey}></textarea>
    </div>
    <div class="tc-compose-foot">
      ${recipients ? html`<${RecipientChip} groups=${recipients.groups} value=${to} held=${held} onChange=${(name) => setChosen({ name })} />` : null}
      <span class="tc-compose-actions">
        ${onCancel ? html`<button type="button" class="btn btn-sm" onClick=${onCancel}>${t("taskthread.cancel")}</button>` : null}
        <button type="button" class="btn btn-primary btn-sm" disabled=${sending || !text.trim()} onClick=${send}>${t("taskcard.send")}</button></span>
    </div>
  </div>`;
}
