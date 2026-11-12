// AGEND-181 / AGEND-197: the chat's activity block — above each agent reply, what the agent did to produce it (thinking,
// intermediate text, tool calls); the turn in progress grows live at the end of the thread.
//
//   observeActivity(name, …)   reads the instance's steps (GET /ui/steps?chat=1, the Log's own read: masked and cut by the
//                              server to the agent's tool_progress, live by the stream's steps_tick — and by a poll when the
//                              page's stream has fallen back to polling) and composes the thread's rows with each group.
//   ActivityBlock              one group, drawn as #3648's mockups: a native <details> in a `.card`. Running: shut to ONE
//                              live line — the current step · N tools · elapsed — and, opened, the steps (the newest in bold).
//                              Finished: one line "Tool history · used N tools" with its duration, above the reply; opened,
//                              the steps. The rows are the Log's own (log-row.js, compact).
//   mountActivity(node, …)     a Preact island in a node of the chat's keyed DOM thread (chat-thread.js), updated in place
//                              — the same node for a live turn and for the reply it becomes (no remount, state kept).
//
// Nothing here runs unless this is an admin session on the local dashboard (<body data-chat-activity="1">; the server
// refuses anyone else), the agent's tool_progress is not off (the answer's `level`), and this browser has Show activity on
// (the ⋯ menu). The server decides what a step holds (tool_progress) and who gets thinking (an admin, switch on).
import { html, render, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { CAT_ICON, KIND_ICON, LogRow, collapse, mergeSteps, stepLine, tl } from "./log-row.js";
import { composeRows, groupSteps } from "./chat-activity-groups.js";

register("act", {
  en: {
    working: "Working…", history: "Tool history", activity: "Activity", usedTools: "used {0} tools", usedTool: "used 1 tool",
    tools: "{0} tools", tool: "1 tool", stepsN: "{0} steps", stepN: "1 step", noteInferred: "This group is placed by inference: {0}",
    lvl_text: "Matched by the reply's text", lvl_time: "Matched by time", lvl_turn: "Shown above the last reply of this turn", lvl_none: "Not tied to a reply",
    partial: "Earlier steps of this turn are not loaded.", earlier: "Show {0} earlier steps", calls: "{0} calls",
    menuActivity: "Show activity", menuThinking: "Show thinking",
  },
  "zh-TW": {
    working: "處理中…", history: "工具歷程", activity: "活動歷程", usedTools: "用了 {0} 個工具", usedTool: "用了 1 個工具",
    tools: "{0} 個工具", tool: "1 個工具", stepsN: "{0} 個步驟", stepN: "1 個步驟", noteInferred: "這一組是推論對應的：{0}",
    lvl_text: "依回覆的文字對應", lvl_time: "依時間對應", lvl_turn: "顯示在這一輪最後一則回覆上方", lvl_none: "沒有對應到回覆",
    partial: "這一輪較早的步驟尚未載入。", earlier: "顯示更早的 {0} 個步驟", calls: "{0} 次呼叫",
    menuActivity: "顯示活動", menuThinking: "顯示思考",
  },
});
const ta = (key, ...a) => t(`act.${key}`, ...a);

/** A group shows this many rows, the newest; "Show N earlier steps" adds EARLIER_STEP more each time. */
export const SHOWN_MAX = 30;
/** This many consecutive calls of one tool (Read, Grep…) are folded into one line that opens to them (Multica's rule: two are worth two lines, five are one act). */
export const GROUP_MIN = 3;
/** A call that is a step on its own: a command, a message, a sub-agent, a plan, and anything that went wrong or is still going. */
const foldable = (x) => x.kind === "tool" && !!x.tool && x.status === "done" && !(typeof x.exitCode === "number" && x.exitCode !== 0)
  && !["run", "message", "agent", "plan"].includes(x.cat || "other");
/** `items` with each run of GROUP_MIN+ foldable calls of one tool as { group, items }; `keep(item)` keeps a step out of a run (the newest of a live block). */
export function foldRuns(items, keep = () => false) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) out.push({ group: true, tool: run[0].tool, cat: run[0].cat || "other", items: run });
    else out.push(...run);
    run = [];
  };
  for (const x of items) {
    if (foldable(x) && !keep(x) && (!run.length || run[0].tool === x.tool)) { run.push(x); continue; }
    flush();
    if (foldable(x) && !keep(x)) run.push(x); else out.push(x);
  }
  flush();
  return out;
}

