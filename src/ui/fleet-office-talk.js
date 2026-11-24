// Talking to an agent from the Office, without leaving it. One store (createTalk) under three ways to show it, picked
// per browser in the Office bar (TALK_MODES): "window" (the chat in a pop-up window, as before), "panel" (a side panel
// of the conversation; a bottom sheet on a phone), "box" (type under the dialogue box) and "bubble" (the reply over the
// agent's head). The store reads a thread's recent history (GET /ui/history), sends (POST /ui/send, as the chat does)
// and follows the page's live `message` events, so every mode shows the same conversation. Never on a share link.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import { nineSlice, typed, wrap } from "./fleet-office-dialogue.js";

register("otalk", {
  en: {
    mode: "Talk", modeTitle: "How you talk to someone here (this browser only)",
    window: "Pop-up window", panel: "Side panel", box: "Dialogue box", bubble: "Over their head",
    placeholder: "Say something to {0}…", pick: "Click someone, then Talk, to talk to them here", send: "Send",
    full: "Open full chat", reply: "Full reply", close: "Close", loading: "Loading…", failed: "Not sent — try again",
    empty: "No messages yet. Say hello.", sending: "Sending…", talkTo: "Talking to {0}", file: "[a file]",
    next: "Click: the rest, the next page, or close",
    you: "You", history: "History",
    play: "Reading", read_click: "Click", read_auto: "Auto", read_fast: "Fast", skip: "Skip",
    readTitle: "Click: each line waits for a click. Auto: it goes on by itself. Fast: quickly. Skip: close every reply now.",
  },
  "zh-TW": {
    mode: "對話方式", modeTitle: "在這裡跟成員對話的方式（只限這個瀏覽器）",
    window: "彈出視窗", panel: "側邊面板", box: "對話框", bubble: "頭頂氣泡",
    placeholder: "對 {0} 說…", pick: "點一個角色，再按「對話」就能在這裡跟他說話", send: "送出",
    full: "開啟完整聊天", reply: "完整回覆", close: "關閉", loading: "載入中…", failed: "沒送出去，請再試一次",
    empty: "還沒有訊息，打個招呼吧。", sending: "傳送中…", talkTo: "正在和 {0} 對話", file: "［檔案］",
    next: "點一下：顯示全部、下一頁或關閉",
    you: "你", history: "歷史紀錄",
    play: "播放", read_click: "點擊", read_auto: "自動", read_fast: "快速", skip: "跳過",
    readTitle: "點擊：每句等你點一下。自動：自己往下播。快速：很快地往下播。跳過：現在就關掉所有回覆。",
  },
});
const tt = (k, ...v) => t(`otalk.${k}`, ...v);
/** This module's words (the Office bar's picker uses them). */
export const talkWord = tt;

export const TALK_MODES = ["window", "panel", "box", "bubble"];
/** How a reply plays in the box and the bubble, as in a visual novel (per browser): wait for a click, go on, go fast. */
export const READ_MODES = ["click", "auto", "fast"];
export const readModeOf = (v) => (READ_MODES.includes(v) ? v : "click");
/** Typing speed (characters a second) and how long a typed page stays before it goes on by itself (ms; ∞: a click). */
export function readPace(mode, chars = 0) {
  if (mode === "fast") return { cps: 200, wait: 450 };
  return { cps: 40, wait: mode === "auto" ? Math.min(5000, 1400 + 35 * chars) : Infinity };
}
/** A stored mode, or the default (the pop-up window: the Office as it was). */
export const talkModeOf = (v) => (TALK_MODES.includes(v) ? v : "window");
const HISTORY = 50, KEEP = 200;

/** What a message says in the Office: its text (a button's label), "[a file]" for files alone; null for anything else. */
export function talkTextOf(m) {
  if (!m || (m.role !== "user" && m.role !== "agent")) return null;
  const said = m.click && typeof m.click.label === "string" ? m.click.label : typeof m.text === "string" ? m.text : "";
  if (said.trim()) return said;
  return Array.isArray(m.attachments) && m.attachments.length ? tt("file") : null;
}

