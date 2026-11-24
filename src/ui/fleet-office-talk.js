// Talking to an agent from the Office, without leaving it. One store (createTalk) under three ways to show it, picked
// per browser in the Office bar (TALK_MODES): "window" (the chat in a pop-up window, as before), "panel" (a side panel
// of the conversation; a bottom sheet on a phone), "box" (type under the dialogue box) and "bubble" (the reply over the
// agent's head). The store reads a thread's recent history (GET /ui/history), sends (POST /ui/send, as the chat does)
// and follows the page's live `message` events, so every mode shows the same conversation. Never on a share link.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import { nineSlice, wrap } from "./fleet-office-dialogue.js";

register("otalk", {
  en: {
    mode: "Talk", modeTitle: "How you talk to someone here (this browser only)",
    window: "Pop-up window", panel: "Side panel", box: "Dialogue box", bubble: "Over their head",
    placeholder: "Say something to {0}…", pick: "Click someone, then Talk, to talk to them here", send: "Send",
    full: "Open full chat", reply: "Full reply", close: "Close", loading: "Loading…", failed: "Not sent — try again",
    empty: "No messages yet. Say hello.", sending: "Sending…", talkTo: "Talking to {0}", file: "[a file]",
    next: "Click: the rest, the next page, or close",
  },
  "zh-TW": {
    mode: "對話方式", modeTitle: "在這裡跟成員對話的方式（只限這個瀏覽器）",
    window: "彈出視窗", panel: "側邊面板", box: "對話框", bubble: "頭頂氣泡",
    placeholder: "對 {0} 說…", pick: "點一個角色，再按「對話」就能在這裡跟他說話", send: "送出",
    full: "開啟完整聊天", reply: "完整回覆", close: "關閉", loading: "載入中…", failed: "沒送出去，請再試一次",
    empty: "還沒有訊息，打個招呼吧。", sending: "傳送中…", talkTo: "正在和 {0} 對話", file: "［檔案］",
    next: "點一下：顯示全部、下一頁或關閉",
  },
});
const tt = (k, ...v) => t(`otalk.${k}`, ...v);
/** This module's words (the Office bar's picker uses them). */
export const talkWord = tt;

export const TALK_MODES = ["window", "panel", "box", "bubble"];
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
 * `thread(name)` { msgs, loaded, error }; `lastReply(name)`; `subscribe(fn)`. `fetch` and `rid` are the page's.
 */
