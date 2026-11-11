// AGEND-181: one step of an instance's work as a row — shared by the Log tab (panel-log.js) and the chat's activity
// timeline (chat-activity.js), so a step looks and behaves the same in both: its icon, words, status, and its arguments
// and output on demand. Masking and cutting are the server's (log-steps.ts); this only shows what it is given.
import { html, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import "/assets/chat-strings.js";
import { chatTime, chatTimeFull } from "/assets/chat-time.js";

register("log", {
  en: {
    user: "Asked", assistant: "Replied", error: "Error", errorCode: "Error {0}", turnEnd: "Turn ended", turnEndIn: "Turn ended · {0}",
    compacted: "Conversation compacted", turn: "Turn",
    running: "running", done: "done", failed: "failed", interrupted: "interrupted", exit: "exit {0}",
    showScreen: "Show what was on screen", hideScreen: "Hide what was on screen",
    showOutput: "Show output", hideOutput: "Hide output", args: "Arguments", output: "Output", noOutput: "No output.",
    showAll: "Show all", showLess: "Show less", cut: "… {0} more characters not shown.", tooLarge: "Output of {0}: only its start is shown.",
    times: "×{0}", newer: "{0} new",
    cat_read: "Read", cat_edit: "Edit", cat_search: "Search", cat_run: "Run", cat_web: "Web", cat_mcp: "MCP", cat_agent: "Sub-agent",
    cat_plan: "Plan", cat_message: "Message", cat_other: "Tool", plan_items: "{0} items",
    said: "Said", thinking: "Thinking", thinkingMore: "Show all thinking", thinkingLess: "Show less",
  },
  "zh-TW": {
    user: "收到要求", assistant: "回覆", error: "錯誤", errorCode: "錯誤 {0}", turnEnd: "回合結束", turnEndIn: "回合結束 · {0}",
    compacted: "對話已壓縮", turn: "回合",
    running: "執行中", done: "完成", failed: "失敗", interrupted: "中斷", exit: "結束碼 {0}",
    showScreen: "顯示當時的畫面", hideScreen: "隱藏當時的畫面",
    showOutput: "顯示輸出", hideOutput: "隱藏輸出", args: "參數", output: "輸出", noOutput: "沒有輸出。",
    showAll: "顯示全部", showLess: "收合", cut: "… 還有 {0} 個字元沒有顯示。", tooLarge: "輸出共 {0}，只顯示開頭。",
    times: "×{0}", newer: "{0} 則新的",
    cat_read: "讀取", cat_edit: "編輯", cat_search: "搜尋", cat_run: "執行", cat_web: "網頁", cat_mcp: "MCP", cat_agent: "子 agent",
    cat_plan: "計畫", cat_message: "訊息", cat_other: "工具", plan_items: "{0} 項",
    said: "說了", thinking: "思考", thinkingMore: "顯示完整思考", thinkingLess: "收合",
  },
});
const tl = (key, ...a) => t(`log.${key}`, ...a);
export { tl };

/** A text longer than this many lines is folded until opened. */
const FOLD_LINES = 8;
/** A thinking row shows this much of its text until opened. */
export const THINK_PREVIEW = 150;

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * AGEND-181: a path under the instance's working directory shown relative, the home directory as `~` — display only
 * (the step still holds the full text, which the row's title and the Log tab show). `paths`: { cwd?, home? }. A path
 * that merely starts with the same letters (`/work/project-2` against `/work/project`) is left alone.
 */
export function shortenPaths(text, paths) {
  if (!text || !paths || (!paths.cwd && !paths.home)) return text;
  let out = String(text);
  for (const [base, bare, sub] of [[paths.cwd, ".", ""], [paths.home, "~", "~/"]]) {
    if (!base || base.length < 2) continue;
    const dir = base.replace(/[\\/]+$/, "");
    if (!dir) continue;
    // `<dir>/rest` → `rest` (or `~/rest`); `<dir>` alone → `.` (or `~`); never inside a longer name.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_.~-])${escRe(dir)}(?:[\\\\/]+|(?![A-Za-z0-9_.-]))`, "g"), (m, pre) => `${pre}${/[\\/]$/.test(m) ? sub : bare}`);
  }
  return out;
}

// The app's own SVG icons (never emoji: a device without an emoji font shows boxes).
const CAT_ICON = { read: "file", edit: "edit", search: "search", run: "code", web: "globe", mcp: "plug", agent: "team", plan: "tasks", message: "send", other: "sliders" };
const KIND_ICON = { user: "user", assistant: "bot", thinking: "wand", error: "alert", turn_end: "stop", state: "info", event: "bell" };

function size(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function duration(ms) {
  if (!(ms >= 0)) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${Math.round(s - m * 60)} s`;
}
const eventLabel = (type) => { const k = `log.ev_${type}`; const v = t(k); return v === k ? String(type).replace(/_/g, " ") : v; };

/**
 * Merge `incoming` steps into `list` (array, in order): one with an id already there replaces it in place (a result
 * completing its call); a new one is added — at the end, or before everything when `older`. Returns a new array.
 */
export function mergeSteps(list, incoming, older = false) {
  const at = new Map(list.map((s, i) => [s.id, i]));
  const fresh = new Map();
  const next = list.slice();
  const added = [];
  for (const s of incoming) {
    const i = at.get(s.id);
    if (i !== undefined) {
      // An older page never overwrites what a newer read already said about the same step — except to name a call the
      // newer page knew only by its result (the call's record was older than that page): its tool, subject and input.
      // A newer read that saw only a call's result (the call was before where it read) never unnames the call: its tool,
      // category and start time stay; the outcome is the newer read's.
      if (!older) next[i] = s.kind === "tool" && !s.tool && next[i].tool
        ? { ...next[i], ...s, tool: next[i].tool, cat: next[i].cat, ts: next[i].ts }
        : { ...next[i], ...s };
      else if (next[i].kind === "tool" && !next[i].tool && s.tool) {
        const { tool, cat, subject, input, ts } = s;
        next[i] = { ...next[i], tool, cat, ...(subject !== undefined ? { subject } : {}), ...(input !== undefined ? { input } : {}), ...(ts ? { ts } : {}) };
      }
    } else if (fresh.has(s.id)) {
      // The same step twice in one answer (never from the server's parser, whose ids are unique): the later one wins.
      added[fresh.get(s.id)] = { ...added[fresh.get(s.id)], ...s };
    } else { fresh.set(s.id, added.length); added.push(s); }
  }
  return older ? [...added, ...next] : [...next, ...added];
}

/** Steps and fleet events in one timeline: events placed by time among the steps (steps keep their file order). */
export function timeline(steps, events) {
  const evs = events.slice().sort((a, b) => a.ts - b.ts || a.id - b.id);
  const out = [];
  let e = 0;
  for (const s of steps) {
    while (e < evs.length && s.ts > 0 && evs[e].ts <= s.ts) out.push({ kind: "event", ...evs[e++] });
    out.push(s);
  }
  while (e < evs.length) out.push({ kind: "event", ...evs[e++] });
  return out;
}

/** Consecutive identical finished tool steps (same tool, subject and status) as one row with a count: a loop shows. */
export function collapse(items) {
  const out = [];
  for (const x of items) {
    const prev = out[out.length - 1];
    if (prev && x.kind === "tool" && prev.kind === "tool" && x.status !== "running" && prev.status === x.status
      && prev.tool === x.tool && (prev.subject || "") === (x.subject || "") && prev.turn === x.turn) {
      prev.repeat = (prev.repeat || 1) + 1;
      continue;
    }
    out.push({ ...x });
  }
  return out;
}


/** One line of the Log. */
export function LogRow({ x, prev, paths, chat }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const short = (v) => shortenPaths(v, paths);
  const time = x.ts ? chatTime(x.ts, { yesterday: (hm) => t("chat.yesterdayAt", hm) }) : "";
  const title = x.ts ? chatTimeFull(x.ts) : "";
  const newTurn = x.kind === "user" && prev && prev.turn !== x.turn;
  const head = (icon, label, extra) => html`<div class="log-head"><span class="log-icon" aria-hidden="true"><${Icon} name=${icon} size=${14} /></span>
    <span class="log-label">${label}</span>${extra || null}<span class="grow"></span><span class="log-time" title=${title}>${time}</span></div>`;
  const text = (raw, cut, bytes) => {
    if (!raw) return null;
    const body = short(raw);
    const lines = body.split("\n").length;
    const folded = !full && lines > FOLD_LINES;
    return html`<div class=${`log-text${folded ? " folded" : ""}`}>${body}</div>
      ${lines > FOLD_LINES ? html`<button type="button" class="link-btn log-more" onClick=${() => setFull(!full)}>${full ? tl("showLess") : tl("showAll")}</button>` : null}
      ${cut ? html`<p class="note">${tl("cut", cut.toLocaleString())}</p>` : null}
      ${bytes ? html`<p class="note">${tl("tooLarge", size(bytes))}</p>` : null}`;
  };
  let row;
  if (x.kind === "event") {
    // M-2269: a dialog or prompt AgEnD saw (the CLI never writes it to its transcript): its text as it was on screen,
    // folded until asked for. Text only (a text node), masked by the server.
    row = html`${head(KIND_ICON.event, eventLabel(x.type))}${x.detail ? html`<div class="log-text muted">${x.detail}</div>` : null}
      ${x.screen ? html`<button type="button" class="link-btn log-toggle log-screen-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? tl("hideScreen") : tl("showScreen")}</button>` : null}
      ${x.screen && open ? html`<div class="log-detail"><div class="log-text mono log-screen">${x.screen}</div></div>` : null}`;
  } else if (x.kind === "user" || x.kind === "assistant") {
    // In the chat's timeline an assistant line is what the agent said on the way (its replies are the bubbles): "Said".
    row = html`${head(KIND_ICON[x.kind], x.kind === "assistant" && chat ? tl("said") : tl(x.kind))}${text(x.body, x.bodyCut)}`;
  } else if (x.kind === "thinking") {
    // AGEND-181: the model's thinking (admin only; the server sends it only then): folded to its start, opened on demand.
    const body = x.body || "";
    const more = body.length > THINK_PREVIEW || body.includes("\n");
    row = html`${head(KIND_ICON.thinking, tl("thinking"))}
      <div class=${`log-text log-think${open ? " open" : ""}`}>${open || !more ? body : `${body.split("\n")[0].slice(0, THINK_PREVIEW)}…`}</div>
      ${more ? html`<button type="button" class="link-btn log-more" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? tl("thinkingLess") : tl("thinkingMore")}</button>` : null}
      ${open && x.bodyCut ? html`<p class="note">${tl("cut", x.bodyCut.toLocaleString())}</p>` : null}`;
  } else if (x.kind === "error") {
    row = html`${head(KIND_ICON.error, x.note ? tl("errorCode", x.note) : tl("error"))}${text(x.body, x.bodyCut)}`;
  } else if (x.kind === "turn_end") {
    row = head(KIND_ICON.turn_end, x.durationMs ? tl("turnEndIn", duration(x.durationMs)) : tl("turnEnd"),
      x.status && x.status !== "done" ? html`<span class=${`log-status ${x.status}`}>${tl(x.status)}</span>` : null);
  } else if (x.kind === "state") {
    row = head(KIND_ICON.state, x.note === "compacted" ? tl("compacted") : x.note || "");
  } else {
    const cat = x.cat || "other";
    const subject = cat === "plan" && x.subject ? tl("plan_items", x.subject) : short(x.subject || "");
    const status = html`<span class=${`log-status ${x.status || "done"}`}>${x.status === "running" ? html`<span class="spinner" aria-hidden="true"></span>` : null}${tl(x.status || "done")}${typeof x.exitCode === "number" && x.exitCode !== 0 ? ` · ${tl("exit", x.exitCode)}` : ""}${x.durationMs ? ` · ${duration(x.durationMs)}` : ""}</span>`;
    const label = html`<span class="log-cat">${tl(`cat_${cat}`)}</span>${subject ? html` <span class="log-subject mono" title=${x.subject && subject !== x.subject ? x.subject : null}>${subject}</span>` : null}${x.tool && !subject ? html` <span class="log-tool mono muted">${x.tool}</span>` : null}`;
    const has = !!(x.body || x.input || x.bodyBytes);
    row = html`${head(CAT_ICON[cat] || CAT_ICON.other, label, html`${x.repeat ? html`<span class="log-repeat">${tl("times", x.repeat)}</span>` : null}${status}`)}
      ${has ? html`<button type="button" class="link-btn log-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? tl("hideOutput") : tl("showOutput")}</button>` : null}
      ${open ? html`<div class="log-detail">
        ${x.input ? html`<div class="log-sec"><span class="log-sec-h">${tl("args")}</span><div class="log-text mono">${short(x.input)}</div>${x.inputCut ? html`<p class="note">${tl("cut", x.inputCut.toLocaleString())}</p>` : null}</div>` : null}
        <div class="log-sec"><span class="log-sec-h">${tl("output")}</span>${x.body ? text(x.body, x.bodyCut, x.bodyBytes) : html`<p class="note">${tl("noOutput")}</p>`}</div></div>` : null}`;
  }
  return html`<li class=${`log-item k-${x.kind}${x.status ? ` s-${x.status}` : ""}${newTurn ? " turn-start" : ""}`}>${row}</li>`;
}