/**
 * The conversations: `open(name)` reads its recent history once; `send(name, text)` shows it at once (pending) and
 * posts it; `take(m)` a live `message` event (the server's copy of a pending send replaces it, by clientId);
 * #4406: whichever comes first — the history, the send's answer or the live copy — the server's copy settles the
 * page's own (its messageId from the send's answer, or its clientId on the live copy), as the chat does (chat-store's
 * settleOutgoing), so a reply never shows twice;
 * `thread(name)` { msgs, loaded, error }; `lastReply(name)`; `subscribe(fn)`. `fetch` and `rid` are the page's.
 */
export function createTalk({ fetch: f = (...a) => fetch(...a), rid = () => `ot${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` } = {}) {
  // said: name → its last live reply over the head, { text, at, page, pageAt, pages, whole, wholeAt } (the drawing
  // fills pages / whole / wholeAt; advance() turns the page or lets it go).
  const threads = new Map(), subs = new Set(), said = new Map();
  const changed = (name) => { for (const fn of [...subs]) fn(name); };
  const thread = (name) => { if (!threads.has(name)) threads.set(name, { msgs: [], loaded: false, loading: false, error: false }); return threads.get(name); };
  const row = (m) => {
    const text = talkTextOf(m);
    if (text === null) return null;
    const r = { key: `${m.boot}-${m.id}`, role: m.role, text, ts: m.ts };
    if (typeof m.messageId === "string" && m.messageId) r.messageId = m.messageId;
    if (m.role === "user" && typeof m.clientId === "string" && m.clientId) r.clientId = m.clientId;   // the live copy's only
    return r;
  };
  /** The page's own sends that the server's copy now stands for (same messageId, or same clientId): gone. Whether any went. */
  const settle = (th) => {
    const ids = new Set(), cids = new Set();
    for (const x of th.msgs) if (!x.local) { if (x.messageId) ids.add(x.messageId); if (x.clientId) cids.add(x.clientId); }
    const n = th.msgs.length;
    th.msgs = th.msgs.filter((x) => !(x.local && ((x.messageId && ids.has(x.messageId)) || cids.has(x.clientId))));
    return th.msgs.length !== n;
  };
  const keep = (th) => { if (th.msgs.length > KEEP) th.msgs.splice(0, th.msgs.length - KEEP); };
  return {
    thread: (name) => thread(name),
    /** The live reply over `name`'s head, until it is read (advance) or skipped; else null. */
    recent(name) { return said.get(name) || null; },
    /** A click on it (or its turn to go on): the page whole while it types, else the next page, else it goes. */
    advance(name) {
      const r = said.get(name);
      if (!r) return;
      if (!r.whole) r.pageAt = -1e15;
      else if (r.page < r.pages - 1) { r.page++; r.pageAt = Date.now(); r.whole = false; r.wholeAt = null; }
      else said.delete(name);
      changed(name);
    },
    /** Skip: every reply over a head goes now. */
    skipAll() { const names = [...said.keys()]; said.clear(); for (const n of names) changed(n); },
    lastReply(name) { const m = [...thread(name).msgs].reverse().find((x) => x.role === "agent"); return m ? m.text : null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async open(name) {
      const th = thread(name);
      if (th.loaded || th.loading) return;
      th.loading = true; changed(name);
      try {
        const r = await f(`/ui/history?instance=${encodeURIComponent(name)}&limit=${HISTORY}`, { credentials: "same-origin" });
        const d = r && r.ok ? await r.json() : null;
        const old = Array.isArray(d && d.messages) ? d.messages.map(row).filter(Boolean) : [];
        const have = new Set(th.msgs.map((m) => m.key));
        th.msgs = [...old.filter((m) => !have.has(m.key)), ...th.msgs];
        settle(th); keep(th); th.loaded = true; th.error = !d;
      } catch { th.error = true; }
      th.loading = false; changed(name);
    },
    async send(name, text) {
      const words = String(text || "").trim();
      if (!words) return false;
      const th = thread(name), clientId = rid(), mine = { key: `c-${clientId}`, role: "user", text: words, pending: true, clientId, local: true };
      th.msgs.push(mine); keep(th); changed(name);
      try {
        const r = await f("/ui/send", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: name, message: words, clientId }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error || d.sent === false) throw new Error(d.error || "send");
        mine.pending = false;
        if (typeof d.messageId === "string" && d.messageId) { mine.messageId = d.messageId; settle(th); }
      } catch { mine.pending = false; mine.failed = true; }
      changed(name);
      return !mine.failed;
    },
    take(m) {
      if (!m || typeof m.instance !== "string" || !threads.has(m.instance)) return;
      const r = row(m);
      if (!r) return;
      const th = threads.get(m.instance);
      // Already here (the history brought it first): only the page's own copy of it may still have to go.
      const had = th.msgs.find((x) => x.key === r.key);
      if (had) { if (r.clientId && !had.local) had.clientId = r.clientId; if (settle(th)) changed(m.instance); return; }
      const i = m.role === "user" && m.clientId ? th.msgs.findIndex((x) => x.local && x.clientId === m.clientId) : -1;
      if (i >= 0) th.msgs[i] = r; else th.msgs.push(r);
      settle(th);
      if (r.role === "agent") said.set(m.instance, { text: r.text, at: Date.now(), page: 0, pageAt: null, pages: 1, whole: false, wholeAt: null });
      keep(th); changed(m.instance);
    },
  };
}

