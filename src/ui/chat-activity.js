// AGEND-181: the chat's interleaved activity timeline — above each agent reply, what the agent did to produce it
// (thinking, intermediate text, tool calls); the turn in progress grows live at the end of the thread.
//
//   observeActivity(name, …)   reads the instance's steps (GET /ui/steps, the Log's own read: masked and cut by the server,
//                              live by the stream's steps_tick) and composes the thread's rows with each turn's group.
//   ActivityBlock              one group: a native <details> in a `.card`, the rows of the Log (log-row.js) inside.
//   mountActivity(node, …)     a Preact island in a node of the chat's keyed DOM thread (chat-thread.js), updated in place
//                              — the same node for a live turn and for the reply it becomes (no remount, state kept).
//
// Nothing here runs unless the Log is on (<body data-log-tab="1">) and this browser has Show activity on (the ⋯ menu).
// The server decides who gets thinking (an admin session on the local dashboard); the page only hides it on request.
import { html, render, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { LogRow, collapse, mergeSteps, tl } from "./log-row.js";
import { composeRows, groupSteps } from "./chat-activity-groups.js";

register("act", {
  en: {
    steps: "{0} steps", step: "1 step", working: "Working…",
    lvl_text: "Matched by the reply's text", lvl_time: "Matched by time", lvl_turn: "Shown above the last reply of this turn", lvl_none: "Not tied to a reply",
    partial: "Earlier steps of this turn are not loaded.", earlier: "Show {0} earlier steps",
    notSent: "After the last reply (not sent)", menuActivity: "Show activity", menuThinking: "Show thinking",
  },
  "zh-TW": {
    steps: "{0} 個步驟", step: "1 個步驟", working: "處理中…",
    lvl_text: "依回覆的文字對應", lvl_time: "依時間對應", lvl_turn: "顯示在這一輪最後一則回覆上方", lvl_none: "沒有對應到回覆",
    partial: "這一輪較早的步驟尚未載入。", earlier: "顯示更早的 {0} 個步驟",
    notSent: "最後一則回覆之後（未送出）", menuActivity: "顯示活動", menuThinking: "顯示思考",
  },
});
const ta = (key, ...a) => t(`act.${key}`, ...a);

/** A group shows this many rows, the newest; "Show N earlier steps" adds EARLIER_STEP more each time. */
export const SHOWN_MAX = 30;
export const EARLIER_STEP = 12;
/** The steps this page keeps for an instance (the oldest are let go; the group of a reply they led to stays unfolded). */
export const STEPS_MAX = 800;
export const POLL_MS = 4000;
export const RENEW_MS = 30_000;

// ── this browser's choices (the chat's ⋯ menu) ─────────────────────────────────────────────────────────────
const ACT_KEY = "agend_chat_activity", THINK_KEY = "agend_chat_thinking";
const off = (k) => { try { return localStorage.getItem(k) === "off"; } catch { return false; } };
const keep = (k, on) => { try { if (on) localStorage.removeItem(k); else localStorage.setItem(k, "off"); } catch { /* this page only */ } };
export const activityPrefs = createStore({ on: !off(ACT_KEY), thinking: !off(THINK_KEY) });
export const setActivityOn = (on) => { keep(ACT_KEY, on); activityPrefs.set((s) => ({ ...s, on })); };
export const setActivityThinking = (on) => { keep(THINK_KEY, on); activityPrefs.set((s) => ({ ...s, thinking: on })); };
/** The server offers the timeline when the Log is on; thinking when `web.log_thinking` is too (the server still checks who asks). */
export const activityOffered = () => globalThis.document?.body?.dataset?.logTab === "1";
const thinkingOffered = () => globalThis.document?.body?.dataset?.logThinking === "1";

// ── the block ─────────────────────────────────────────────────────────────────────────────────────────────

function elapsed(ms) {
  if (!(ms >= 1000)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}
const countOf = (rows) => rows.reduce((n, x) => n + (x.repeat || 1), 0);

/** One group of steps. `ctx`: { paths: { cwd, home }, thinking: boolean }. */
export function ActivityBlock({ group, ctx }) {
  const [user, setUser] = useState(null);          // the reader's own open/closed, once they chose
  const [more, setMore] = useState(0);             // extra rows shown above the newest SHOWN_MAX
  const hide = !ctx.thinking;
  const rows = collapse(group.items.filter((s) => !(hide && s.kind === "thinking")));
  const tail = collapse(group.trailing.filter((s) => !(hide && s.kind === "thinking")));
  const live = !group.ended;
  // Open while it runs; shut when its reply arrives — unless the reader opened or shut it themselves.
  const open = user ?? live;
  const all = rows.length;
  const limit = SHOWN_MAX + more;
  const skipped = Math.max(0, all - limit);
  const shown = skipped ? rows.slice(skipped) : rows;
  const n = countOf(rows) + countOf(tail);
  const first = group.items[0] || group.trailing[0], last = group.trailing[group.trailing.length - 1] || group.items[group.items.length - 1];
  const dur = !live && first && last && first.ts && last.ts ? elapsed(last.ts - first.ts) : "";
  const inferred = group.level !== "id" && group.level !== "live" ? ta(`lvl_${group.level}`) : "";
  const title = live ? ta("working") : n === 1 ? ta("step") : ta("steps", n);
  const list = (items) => html`<ol class="log-list" role="list">${items.map((x, i) => html`<${LogRow} key=${`${x.kind}:${x.id}`} x=${x} prev=${items[i - 1]} paths=${ctx.paths} chat=${true} />`)}</ol>`;
  return html`<details class=${`card act-block${live ? " live" : ""}`} open=${open}>
    <summary class="act-sum" onClick=${(e) => { e.preventDefault(); setUser(!open); }} aria-expanded=${open ? "true" : "false"}>
      <span class="act-chev" aria-hidden="true"><${Icon} name="chevron" size=${14} /></span>
      ${live ? html`<span class="spinner act-spin" aria-hidden="true"></span>` : null}
      <span class="act-title">${title}</span>${dur ? html`<span class="act-dur">${dur}</span>` : null}
      ${inferred ? html`<span class="tag act-lvl" title=${inferred}>${inferred}</span>` : null}</summary>
    <div class="act-body">
      ${group.partial ? html`<p class="note act-partial">${ta("partial")}</p>` : null}
      ${skipped ? html`<button type="button" class="btn btn-sm act-earlier" onClick=${() => setMore(more + EARLIER_STEP)}>${ta("earlier", Math.min(skipped, EARLIER_STEP))}</button>` : null}
      ${shown.length ? list(shown) : null}
      ${tail.length ? html`<p class="note act-unsent">${group.turnEnded ? ta("notSent") : ""}</p>${list(tail)}` : null}
    </div></details>`;
}

/** Nothing worth a block: no row of the kinds shown once thinking is hidden. */
export function isEmptyGroup(group, ctx) {
  const shown = (s) => ctx.thinking || s.kind !== "thinking";
  return !group.items.some(shown) && !group.trailing.some(shown);
}

/** Put a group into `node` (a node of the chat's thread) as a Preact island; update it in place. */
export function mountActivity(node, group, ctx) {
  let cur = group;
  const draw = () => {
    const c = ctx();
    node.hidden = isEmptyGroup(cur, c);
    render(html`<${ActivityBlock} group=${cur} ctx=${c} />`, node);
  };
  draw();
  return { update(g) { cur = g; draw(); }, unmount() { render(null, node); } };
}

// ── the feed: the steps of one instance, read as the Log reads them ─────────────────────────────────────────────

/** What each instance's feed knew when it was last shown: a chat shown again starts from it (and reads what is new). */
const memory = new Map();
/** Tests only. */
export function forgetActivity() { memory.clear(); }
/** Bumped when an answer first tells whether thinking is sent (the ⋯ menu offers Show thinking only then). */
export const activityInfoStore = createStore({ v: 0 });
/** What the last answer for `name` said (cwd, home, whether thinking is sent, backend), or null: none read yet. */
export const activityInfo = (name) => memory.get(name)?.info ?? null;
/**
 * The thread's rows with each turn's group put in, from what this page already knows of `name` — also for a chat shown
 * again from memory, before its feed reads anything. No steps (or a server that does not offer them): the rows as they are.
 */
export function composeActivity(name, rows, now = Date.now()) {
  const s = memory.get(name);
  if (!s || s.dead || !s.steps.length) return rows;
  return composeRows(rows, groupSteps(rows, s.steps, { now, complete: s.complete }));
}

/**
 * Read an instance's steps for its chat. `changed()` is called when the composed rows may differ. Returns
 * { start, stop, compose(rows), info() }: nothing is read until start(); stop() ends every timer, stream listener and
 * read (the chat left). A server that does not offer the timeline (a 403/404, `enabled: false`, a backend with no
 * transcript) ends it for good for this page.
 */
export function observeActivity(name, opts) {
  const { fetcher = (u, o) => fetch(u, o), changed, streamOn, polling = false, wantThinking = () => true, setTimer = setInterval, clearTimer = clearInterval, shown = () => !globalThis.document?.hidden, now = Date.now } = opts;
  let s = memory.get(name);
  if (!s) memory.set(name, s = { steps: [], key: null, after: null, skip: false, before: null, ev: 0, complete: false, asked: null, info: { supported: null, thinking: false }, dead: false });
  let running = false, busy = false, again = false;
  const offs = [];
  const q = (params) => `/ui/steps?${new URLSearchParams({ instance: name, ...params })}`;
  const askThinking = () => (wantThinking() && thinkingOffered() ? "1" : "0");

  const take = (j, replace) => {
    if (!j || !j.enabled) { s.dead = true; return; }
    const was = s.info.thinking;
    s.info = { supported: j.supported !== false, reason: j.reason || null, thinking: j.thinking === true, cwd: j.cwd, home: j.home, backend: j.backend };
    if (was !== s.info.thinking) activityInfoStore.set((x) => ({ v: x.v + 1 }));
    if (j.key) s.key = j.key;
    if (j.after !== null && j.after !== undefined) { s.after = j.after; s.skip = !!j.skip; }
    if (replace) { s.before = j.before ?? null; s.complete = (j.before ?? null) === null; }
    if (typeof j.ev === "number") s.ev = Math.max(s.ev, j.ev);
    const merged = mergeSteps(replace ? [] : s.steps, j.steps || []);
    if (merged.length > STEPS_MAX) { s.steps = merged.slice(merged.length - STEPS_MAX); s.complete = false; }
    else s.steps = merged;
    if (j.supported === false) s.dead = true;
  };
  async function read(params, replace) {
    const r = await fetcher(q(params), { cache: "no-store", credentials: "same-origin" });
    if (!running) return null;
    if (r.status === 401 || r.status === 403 || r.status === 404) { s.dead = true; return null; }
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (!running) return null;
    take(j, replace);
    return j;
  }
  /** The newest window (and the watch): once per showing of the chat, and again when thinking is asked for anew. */
  async function open() {
    busy = true;
    try {
      const asked = askThinking();
      const j = await read({ watch: "1", thinking: asked }, true);
      if (j) { s.asked = asked; changed(); }
    } catch { /* the next tick or poll tries again */ }
    finally { busy = false; if (again && running) { again = false; void pull(); } }
  }
  /** What came after the cursor: one read at a time, and once more if asked meanwhile. */
  async function pull() {
    if (!running || s.dead) return;
    if (busy) { again = true; return; }
    if (s.after === null && s.key === null) return void open();
    if (s.asked !== askThinking()) return void open();       // thinking was switched: read the window again
    busy = true;
    try {
      const params = { watch: "1", thinking: s.asked, ev: String(s.ev) };
      if (s.after !== null) params.after = String(s.after);
      if (s.key) params.key = s.key;
      if (s.skip) params.skip = "1";
      const j = await read(params, false);
      if (j && j.reset) { take(j, true); }
      if (j) changed();
    } catch { /* the next tick or poll tries again */ }
    finally { busy = false; if (again && running && !s.dead) { again = false; void pull(); } }
  }
  function start() {
    if (running || s.dead) return;
    running = true;
    if (streamOn && !polling) offs.push(streamOn("steps_tick", (d) => { if (d && d.instance === name) void pull(); }));
    if (polling) { const h = setTimer(() => { if (shown()) void pull(); }, POLL_MS); offs.push(() => clearTimer(h)); }
    const r = setTimer(() => { if (shown()) void pull(); }, RENEW_MS); offs.push(() => clearTimer(r));
    const doc = globalThis.document;
    if (doc && doc.addEventListener) { const v = () => { if (shown()) void pull(); }; doc.addEventListener("visibilitychange", v); offs.push(() => doc.removeEventListener("visibilitychange", v)); }
    void (s.steps.length ? pull() : open());
  }
  function stop() { running = false; while (offs.length) offs.pop()(); }
  /** The thread's rows with each turn's group put in (the rows themselves untouched). */
  const compose = (rows) => composeActivity(name, rows, now());
  return { start, stop, compose, info: () => s.info, dead: () => s.dead };
}