/** A folded run: one line "Read · 5 calls" that opens to its calls (each a line of its own). */
function StepGroup({ g, paths }) {
  const [open, setOpen] = useState(false);
  const n = countOf(g.items);
  return html`<li class="log-item k-group compact"><button type="button" class="log-head log-fold log-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>
    <span class="log-icon" aria-hidden="true"><${Icon} name=${CAT_ICON[g.cat] || CAT_ICON.other} size=${14} /></span>
    <span class="log-sum"><span class="log-subject">${tl(`cat_${g.cat}`)} · ${ta("calls", n)}</span></span><span class="grow"></span>
    <span class="log-cat">${g.tool}</span><span class="log-chev" aria-hidden="true"><${Icon} name="chevron" size=${12} /></span></button>
    ${open ? html`<ol class="log-list log-sub" role="list">${g.items.map((x) => html`<${LogRow} key=${`${x.kind}:${x.id}`} x=${x} paths=${paths} chat=${true} compact=${true} />`)}</ol>` : null}</li>`;
}
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
/**
 * The page may ask for the block when this is an admin session on the local dashboard (the server says so in the body, and
 * refuses everyone else); each agent's tool_progress then decides whether it has one (its answer's `level`). Thinking is
 * asked for only when `web.log_thinking` is on (the server still checks who asks).
 */
export const activityOffered = () => globalThis.document?.body?.dataset?.chatActivity === "1";
const thinkingOffered = () => globalThis.document?.body?.dataset?.logThinking === "1";

// ── the block ─────────────────────────────────────────────────────────────────────────────────────────────

function elapsed(ms) {
  if (!(ms >= 1000)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}
const countOf = (rows) => rows.reduce((n, x) => n + (x.repeat || 1), 0);
/** Tool calls in `rows` (a repeated call counts each time): thinking and "said" lines are steps, not tools. */
const toolsOf = (rows) => countOf(rows.filter((x) => x.kind === "tool"));

/** A once-a-second clock for a block that is running (its elapsed time moves; nothing else redraws). */
function useNow(live) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [live]);
  return now;
}

/**
 * One group, as #3648's mockups draw it. `ctx`: { paths: { cwd, home }, thinking: boolean }.
 * Running: shut by default, ONE line — spinner, the current step, "N tools · elapsed" — and opened, the steps, the newest
 * in bold. Finished: shut, "Tool history · used N tools" and its duration, above the reply; opened, the same steps.
 * What a step holds (its command, arguments, output) is what the server sent for the agent's tool_progress: the block has
 * nothing to hide at `standard` because `standard` never received it.
 */