/** Re-render on a change to `name`'s thread. */
function useThread(talk, name) {
  const [, bump] = useState(0);
  useEffect(() => (talk && name ? talk.subscribe((n) => { if (n === name) bump((x) => x + 1); }) : undefined), [talk, name]);
  useEffect(() => { if (talk && name) void talk.open(name); }, [talk, name]);
  return talk && name ? talk.thread(name) : null;
}

/** Markdown as the chat renders it: escaped first, then a fixed set of tags (shared/chat-render.js). */
const md = (text) => {
  const R = globalThis.AgendChatRender;
  return R && typeof R.renderMarkdown === "function" ? R.renderMarkdown(text) : String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
};

/**
 * A textarea that sends on Enter (Shift+Enter: a new line; never mid-IME composition). #4406: each draft is its
 * target's — switching to someone else (a click, or the dialogue box's front speaker changing) shows theirs, never
 * carries the words typed for the one before; going back finds them again.
 */
function Composer({ talk, name, label, autoFocus }) {
  const [drafts, setDrafts] = useState(() => new Map()), ref = useRef(null);
  const text = (name && drafts.get(name)) || "";
  const setText = (v) => setDrafts((d) => { const n = new Map(d); if (v) n.set(name, v); else n.delete(name); return n; });
  useEffect(() => { if (autoFocus && ref.current) ref.current.focus(); }, [name, autoFocus]);
  const go = () => { const v = text.trim(); if (!v || !name) return; setText(""); void talk.send(name, v); };
  const key = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); go(); } };
  return html`<div class="ot-compose">
    <textarea ref=${ref} rows="1" class="ot-input" value=${text} disabled=${!name} aria-label=${name ? tt("placeholder", label) : tt("pick")}
      placeholder=${name ? tt("placeholder", label) : tt("pick")} onInput=${(e) => setText(e.target.value)} onKeyDown=${key}></textarea>
    <button type="button" class="btn btn-sm btn-primary ot-send" disabled=${!name || !text.trim()} onClick=${go}>${tt("send")}</button>
  </div>`;
}