export function createTalk({ fetch: f = (...a) => fetch(...a), rid = () => `ot${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` } = {}) {
  const threads = new Map(), subs = new Set(), said = new Map();   // said: name → { text, at } (its last live reply)
  const changed = (name) => { for (const fn of [...subs]) fn(name); };
  const thread = (name) => { if (!threads.has(name)) threads.set(name, { msgs: [], loaded: false, loading: false, error: false }); return threads.get(name); };
  const row = (m) => {
    const text = talkTextOf(m);
    return text === null ? null : { key: `${m.boot}-${m.id}`, role: m.role, text, ts: m.ts };
  };
  const keep = (th) => { if (th.msgs.length > KEEP) th.msgs.splice(0, th.msgs.length - KEEP); };
  return {
    thread: (name) => thread(name),
    /** The live reply still over `name`'s head at `t` ({ text, at }), else null (replyHoldMs). */
    recent(name, t) { const r = said.get(name); return r && t - r.at < replyHoldMs(r.text) ? r : null; },
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
        keep(th); th.loaded = true; th.error = !d;
      } catch { th.error = true; }
      th.loading = false; changed(name);
    },
    async send(name, text) {
      const words = String(text || "").trim();
      if (!words) return false;
      const th = thread(name), clientId = rid(), mine = { key: `c-${clientId}`, role: "user", text: words, pending: true, clientId };
      th.msgs.push(mine); keep(th); changed(name);
      try {
        const r = await f("/ui/send", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: name, message: words, clientId }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error || d.sent === false) throw new Error(d.error || "send");
        mine.pending = false;
      } catch { mine.pending = false; mine.failed = true; }
      changed(name);
      return !mine.failed;
    },
    take(m) {
      if (!m || typeof m.instance !== "string" || !threads.has(m.instance)) return;
      const r = row(m);
      if (!r) return;
      const th = threads.get(m.instance);
      if (th.msgs.some((x) => x.key === r.key)) return;
      const i = m.role === "user" && m.clientId ? th.msgs.findIndex((x) => x.clientId === m.clientId) : -1;
      if (i >= 0) th.msgs[i] = r; else th.msgs.push(r);
      if (r.role === "agent") said.set(m.instance, { text: r.text, at: Date.now() });
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

/** A textarea that sends on Enter (Shift+Enter: a new line; never mid-IME composition). */
function Composer({ talk, name, label, autoFocus }) {
  const [text, setText] = useState(""), ref = useRef(null);
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
export function TalkPanel({ talk, name, label, state, sheet, onClose, onFull, top = null }) {
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
      <div class="ot-who"><strong>${label}</strong>${state ? html`<span class=${`ot-state st-${state}`}>${state}</span>` : null}</div>
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
export function TalkBar({ talk, name, label, onFull }) {
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
    </div>
  </div>`;
}

// ── Variant C: the reply over the agent's head ──
/** How long a reply stays over a head (ms): longer for more words. */
export const replyHoldMs = (text) => Math.min(20000, 6000 + 60 * [...String(text || "")].length);
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
 * A reply in a bubble over a head, its tail at (x, y) (logical units: the map's transform): the name, then at most
 * REPLY.lines wrapped lines (the last cut with …). `age`: ms since it arrived, for its entrance (pop / fade / none; 0:
 * whole at once); `frame` { im, slice, k }: a 9-slice picture instead of the drawn box. Returns the box.
 */
export function drawReply(ctx, x, y, name, text, age, style, frame) {
  ctx.save();
  const font = (wt) => `${wt} ${REPLY.font}px system-ui, sans-serif`;
  ctx.font = font(400);
  const lines = wrap((s) => ctx.measureText(s).width, text, REPLY.w, REPLY.lines);
  const textW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  ctx.font = font(700);
  const nameW = name ? ctx.measureText(name).width : 0;
  const w = Math.ceil(Math.max(nameW, textW) + REPLY.pad * 2), h = (name ? REPLY.line : 0) + lines.length * REPLY.line + REPLY.pad * 2 - 2;
  const bx = Math.round(x - Math.min(24, w / 2)), by = Math.round(y - h - 10);
  const f = age > 0 ? Math.min(1, age / REPLY.enterMs) : 1, ease = 1 - (1 - f) ** 3;
  if (style.enter === "fade") ctx.globalAlpha *= ease;
  if (style.enter === "pop" && f < 1) {
    const k = 0.6 + 0.4 * ease + Math.sin(f * Math.PI) * 0.06;
    ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-x, -y); ctx.globalAlpha *= Math.min(1, f * 2);
  }
  ctx.fillStyle = style.background; ctx.strokeStyle = style.border; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x - 5, by + h - 1); ctx.lineTo(x, y); ctx.lineTo(x + 6, by + h - 1); ctx.closePath(); ctx.fill(); ctx.stroke();
  if (!(frame && frame.im && nineSlice(ctx, frame.im, frame.slice, bx, by, w, h, frame.k))) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, w, h, 7); else ctx.rect(bx, by, w, h);
    ctx.fill(); ctx.stroke();
    ctx.fillRect(x - 4, by + h - 2, 9, 3);   // the tail joins the box without a seam
  }
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  let ty = by + REPLY.pad - 1;
  if (name) { ctx.font = font(700); ctx.fillStyle = style.name; ctx.fillText(name, bx + REPLY.pad, ty); ty += REPLY.line; }
  ctx.font = font(400); ctx.fillStyle = style.text;
  for (const l of lines) { ctx.fillText(l, bx + REPLY.pad, ty); ty += REPLY.line; }
  ctx.restore();
  return { x: bx, y: by, w, h };
}