export function ActivityBlock({ group, ctx, now: clock }) {
  const [user, setUser] = useState(null);          // the reader's own open/closed, once they chose
  const [more, setMore] = useState(0);             // extra rows shown above the newest SHOWN_MAX
  const hide = !ctx.thinking;
  const live = !group.ended;
  const tick = useNow(live);
  const now = clock ?? tick;
  // The reply's own steps, then what the agent said after sending it (the turn's close-out): one run, in order.
  const rows = collapse([...group.items, ...group.trailing].filter((s) => !(hide && s.kind === "thinking")));
  const open = user ?? false;
  const all = rows.length;
  const limit = SHOWN_MAX + more;
  const skipped = Math.max(0, all - limit);
  const shown = skipped ? rows.slice(skipped) : rows;
  const tools = toolsOf(rows);
  const last = rows[rows.length - 1];
  const start = group.from || (rows[0] && rows[0].ts) || 0;
  const end = group.to || (last && last.ts) || 0;
  const span = live ? (start ? now - start : 0) : (start && end ? end - start : 0);
  const dur = elapsed(span);
  const inferred = group.level !== "id" && group.level !== "live" ? ta(`lvl_${group.level}`) : "";
  const summary = live
    ? { icon: null, title: last ? stepLine(last, ctx.paths) : ta("working"), meta: [tools ? ta(tools === 1 ? "tool" : "tools", tools) : "", dur].filter(Boolean).join(" · ") }
    : { icon: "tasks", title: tools ? `${ta("history")} · ${tools === 1 ? ta("usedTool") : ta("usedTools", tools)}` : `${ta("activity")} · ${rows.length === 1 ? ta("stepN") : ta("stepsN", countOf(rows))}`, meta: dur };
  const list = (items) => {
    const newest = live ? rows[all - 1] : null;
    const folded = foldRuns(items, (x) => x === newest);
    return html`<ol class="log-list" role="list">${folded.map((x, i) => (x.group
      ? html`<${StepGroup} key=${`g:${x.items[0].id}`} g=${x} paths=${ctx.paths} />`
      : html`<${LogRow} key=${`${x.kind}:${x.id}`} x=${x} prev=${folded[i - 1]} paths=${ctx.paths} chat=${true} compact=${true} latest=${x === newest} />`))}</ol>`;
  };
  const icon = live && last ? (last.kind === "tool" ? CAT_ICON[last.cat || "other"] : KIND_ICON[last.kind]) : null;
  return html`<details class=${`card act-block${live ? " live" : " done"}`} open=${open}>
    <summary class="act-sum" onClick=${(e) => { e.preventDefault(); setUser(!open); }} aria-expanded=${open ? "true" : "false"}>
      <span class="act-chev" aria-hidden="true"><${Icon} name="chevron" size=${14} /></span>
      ${live ? html`<span class="spinner act-spin" aria-hidden="true"></span>` : html`<span class="act-ic" aria-hidden="true"><${Icon} name=${summary.icon} size=${14} /></span>`}
      ${live && icon ? html`<span class="act-ic" aria-hidden="true"><${Icon} name=${icon} size=${14} /></span>` : null}
      <span class=${`act-title${live ? " act-now" : ""}`}>${summary.title}</span>
      ${summary.meta ? html`<span class="act-meta">${summary.meta}</span>` : null}</summary>
    <div class="act-body">
      ${group.partial ? html`<p class="note act-partial">${ta("partial")}</p>` : null}
      ${inferred ? html`<p class="note act-lvl">${ta("noteInferred", inferred)}</p>` : null}
      ${skipped ? html`<button type="button" class="btn btn-sm act-earlier" onClick=${() => setMore(more + EARLIER_STEP)}>${ta("earlier", Math.min(skipped, EARLIER_STEP))}</button>` : null}
      ${shown.length ? list(shown) : null}
    </div></details>`;
}

/** Nothing worth a block: no row of the kinds shown once thinking is hidden (a turn with no step shows no block). */
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
/** What the last answer for `name` said (level, cwd, home, whether thinking is sent, backend), or null: none read yet. */
export const activityInfo = (name) => memory.get(name)?.info ?? null;
/**
 * The thread's rows with each turn's group put in, from what this page already knows of `name` — also for a chat shown
 * again from memory, before its feed reads anything. No steps (or a server that does not offer them): the rows as they are.
 */
export function composeActivity(name, rows, now = Date.now()) {
  const s = memory.get(name);
  if (!s || s.dead || s.info.level === "off" || !s.steps.length) return rows;
  return composeRows(rows, groupSteps(rows, s.steps, { now, complete: s.complete }));
}