/** Variant A: the conversation in a side panel (a bottom sheet on a phone). */
export function TalkPanel({ talk, name, label, state, stateLabel = null, sheet, onClose, onFull, top = null }) {
  const th = useThread(talk, name), list = useRef(null), box = useRef(null);
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [th && th.msgs.length, name]);
  // Where the map starts (beside it, not over the bar); set as a property: the page's CSP allows no style attribute.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && el.style) { if (top === null || sheet) el.style.removeProperty("top"); else el.style.setProperty("top", `${top}px`); }
  }, [top, sheet, name]);
  if (!name) return null;
  return html`<aside ref=${box} class=${`ot-panel${sheet ? " sheet" : ""}`} role="complementary" aria-label=${tt("talkTo", label)}>
    <header class="ot-head">
      <div class="ot-who"><strong>${label}</strong>${state ? html`<span class=${`ot-state st-${state}`}>${stateLabel || state}</span>` : null}</div>
      ${onFull ? html`<button type="button" class="btn btn-sm btn-ghost ot-full" onClick=${onFull}>${tt("full")}</button>` : null}
      <button type="button" class="icon-btn ot-close" aria-label=${tt("close")} title=${tt("close")} onClick=${onClose}>×</button>
    </header>
    <ol class="ot-list" ref=${list} aria-live="polite">
      ${th && th.loading && !th.msgs.length ? html`<li class="ot-note">${tt("loading")}</li>` : null}
      ${th && th.loaded && !th.msgs.length ? html`<li class="ot-note">${tt("empty")}</li>` : null}
      ${(th ? th.msgs : []).map((m) => html`<li key=${m.key} class=${`ot-msg ${m.role === "user" ? "me" : "agent"}${m.pending ? " pending" : ""}${m.failed ? " failed" : ""}`}>
        ${m.role === "agent" ? html`<div class="ot-md" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>` : html`<div class="ot-plain">${m.text}</div>`}
        ${m.pending ? html`<small class="ot-meta">${tt("sending")}</small>` : m.failed ? html`<small class="ot-meta ot-bad">${tt("failed")}</small>` : null}
      </li>`)}
    </ol>
    <${Composer} talk=${talk} name=${name} label=${label} autoFocus=${true} />
  </aside>`;
}

/** Variants B and C: a line to type in under the dialogue box, and the last reply in full on demand. */
export function TalkBar({ talk, name, label, onFull, read = null, onRead = null, onSkip = null }) {
  const th = useThread(talk, name), [open, setOpen] = useState(false);
  const reply = th ? talk.lastReply(name) : null;
  useEffect(() => { setOpen(false); }, [name]);
  return html`<div class="ot-bar">
    ${open && reply ? html`<div class="ot-reply" role="region" aria-label=${tt("reply")}>
      <div class="ot-md" dangerouslySetInnerHTML=${{ __html: md(reply) }}></div>
      <button type="button" class="icon-btn ot-close" aria-label=${tt("close")} onClick=${() => setOpen(false)}>×</button>
    </div>` : null}
    <div class="ot-bar-row">
      ${name ? html`<span class="ot-to">${label}</span>` : null}
      <${Composer} talk=${talk} name=${name} label=${label} autoFocus=${false} />
      ${reply ? html`<button type="button" class="btn btn-sm btn-ghost ot-more" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${tt("reply")}</button>` : null}
      ${name && onFull ? html`<button type="button" class="btn btn-sm btn-ghost ot-full" onClick=${onFull}>${tt("full")}</button>` : null}
      ${onRead ? html`<div class="ot-play" role="group" aria-label=${tt("play")} title=${tt("readTitle")}>
        ${READ_MODES.map((m) => html`<button key=${m} type="button" class=${`btn btn-sm ot-read${read === m ? " on" : ""}`} aria-pressed=${read === m ? "true" : "false"}
          onClick=${() => onRead(m)}>${tt(`read_${m}`)}</button>`)}
        <button type="button" class="btn btn-sm ot-skip" onClick=${onSkip}>${tt("skip")}</button>
      </div>` : null}
    </div>
  </div>`;
}

