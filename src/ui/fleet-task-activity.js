// A card's activity (Fleet › Tasks › a card's page): the comments, the progress log and the history are one timeline, oldest
// first, with the comment box under it. The card API still returns the three lists apart (comments, logs, history); they are
// merged here, so nothing on the server changes. A history line that only repeats a comment or a log entry ("commented",
// "logged") is dropped from the merge — the entry itself is shown.
// The timeline is read for progress, so what people and agents SAY and DO leads it: a comment has no box — a name and a time,
// the text under it, drawn by the chat's own Markdown renderer (safe by construction: it escapes first); a progress note is a
// line with its words in the text colour; the history is the quietest thing on the page (small, grey, a run of the same line
// from the same hand is one line "×3"); and a day change is a thin separator.
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import "/assets/chat-strings.js";
import { Icon } from "/assets/ui-icons.js";
import { relTime } from "./fleet-task-common.js";
import { AgentTag } from "./fleet-task-run.js";
import { WhoCard } from "./fleet-task-owner.js";

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
  for (const e of (detail && detail.comments) || []) out.push({ key: `c${e.id}`, type: "comment", at: e.at, who: e.author, by: e.authorKind || "", text: e.text, kind: e.kind, authorKind: e.authorKind });
  for (const e of (detail && detail.logs) || []) out.push({ key: `l${e.id}`, type: "log", at: e.at, who: e.author, by: e.authorKind || "", text: e.text });
  for (const ev of (detail && detail.history) || []) {
    if (ev.type === "commented" || ev.type === "logged" || ev.type === "reordered") continue;   // a comment and a log entry are shown as themselves
    out.push({ key: `h${ev.id}`, type: "event", at: ev.at, who: ev.actor, by: ev.actorKind || "", ev });
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => when(a.e.at) - when(b.e.at) || RANK[a.e.type] - RANK[b.e.type] || a.i - b.i).map((x) => x.e);
}

/** The entries a filter shows: everything, or one kind of them. */
export function timelineShown(entries, filter) {
  const type = { comments: "comment", log: "log", history: "event" }[filter];
  return type ? entries.filter((e) => e.type === type) : entries;
}

// ── The timeline ──────────────────────────────────────────

const fullTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString() : ""; };

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

/** A comment's text as the chat draws a message (Markdown, escaped first); the plain text when the renderer is not there. */
const commentHtml = (text) => {
  const r = globalThis.AgendChatRender;
  return r && typeof r.renderMarkdown === "function" ? { __html: r.renderMarkdown(text) } : null;
};

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

// ── A comment's text as the chat draws a message ─────────────

