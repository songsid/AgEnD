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
    expand: "Show details", collapse: "Hide details", command: "Command", removed: "Removed", added: "Added",
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
    expand: "顯示細節", collapse: "隱藏細節", command: "指令", removed: "移除", added: "新增",
  },
});
const tl = (key, ...a) => t(`log.${key}`, ...a);
export { tl };

/** A text longer than this many lines is folded until opened. */
const FOLD_LINES = 8;
/** A thinking row shows this much of its text until opened. */
export const THINK_PREVIEW = 150;

/**
 * AGEND-200 (the preview feedback, read against Multica's own transcript): what a step shows in the block is its one most
 * informative thing, once. Display only — the step still holds the full text, which the row's title and the Log tab show.
 */
/**
 * `<shell> [-flags] '<script>'` or `"<script>"`, then optionally plain word arguments (`bash -lc 'cmd' name arg` — $0, $1…).
 * The quoted script ends at ITS closing quote (not the last quote of the line: `bash -c 'a' && echo 'b'` is two commands, and is
 * not unwrapped). Anything but plain words after it (`&&`, `;`, a pipe, a redirect, `$x`) leaves the command as it was.
 */
const SHELL_WRAPPER = /^(?:\/[\w./-]*\/)?(?:zsh|bash|sh|fish)\s+(?:-[a-z]+\s+)*(?:'([^']*)'|"((?:[^"\\]|\\[\s\S])*)")((?:\s+[^\s;&|<>$`()'"\\]+)*)$/;
/** `bash -lc '<cmd>'` (what Codex runs every command through) is the command: the wrapper is noise in a one-line summary. */
export function stripShellWrapper(command) {
  const m = SHELL_WRAPPER.exec(String(command || "").trim());
  if (!m) return String(command || "");
  return m[1] !== undefined ? m[1] : m[2].replace(/\\(["\\$`])/g, "$1");
}
/**
 * A path with more than three parts as `.../parent/leaf`, so a row stays one line (a path inside the working directory is
 * already relative). A Windows path (`C:\Users\me\proj\src\a.ts`, or a mix of both slashes) is cut the same way, and
 * keeps its own separator.
 */
export function shortPath(p) {
  const text = String(p || "");
  if (/\s/.test(text) || text.includes(",")) return text;      // not one path (a Grep's "pattern  in  dir", several files)
  const parts = text.split(/[\\/]/);
  if (parts.length <= 3) return text;
  return `...${text.includes("/") ? "/" : "\\"}${parts.slice(-2).join(text.includes("/") ? "/" : "\\")}`;
}
const NAMED_BY_SUBJECT = new Set(["file_path", "path", "notebook_path", "pattern", "url", "query", "description", "command", "cmd", "offset", "limit",
  "timeout", "run_in_background", "replace_all", "output_mode", "glob", "type", "head_limit", "max_results", "subagent_type"]);
/**
 * What the arguments add to the row's title: a command (shown once, as code), an edit (old and new text), the rest as the
 * server sent it — and nothing when the title already says it all (only a path, a pattern, a limit…). A raw JSON block is
 * for a tool this does not recognise, or a text the server cut (which does not parse).
 */
export function inputView(x, cat) {
  const raw = x.input;
  if (!raw) return null;
  let o = null;
  try { const v = JSON.parse(raw); if (v && typeof v === "object" && !Array.isArray(v)) o = v; } catch { /* cut or not JSON */ }
  if (!o) return { raw };
  const str = (v) => (typeof v === "string" ? v : null);
  const cmd = cat === "run" ? str(o.command) ?? str(o.cmd) : null;
  if (cmd !== null) {
    const extra = Object.keys(o).filter((k) => !NAMED_BY_SUBJECT.has(k));
    return { code: stripShellWrapper(cmd), ...(extra.length ? { raw: JSON.stringify(Object.fromEntries(extra.map((k) => [k, o[k]])), null, 2) } : {}) };
  }
  if (str(o.old_string) !== null && str(o.new_string) !== null) return { diff: { old: o.old_string, next: o.new_string } };
  const extra = Object.keys(o).filter((k) => !NAMED_BY_SUBJECT.has(k));
  if (x.subject && !extra.length) return null;
  return { raw };
}

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
export const CAT_ICON = { read: "file", edit: "edit", search: "search", run: "code", web: "globe", mcp: "plug", agent: "team", plan: "tasks", message: "send", other: "sliders" };
export const KIND_ICON = { user: "user", assistant: "bot", thinking: "wand", error: "alert", turn_end: "stop", state: "info", event: "bell" };

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

/** The `turn` a merged step keeps: the one `first` names, else the one already known (`turn: ""` is "no evidence", not a turn). */
const kept = (first, known) => { const t = first || known; return t ? { turn: t } : {}; };

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
      // Prism #3709 R5: a read that saw only a call's result has no turn evidence (`turn: ""`) — it never erases the turn the
      // call already gave (a fresh parser per cursor range), so a poll-by-poll Log groups exactly as a cold read does.
      if (!older) next[i] = s.kind === "tool" && !s.tool && next[i].tool
        ? { ...next[i], ...s, tool: next[i].tool, cat: next[i].cat, ts: next[i].ts, ...kept(s.turn, next[i].turn) }
        : { ...next[i], ...s, ...kept(s.turn, next[i].turn) };
      else if (next[i].kind === "tool" && !next[i].tool && s.tool) {
        const { tool, cat, subject, input, ts } = s;
        next[i] = { ...next[i], tool, cat, ...(subject !== undefined ? { subject } : {}), ...(input !== undefined ? { input } : {}), ...(ts ? { ts } : {}), ...kept(next[i].turn, s.turn) };
      }
    } else if (fresh.has(s.id)) {
      // The same step twice in one answer (never from the server's parser, whose ids are unique): the later one wins.
      added[fresh.get(s.id)] = { ...added[fresh.get(s.id)], ...s, ...kept(s.turn, added[fresh.get(s.id)].turn) };
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

/** A step with an output to read (its text, or a result too large to keep). */
const hasOutput = (x) => !!(x.body || x.bodyBytes);
/**
 * Consecutive identical finished tool steps (same tool, subject and status) as one row with a count: a loop shows. Only
 * steps with nothing more to see are merged (AGEND-210): at `verbose` each run has its own output and arguments, and
 * folding the later ones into the first would hide them — those stay one row each. At `standard` a step holds no output
 * or arguments, so a loop still reads as one row.
 */
export function collapse(items) {
  const out = [];
  for (const x of items) {
    const prev = out[out.length - 1];
    if (prev && x.kind === "tool" && prev.kind === "tool" && x.status !== "running" && prev.status === x.status
      && prev.tool === x.tool && (prev.subject || "") === (x.subject || "") && prev.turn === x.turn
      && !hasOutput(x) && !hasOutput(prev) && (prev.input || "") === (x.input || "")) {
      prev.repeat = (prev.repeat || 1) + 1;
      continue;
    }
    out.push({ ...x });
  }
  return out;
}


/** The one-line words of a step — its kind or category and what it acts on — for a header that names the current step. */
export function stepLine(x, paths) {
  const short = (v) => shortenPaths(v, paths);
  if (x.kind === "thinking") return tl("thinking");
  if (x.kind === "assistant") return `${tl("said")}: ${short(String(x.body || "").replace(/\s+/g, " ").trim()).slice(0, 80)}`;
  if (x.kind === "error") return x.note ? tl("errorCode", x.note) : tl("error");
  const cat = x.cat || "other";
  const subject = cat === "plan" && x.subject ? tl("plan_items", x.subject) : short(x.subject || x.tool || "");
  return subject ? `${tl(`cat_${cat}`)} ${subject}` : tl(`cat_${cat}`);
}

/**
 * One line of the Log. `chat`: in the chat's activity block (an assistant line is "Said"). `compact` (the block's rows,
 * AGEND-197): no time column and no "done" word — a step line is its icon, its words, and only what is unusual about it
 * (running, failed, interrupted, a non-zero exit); `latest` marks the newest step of a block still running.
 */
export function LogRow({ x, prev, paths, chat, compact, latest }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const short = (v) => shortenPaths(v, paths);
  const time = x.ts ? chatTime(x.ts, { yesterday: (hm) => t("chat.yesterdayAt", hm) }) : "";
  const title = x.ts ? chatTimeFull(x.ts) : "";
  const newTurn = x.kind === "user" && prev && prev.turn !== x.turn;
  const head = (icon, label, extra) => html`<div class="log-head"><span class="log-icon" aria-hidden="true"><${Icon} name=${icon} size=${14} /></span>
    <span class="log-label">${label}</span>${extra || null}<span class="grow"></span>${compact ? null : html`<span class="log-time" title=${title}>${time}</span>`}</div>`;
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
  // The chat's block (AGEND-200): a step is ONE line — icon on the timeline, what it did, its kind in a quiet word, its status,
  // and a chevron when there is more; the whole line opens it (the same place for every step). Thinking and what the agent
  // said show two lines of their text until opened. Nothing in here scrolls: a long output is cut per step ("Show all").
  const chev = html`<span class="log-chev" aria-hidden="true"><${Icon} name="chevron" size=${12} /></span>`;
  const line = (icon, label, tail, can, cls) => {
    const inner = html`<span class="log-icon" aria-hidden="true"><${Icon} name=${icon} size=${14} /></span>${label}<span class="grow"></span>${tail || null}${can ? chev : html`<span class="log-chev none" aria-hidden="true"></span>`}`;
    return can
      ? html`<button type="button" class=${`log-head log-fold log-toggle${cls ? ` ${cls}` : ""}`} aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${inner}</button>`
      : html`<div class="log-head">${inner}</div>`;
  };
  const note = (cut, bytes) => html`${cut ? html`<p class="note">${tl("cut", cut.toLocaleString())}</p>` : null}${bytes ? html`<p class="note">${tl("tooLarge", size(bytes))}</p>` : null}`;
  let row;
  if (compact && (x.kind === "thinking" || (x.kind === "assistant" && chat))) {
    const think = x.kind === "thinking";
    const body = think ? x.body || "" : short(x.body || "");
    const more = body.length > 100 || body.includes("\n");
    const shown = think && !open && more ? `${body.split("\n")[0].slice(0, THINK_PREVIEW)}…` : body;
    row = html`${line(KIND_ICON[x.kind], html`<span class=${`log-sum ${think ? "log-think" : "log-said"}${open ? " open" : ""}`}>${shown}</span>`,
      html`<span class="log-cat">${tl(think ? "thinking" : "said")}</span>`, more, "log-more")}
      ${open && x.bodyCut ? html`<p class="note">${tl("cut", x.bodyCut.toLocaleString())}</p>` : null}`;
  } else if (compact && x.kind === "tool") {
    const cat = x.cat || "other";
    const raw = x.subject || "";
    const subject = cat === "plan" && raw ? tl("plan_items", raw) : cat === "run" ? stripShellWrapper(short(raw)) : cat === "read" || cat === "edit" ? shortPath(short(raw)) : short(raw);
    const failed = x.status === "failed" || x.status === "interrupted" || (typeof x.exitCode === "number" && x.exitCode !== 0);
    const running = x.status === "running";
    const mark = running ? html`<span class="log-status running"><span class="spinner" aria-hidden="true"></span>${tl("running")}</span>`
      : failed ? html`<span class=${`log-status ${x.status === "interrupted" ? "interrupted" : "failed"}`}>${tl(x.status === "interrupted" ? "interrupted" : "failed")}${typeof x.exitCode === "number" && x.exitCode !== 0 ? ` · ${tl("exit", x.exitCode)}` : ""}${x.durationMs ? ` · ${duration(x.durationMs)}` : ""}</span>` : null;
    const view = inputView(x, cat);
    const has = !!(x.body || x.bodyBytes || (view && (view.code || view.diff || view.raw)));
    const middle = subject || x.tool || tl(`cat_${cat}`);
    const kind = cat === "other" && x.tool ? (subject ? x.tool : "") : tl(`cat_${cat}`);
    const label = html`<span class="log-sum"><span class="log-subject mono" title=${raw && subject !== raw ? raw : null}>${middle}</span>${x.repeat ? html` <span class="log-repeat">${tl("times", x.repeat)}</span>` : null}</span>`;
    const tail = html`${kind ? html`<span class="log-cat">${kind}</span>` : null}${mark}`;
    row = html`${line(CAT_ICON[cat] || CAT_ICON.other, label, tail, has)}
      ${has && open ? html`<div class="log-detail">
        ${view && view.code ? html`<pre class="log-code"><span class="log-prompt" aria-hidden="true">$ </span>${short(view.code)}</pre>${x.inputCut ? note(x.inputCut) : null}` : null}
        ${view && view.diff ? html`<div class="log-diff">${view.diff.old ? html`<pre class="log-code rm" aria-label=${tl("removed")}>${short(view.diff.old)}</pre>` : null}${view.diff.next ? html`<pre class="log-code add" aria-label=${tl("added")}>${short(view.diff.next)}</pre>` : null}</div>` : null}
        ${view && view.raw ? html`<div class="log-sec"><span class="log-sec-h">${tl("args")}</span><div class="log-text mono">${short(view.raw)}</div>${x.inputCut ? note(x.inputCut) : null}</div>` : null}
        ${x.body || x.bodyBytes ? html`<div class="log-sec"><span class="log-sec-h">${tl("output")}</span>${text(x.body, x.bodyCut, x.bodyBytes)}</div>` : null}</div>` : null}`;
  } else if (compact && x.kind === "error") {
    row = html`${line(KIND_ICON.error, html`<span class="log-sum">${x.note ? tl("errorCode", x.note) : tl("error")}</span>`, null, false)}${text(x.body, x.bodyCut)}`;
  } else if (x.kind === "event") {
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
    const quiet = compact && (x.status || "done") === "done" && !(typeof x.exitCode === "number" && x.exitCode !== 0);
    const status = quiet ? null : html`<span class=${`log-status ${x.status || "done"}`}>${x.status === "running" ? html`<span class="spinner" aria-hidden="true"></span>` : null}${tl(x.status || "done")}${typeof x.exitCode === "number" && x.exitCode !== 0 ? ` · ${tl("exit", x.exitCode)}` : ""}${x.durationMs ? ` · ${duration(x.durationMs)}` : ""}</span>`;
    const label = html`<span class="log-cat">${tl(`cat_${cat}`)}</span>${subject ? html` <span class="log-subject mono" title=${x.subject && subject !== x.subject ? x.subject : null}>${subject}</span>` : null}${x.tool && !subject ? html` <span class="log-tool mono muted">${x.tool}</span>` : null}`;
    const has = !!(x.body || x.input || x.bodyBytes);
    row = html`${head(CAT_ICON[cat] || CAT_ICON.other, label, html`${x.repeat ? html`<span class="log-repeat">${tl("times", x.repeat)}</span>` : null}${status}`)}
      ${has ? html`<button type="button" class="link-btn log-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? tl("hideOutput") : tl("showOutput")}</button>` : null}
      ${open ? html`<div class="log-detail">
        ${x.input ? html`<div class="log-sec"><span class="log-sec-h">${tl("args")}</span><div class="log-text mono">${short(x.input)}</div>${x.inputCut ? html`<p class="note">${tl("cut", x.inputCut.toLocaleString())}</p>` : null}</div>` : null}
        <div class="log-sec"><span class="log-sec-h">${tl("output")}</span>${x.body ? text(x.body, x.bodyCut, x.bodyBytes) : html`<p class="note">${tl("noOutput")}</p>`}</div></div>` : null}`;
  }
  return html`<li class=${`log-item k-${x.kind}${x.status ? ` s-${x.status}` : ""}${newTurn ? " turn-start" : ""}${compact ? " compact" : ""}${latest ? " latest" : ""}`}>${row}</li>`;
}