// ── Variant B, on the scene: the dialogue box laid over the foot of the Office, a visual novel's ──
// The Office keeps its size and place: the box, the portrait and the line to type in are an overlay on the stage.
// Only the agent's side: what was said to it is in History (TalkLog). `peek()` (the Office's) is what it shows now:
// { name, label, conv, status, portrait, colours, more } or null; `ops` { now, drop(instance), skip(), target(name) }. Each conversation keeps its page and typing
// (page, pageAt, wholeAt, shownAt, replyShownAt) as the canvas box did.
const PAGE_LINES = { desk: 2, phone: 3 };
let measureCtx = null;
const measurer = (font) => {
  if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return (s) => [...s].length * 16;
  measureCtx.font = font;
  return (s) => measureCtx.measureText(s).width;
};
export function TalkStage({ peek, ops, talk, read, onRead, phone, onFull, onClose, still = false }) {
  const [, tick] = useState(0), [log, setLog] = useState(false), reply = useRef(null), root = useRef(null), fig = useRef(null);
  const v = peek();
  const live = !!(v && v.conv);
  useEffect(() => {
    if (!v) return undefined;
    // Reduced motion (`still`, the canvas box's own): nothing types, so a slow tick only for Auto / Fast's waits.
    const h = setInterval(() => tick((x) => x + 1), still ? 250 : 50);
    return () => clearInterval(h);
  }, [!!v, still]);
  // The text keeps clear of the portrait: its drawn width, as a property (the page's CSP allows no style attribute).
  useLayoutEffect(() => {
    const el = root.current, im = fig.current;
    if (!el || !el.style) return;
    // Beside the portrait (a desk): the words end where the drawn figure begins (object-fit: contain, at the right).
    const box = el.querySelector(".ot-box");
    let pad = 0;
    if (!phone && box && im && im.complete && im.naturalWidth) {
      const br = box.getBoundingClientRect(), fr = im.getBoundingClientRect();
      const drawnW = Math.min(fr.width, (fr.height * im.naturalWidth) / im.naturalHeight);
      pad = Math.max(0, Math.round(br.right - (fr.right - drawnW)));
    }
    el.style.setProperty("--ot-pad", `${pad}px`);
    // The pack's dialogBox colours, else a visual novel's night blue and gold.
    const k = (v && v.colours) || {};
    for (const [name, val] of [["--ot-bg", k.background || "#141b2d"], ["--ot-gold", k.border || "#c8a165"], ["--ot-text", k.text || "#f4f1ea"], ["--ot-name", k.name || "#ffd27a"]]) el.style.setProperty(name, val);
  });
  if (!v) return null;
  const t = ops.now(), c = v.conv;
  // The reply, page by page (PAGE_LINES), typed at the reading mode's pace; the heard line stays whole.
  let lines = [], page = 0, pages = 1, n = Infinity, whole = true, pageChars = 0;
  const answered = !!(c && c.answeredAt !== null);
  if (c) {
    if (c.shownAt == null) c.shownAt = t;
    if (answered && c.replyShownAt == null) c.replyShownAt = t;
  }
  if (answered) {
    const el = reply.current, w = el ? el.clientWidth : 0;
    const cs = typeof getComputedStyle === "function" && el ? getComputedStyle(el) : null;
    const all = w > 0 ? wrap(measurer((cs && cs.font) || "16px sans-serif"), c.replyFull ?? c.reply ?? "", w, 400) : [c.replyFull ?? c.reply ?? ""];
    const per = phone ? PAGE_LINES.phone : PAGE_LINES.desk;
    pages = Math.max(1, Math.ceil(all.length / per)); page = Math.min(c.page || 0, pages - 1);
    lines = all.slice(page * per, page * per + per);
    pageChars = lines.reduce((a, l) => a + [...l].length, 0);
    const pace = readPace(read, pageChars);
    n = still ? Infinity : Math.floor(((t - (c.pageAt ?? c.replyShownAt)) * pace.cps) / 1000);
    whole = n >= pageChars;
    if (whole && c.wholeAt == null) c.wholeAt = t;
    if (whole && pace.wait < Infinity && t - c.wholeAt >= pace.wait) setTimeout(() => step(true), 0);
  }
  const last = page >= pages - 1;
  function step(auto = false) {
    if (!auto && v.name) ops.target(v.name);   // the line below talks to whoever the box shows
    if (!c || !answered) return;
    if (!whole) c.pageAt = -1e15;
    else if (!last) { c.page = page + 1; c.pageAt = ops.now(); c.wholeAt = null; }
    else ops.drop(c.instance);
    tick((x) => x + 1);
  }
  const shown = answered ? typed(lines, n).join("\n") : "";
  const keep = (e) => e.stopPropagation();   // the stage's pan, zoom keys and clicks stay off the box
  return html`<div class=${`ot-stage${phone ? " phone" : ""}`} ref=${root} onPointerDown=${keep} onKeyDown=${keep} onWheel=${keep} onClick=${keep}>
    ${v.portrait ? html`<img class="ot-figure" ref=${fig} src=${v.portrait} alt="" draggable="false" />` : null}
    <div class=${`ot-box${live ? " live" : ""}`} role="group" aria-label=${tt("talkTo", v.label)}>
      ${log ? html`<${TalkLog} talk=${talk} name=${v.name} label=${v.label} onFull=${onFull} onClose=${() => setLog(false)} />` : null}
      <div class="ot-tools">
        ${READ_MODES.map((m) => html`<button key=${m} type="button" class=${`ot-tool${read === m ? " on" : ""}`} aria-pressed=${read === m ? "true" : "false"} onClick=${() => onRead(m)}>${tt(`read_${m}`)}</button>`)}
        <button type="button" class="ot-tool" onClick=${ops.skip}>${tt("skip")}</button>
        <button type="button" class="ot-tool ot-x" aria-label=${tt("close")} title=${tt("close")} onClick=${onClose}>×</button>
      </div>
      <div class="ot-read" role="button" tabindex="0" aria-label=${tt("next")} onClick=${() => step()}
        onKeyDown=${(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); step(); } }}>
        <div class="ot-answer">
          <div class="ot-words" ref=${reply} aria-live="polite">${answered ? shown : html`<span class="ot-status">${live ? v.status || "" : ""}</span>`}${answered && whole ? html`<span class="ot-cue" aria-hidden="true">▼</span>` : null}</div>
          <span class="ot-plate ot-agent">${v.label}</span>
        </div>
        ${v.more > 0 ? html`<span class="ot-more-n">+${v.more}</span>` : null}
      </div>
      <div class="ot-line">
        <${Composer} talk=${talk} name=${v.name} label=${v.label} autoFocus=${!live} />
        <span class="ot-sep" aria-hidden="true">|</span>
        <button type="button" class="ot-link" aria-expanded=${log ? "true" : "false"} onClick=${() => setLog(!log)}>${tt("history")}</button>
      </div>
    </div>
  </div>`;
}