/** The chat's copy: the clipboard, else a hidden text area (a plain-http page has no clipboard API). */
async function copyText(text) {
  try { if (navigator.clipboard && globalThis.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.className = "offscreen";
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
const storedWrap = () => { try { return localStorage.getItem("agend_code_wrap") === "1"; } catch { return false; } };

/**
 * Code blocks as the chat's thread draws them (chat-thread.js `decorateCode`, the same classes, so the same sheet styles them):
 * a header with the language, Wrap and Copy, and a block of more than CODE_FOLD_LINES lines folded until opened. Built from nodes.
 */
export function decorateCode(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const doc = root.ownerDocument;
  const R = globalThis.AgendChatRender;
  const limit = R && Number.isFinite(R.CODE_FOLD_LINES) ? R.CODE_FOLD_LINES : 30;
  const lineCount = R && typeof R.lineCount === "function" ? R.lineCount : (c) => String(c).split("\n").length;
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains("codeblock")) continue;
    const box = doc.createElement("div"); box.className = "codeblock";
    const head = doc.createElement("div"); head.className = "cb-head";
    const lang = doc.createElement("span"); lang.className = "cb-lang"; lang.textContent = pre.dataset.lang || "text";
    const wrap = doc.createElement("button"); wrap.type = "button"; wrap.className = "chip-btn"; wrap.dataset.act = "toggleWrap"; wrap.textContent = t("chat.wrap");
    const copy = doc.createElement("button"); copy.type = "button"; copy.className = "chip-btn"; copy.dataset.act = "copyCode"; copy.textContent = t("chat.copy");
    head.append(lang, wrap, copy);
    pre.replaceWith(box); box.append(head, pre);
    const lines = lineCount(pre.textContent);
    if (lines > limit) {
      box.classList.add("folded");
      const more = doc.createElement("button"); more.type = "button"; more.className = "cb-more"; more.dataset.act = "toggleFold";
      more.dataset.lines = String(lines); more.textContent = t("chat.showAll", lines);
      box.append(more);
    }
  }
}

/** A click on one of a decorated block's buttons (Copy, Wrap, Show all), as the chat's thread answers it. */
async function onCodeClick(e) {
  const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
  if (!el) return;
  const act = el.dataset.act;
  if (act === "copyCode") {
    const pre = el.closest(".codeblock") && el.closest(".codeblock").querySelector("pre");
    if (!pre) return;
    const ok = await copyText(pre.textContent);
    const was = el.dataset.label || el.textContent; el.dataset.label = was;
    el.textContent = t(ok ? "chat.copied" : "chat.copyFailed");
    setTimeout(() => { el.textContent = was; }, 1200);
  } else if (act === "toggleWrap") {
    const stream = el.closest(".tl");
    if (!stream) return;
    const on = stream.classList.toggle("wrap-code");
    try { localStorage.setItem("agend_code_wrap", on ? "1" : "0"); } catch { /* this page only */ }
  } else if (act === "toggleFold") {
    const box = el.closest(".codeblock");
    if (!box) return;
    const folded = box.classList.toggle("folded");
    el.textContent = !folded ? t("chat.showLess") : t("chat.showAll", el.dataset.lines);
  }
}

/** A comment's body: the chat's Markdown, its code blocks decorated as the chat's are. */
function MdBody({ body }) {
  const ref = useRef(null);
  useEffect(() => { decorateCode(ref.current); });
  return html`<div class="tl-body md" ref=${ref} onClick=${onCodeClick} dangerouslySetInnerHTML=${body}></div>`;
}

/**
 * One entry. A comment and a progress note are each a card (the same: a head with the avatar — an instance's with its state
 * dot —, the name, an "Agent" badge, a tag for what it is, and the time; the text under the name); a history line is a thin row
 * with an icon (a status change's is the status's), the sentence and the time, no box. `who`: the board's cards and the project's
 * lead, for the avatar's info card.
 */
function Entry({ entry, describe, who }) {
  const time = timeOf(entry);
  const agent = entry.by === "instance";
  const mark = agent ? " by-agent" : "";
  const kind = entry.by === "person" ? "person" : entry.by === "instance" ? "instance" : entry.by ? "none" : "";
  const author = html`<${WhoCard} name=${entry.who} kind=${kind} presence=${agent} cards=${who && who.cards} lead=${who && who.lead} />`;
  if (entry.type === "comment") {
    const body = commentHtml(entry.text);
    return html`<li class=${`tl-item tl-card tl-comment${entry.authorKind === "person" ? " person" : ""}${mark}`}>
      <div class="tl-head">${author}${agent ? html`<${AgentTag} />` : null}
        ${entry.kind === "reject" ? html`<span class="tb-tag st-blocked">${t("taskcard.rejectTag")}</span>` : null}
        ${entry.kind === "approve" ? html`<span class="tb-tag st-done">${t("taskcard.approveTag")}</span>` : null}
        ${time}</div>
      ${body ? html`<${MdBody} body=${body} />` : html`<div class="tl-body">${entry.text}</div>`}</li>`;
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

/** The activity stream with its filter (all, comments, progress log, history). `describe(ev)` words a history event. */
export function Timeline({ detail, describe, cards = [], lead = null }) {
  const [filter, setFilter] = useState("all");
  const [toggled, setToggled] = useState({});
  const all = timelineOf(detail);
  // The number on a filter button is the number of lines the list shows for it: a run of equal history lines is one.
  const count = (f) => collapseEvents(timelineShown(all, f), describe).length;
  const shown = collapseEvents(timelineShown(all, filter), describe);
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
  const rows = [];
  for (const part of parts) {
    if (part.day) rows.push(html`<li key=${`d${dayKey(part.day)}`} class="tl-day" role="presentation"><span>${dayLabel(part.day)}</span></li>`);
    for (const item of streamOf(part.entries, filter === "all")) {
      if (item.kind === "card") rows.push(html`<${Entry} key=${item.entry.key} entry=${item.entry} describe=${describe} who=${who} />`);
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
 * The comment box: Ctrl+Enter or Send posts the text as written; Esc leaves the box. `onSend(text)` resolves "ok" for the
 * text to clear.
 */
export function Composer({ placeholder, onSend }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  async function send() {
    if (!text.trim() || busy.current) return;
    busy.current = true;
    setSending(true);
    try { if ((await onSend(text.trim())) === "ok") setText(""); } finally { setSending(false); busy.current = false; }
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
  }
  return html`<div class="tc-composer">
    <div class="tc-compose-box">
      <textarea rows="3" value=${text} placeholder=${placeholder} aria-label=${t("taskcard.commentHint")}
        onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey}></textarea>
    </div>
    <button type="button" class="btn btn-primary btn-sm" disabled=${sending || !text.trim()} onClick=${send}>${t("taskcard.send")}</button>
  </div>`;
}