/**
 * Read an instance's steps for its chat. `changed()` is called when the composed rows may differ. Returns
 * { start, stop, nudge, compose(rows), info() }: nothing is read until start(); stop() ends every timer, stream listener
 * and read (the chat left); nudge() reads what is new now (a message came or went). A server that does not offer the block
 * (a 403/404, `enabled: false`, a backend with no transcript) ends it for good for this page; an agent whose tool_progress
 * is off answers `level: "off"` and no steps — not for good: the setting may be turned on, and the next read sees it.
 *
 * Live: the stream's `steps_tick`; and a poll of POLL_MS while `polling()` — the public link's, AND a page whose stream has
 * fallen back to polling (SSE silent behind a relay or tunnel): the poll answers carry no `steps_tick`, so without this the
 * block only caught up on the renewal, after the reply.
 */
export function observeActivity(name, opts) {
  const { fetcher = (u, o) => fetch(u, o), changed, streamOn, polling: pollingOpt = false, wantThinking = () => true, setTimer = setInterval, clearTimer = clearInterval, shown = () => !globalThis.document?.hidden, now = Date.now } = opts;
  let s = memory.get(name);
  if (!s) memory.set(name, s = { steps: [], key: null, after: null, skip: false, before: null, ev: 0, complete: false, asked: null, info: { supported: null, thinking: false }, dead: false });
  let running = false, busy = false, again = false;
  const offs = [];
  const polling = () => (typeof pollingOpt === "function" ? !!pollingOpt() : !!pollingOpt);
  const q = (params) => `/ui/steps?${new URLSearchParams({ instance: name, chat: "1", ...params })}`;
  const askThinking = () => (wantThinking() && thinkingOffered() ? "1" : "0");

  const take = (j, replace) => {
    if (!j || !j.enabled) { s.dead = true; return; }
    const was = s.info.thinking;
    const wasLevel = s.info.level;
    s.info = { supported: j.supported !== false, reason: j.reason || null, level: j.level || "standard", thinking: j.thinking === true, cwd: j.cwd, home: j.home, backend: j.backend };
    if (was !== s.info.thinking || wasLevel !== s.info.level) activityInfoStore.set((x) => ({ v: x.v + 1 }));
    // tool_progress off: nothing to hold, no cursor (the next read opens again, and sees the setting turned on).
    if (s.info.level === "off") { s.steps = []; s.key = null; s.after = null; s.before = null; s.complete = false; return; }
    // The level moved between standard and verbose (AGEND-210): the steps held were cut for the old one — a verbose step
    // read at standard has no output, a standard one at verbose has none yet — and this answer only brings what is new.
    // Drop them and the cursor: the next read opens the window again at the new level (a `replace` answer already is one).
    if (!replace && wasLevel && wasLevel !== "off" && wasLevel !== s.info.level && s.steps.length) {
      s.steps = []; s.key = null; s.after = null; s.before = null; s.complete = false; s.skip = false; return;
    }
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
      if (j && s.after === null && s.key === null && s.info.level !== "off") again = true;     // dropped for a level change: read the window now
    } catch { /* the next tick or poll tries again */ }
    finally { busy = false; if (again && running && !s.dead) { again = false; void pull(); } }
  }
  function start() {
    if (running || s.dead) return;
    running = true;
    if (streamOn) offs.push(streamOn("steps_tick", (d) => { if (d && d.instance === name) void pull(); }));
    { const h = setTimer(() => { if (polling() && shown()) void pull(); }, POLL_MS); offs.push(() => clearTimer(h)); }
    const r = setTimer(() => { if (shown()) void pull(); }, RENEW_MS); offs.push(() => clearTimer(r));
    const doc = globalThis.document;
    if (doc && doc.addEventListener) { const v = () => { if (shown()) void pull(); }; doc.addEventListener("visibilitychange", v); offs.push(() => doc.removeEventListener("visibilitychange", v)); }
    void (s.steps.length ? pull() : open());
  }
  function stop() { running = false; while (offs.length) offs.pop()(); }
  /** The thread's rows with each turn's group put in (the rows themselves untouched). */
  const compose = (rows) => composeActivity(name, rows, now());
  /** Read what is new now (a message came or went): once, serialized with every other read. */
  const nudge = () => { if (running && !s.dead) void pull(); };
  return { start, stop, nudge, compose, info: () => s.info, dead: () => s.dead };
}