/** The box's history (a visual novel's backlog): both sides of the conversation, over the box; the full chat from it. */
function TalkLog({ talk, name, label, onFull, onClose }) {
  const th = useThread(talk, name), list = useRef(null);
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [th && th.msgs.length]);
  return html`<section class="ot-log" role="dialog" aria-label=${tt("history")}>
    <header class="ot-log-head">
      <strong>${tt("history")} · ${label}</strong>
      <button type="button" class="ot-link" onClick=${onFull}>${tt("full")}</button>
      <button type="button" class="ot-tool ot-x" aria-label=${tt("close")} title=${tt("close")} onClick=${onClose}>×</button>
    </header>
    <ol class="ot-log-list" ref=${list}>
      ${th && th.loading && !th.msgs.length ? html`<li class="ot-note">${tt("loading")}</li>` : null}
      ${th && th.loaded && !th.msgs.length ? html`<li class="ot-note">${tt("empty")}</li>` : null}
      ${(th ? th.msgs : []).map((m) => html`<li key=${m.key} class=${`ot-log-msg ${m.role === "user" ? "me" : "agent"}`}>
        <span class="ot-log-who">${m.role === "user" ? tt("you") : label}</span>
        ${m.role === "agent" ? html`<div class="ot-md" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>` : html`<div class="ot-plain">${m.text}</div>`}
        ${m.failed ? html`<small class="ot-meta ot-bad">${tt("failed")}</small>` : null}
      </li>`)}
    </ol>
  </section>`;
}

// ── Variant C: the reply over the agent's head ──
const REPLY = { w: 190, lines: 6, font: 11, line: 15, pad: 8, enterMs: 240 };
/** The bubble's look: the pack's `dialogBox.bubble`, else light paper (as the state bubbles). */
export function replyStyle(b, env) {
  const d = b || {};
  return {
    background: d.background || "#fffdf6", border: d.border || (env && env.mode === "light" ? "#8a8578" : "#4a4740"),
    text: d.text || "#1d1d22", name: d.name || "#6b5bd6", enter: d.enter || "pop",
  };
}
/**
 * A reply in a bubble over a head, its tail at (x, y) (logical units: the map's transform): the name, then a page of
 * REPLY.lines wrapped lines. `age`: ms since it arrived, for its entrance (pop / fade / none; 0: whole at once);
 * `frame` { im, slice, k }: a 9-slice picture instead of the drawn box; `read` { page, n }: that page, its first `n`
 * characters typed, and ▼ once it is whole (none: page 0, whole, no ▼). `fit` { l, r, t?, b? }: the box kept on screen
 * (#4406): between l and r, its tail still at x; over the head when it fits under t, else below it (tail up) when it
 * fits above b, else on the side with more room, clamped. Returns the box, the pages and the page's length.
 */
export function drawReply(ctx, x, y, name, text, age, style, frame, read = null, fit = null) {
  ctx.save();
  const font = (wt) => `${wt} ${REPLY.font}px system-ui, sans-serif`;
  ctx.font = font(400);
  const all = wrap((s) => ctx.measureText(s).width, text, REPLY.w, 400);
  const pages = Math.max(1, Math.ceil(all.length / REPLY.lines)), page = Math.min(read ? read.page || 0 : 0, pages - 1);
  const lines = all.slice(page * REPLY.lines, page * REPLY.lines + REPLY.lines);
  const len = lines.reduce((a, l) => a + [...l].length, 0), n = read && Number.isFinite(read.n) ? read.n : Infinity;
  const textW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  ctx.font = font(700);
  const nameW = name ? ctx.measureText(name).width : 0;
  const w = Math.ceil(Math.max(nameW, textW) + REPLY.pad * 2), h = (name ? REPLY.line : 0) + lines.length * REPLY.line + REPLY.pad * 2 - 2;
  let bx0 = x - Math.min(24, w / 2);
  if (fit) bx0 = Math.max(fit.l, Math.min(bx0, fit.r - w));
  let by0 = y - h - 10;
  if (fit && Number.isFinite(fit.t) && Number.isFinite(fit.b) && by0 < fit.t) {
    const under = y + 10;
    by0 = under + h <= fit.b || fit.b - y > y - fit.t ? under : by0;
    by0 = Math.max(fit.t, Math.min(by0, fit.b - h));
  }
  const bx = Math.round(bx0), by = Math.round(by0), below = by > y, over = by + h < y;
  const f = age > 0 ? Math.min(1, age / REPLY.enterMs) : 1, ease = 1 - (1 - f) ** 3;
  if (style.enter === "fade") ctx.globalAlpha *= ease;
  if (style.enter === "pop" && f < 1) {
    const k = 0.6 + 0.4 * ease + Math.sin(f * Math.PI) * 0.06;
    ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-x, -y); ctx.globalAlpha *= Math.min(1, f * 2);
  }
  ctx.fillStyle = style.background; ctx.strokeStyle = style.border; ctx.lineWidth = 1.5;
  const edge = below ? by + 1 : by + h - 1;   // the tail from the box's edge nearest the head (none when the box is over it)
  if (over || below) { ctx.beginPath(); ctx.moveTo(x - 5, edge); ctx.lineTo(x, y); ctx.lineTo(x + 6, edge); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  if (!(frame && frame.im && nineSlice(ctx, frame.im, frame.slice, bx, by, w, h, frame.k))) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, w, h, 7); else ctx.rect(bx, by, w, h);
    ctx.fill(); ctx.stroke();
    if (over || below) ctx.fillRect(x - 4, below ? by - 1 : by + h - 2, 9, 3);   // the tail joins the box without a seam
  }
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  let ty = by + REPLY.pad - 1;
  if (name) { ctx.font = font(700); ctx.fillStyle = style.name; ctx.fillText(name, bx + REPLY.pad, ty); ty += REPLY.line; }
  ctx.font = font(400); ctx.fillStyle = style.text;
  for (const l of typed(lines, n)) { ctx.fillText(l, bx + REPLY.pad, ty); ty += REPLY.line; }
  if (read && n >= len) { ctx.font = font(700); ctx.fillStyle = style.name; ctx.textAlign = "right"; ctx.fillText("▼", bx + w - 4, by + h - REPLY.line + 1); }
  ctx.restore();
  return { x: bx, y: by, w, h, pages, len };
}
