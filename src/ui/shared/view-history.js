// Claude history in the View (the user, hmsg-a8947a2c / hmsg-b4c7ccdf; leader cid-claude-history-build). Claude Code
// draws on the alternate screen, so tmux keeps nothing above it: scrolling up in its View shows the conversation's
// earlier part from its transcript (GET /api/pane/<name>?transcript=1, view-history.ts), drawn like Claude's own
// Ctrl+O view — "❯" prompts on their band, "●" replies and tool calls, "⎿" results, diffs, long output folded — directly
// above the live screen, under a faint divider.
//
// The look is sampled from the live screen the View already shows (samplePalette): the prompt band, the bullet and
// result glyphs, the tool and diff colours, as this Claude version draws them; Claude 2.1.318's own values when the
// screen has none of them. A glyph the page's fonts lack falls back (⏺ → ●, ⎿ → └, ❯ → >).
//
// Loaded on first use by panel-view.js (a lazy module of its own). A tab opened before an upgrade runs it with the old
// shell, so it imports nothing but app-i18n.js's register/t (in every shell since #1408), registers its own words and
// links its own stylesheet (/assets/view-history.css): nothing it needs lives in a long-lived module. A server without
// the history (an older one answers the pane's text) makes `first()` say `unsupported`: the View stays as it was.
import { register, t } from "./app-i18n.js";

register("viewHistory", {
  en: {
    divider: "History above",
    more: "… +{0} lines (click to expand)",
    moreFailed: "Could not load the full text.",
    cut: "… {0} more characters not shown",
    capped: "Only the latest {0} steps are shown here.",
  },
  "zh-TW": {
    divider: "以上是對話紀錄",
    more: "… 還有 {0} 行（點一下展開）",
    moreFailed: "無法載入完整內容。",
    cut: "… 還有 {0} 個字元未顯示",
    capped: "這裡只顯示最近 {0} 則紀錄。",
  },
});
const w = (key, ...values) => t(`viewHistory.${key}`, ...values);

/** About this many steps are kept on the page; older pages are not read past it. */
export const HISTORY_STEP_CAP = 1000;

// ── The palette, sampled from the live screen ──
const BASE = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function xterm256(n) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) { n -= 16; const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6; const v = (x) => (x ? x * 40 + 55 : 0); return `rgb(${v(r)},${v(g)},${v(b)})`; }
  const l = (n - 232) * 10 + 8; return `rgb(${l},${l},${l})`;
}
/** Claude Code 2.1.318's own look (captured from a real pane, dark theme): what is used when the screen shows none. */
export const DEFAULT_PALETTE = Object.freeze({
  promptGlyph: "❯", promptBand: xterm256(237), promptFg: xterm256(246), promptText: xterm256(231),
  bullet: "●", replyFg: xterm256(231), toolFg: xterm256(114), failedFg: xterm256(203), runningFg: xterm256(246),
  resultGlyph: "⎿", resultFg: xterm256(246),
  delFg: xterm256(167), delBg: xterm256(52), addFg: xterm256(77), addBg: xterm256(22), errorFg: xterm256(203),
});

/** The screen's text as lines of runs: { text, fg, bg, bold } (colours as CSS, null when unset). */
export function ansiRuns(text) {
  const lines = [[]];
  let fg = null, bg = null, bold = false, reverse = false;
  const push = (chunk) => {
    const parts = chunk.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      let f = typeof fg === "number" ? (bold && fg < 8 ? BRIGHT[fg] : BASE[fg]) : fg;
      let b = typeof bg === "number" ? BASE[bg] : bg;
      if (reverse) [f, b] = [b, f];
      lines[lines.length - 1].push({ text: part, fg: f, bg: b, bold });
    });
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1].split(";").filter((x) => x !== "").map(Number);
    if (codes.length === 0) codes.push(0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = null; bold = reverse = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 7) reverse = true;
      else if (c === 27) reverse = false;
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (c >= 30 && c <= 37) fg = c - 30;
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) bg = c - 40;
      else if (c >= 100 && c <= 107) bg = BRIGHT[c - 100];
      else if (c === 38 || c === 48) {
        let col = null;
        if (codes[i + 1] === 5) { col = xterm256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) { col = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; }
        if (c === 38) fg = col; else bg = col;
      }
    }
  }
  push(text.slice(last));
  return lines;
}

const PROMPT_GLYPHS = "❯>›";
const BULLETS = "●⏺";
const RESULT_GLYPHS = "⎿└";
/**
 * How this Claude draws its conversation, read off the live screen (ANSI, as the View fetched it): each value found
 * replaces the default; the most frequent wins where a screen shows several (a failed tool's red bullet among green).
 */
export function samplePalette(screen) { return sampleScreen(screen).palette; }
/** samplePalette, and which of its values the screen gave (the rest are the defaults) — for the version audit. */
export function sampleScreen(screen) {
  const p = { ...DEFAULT_PALETTE };
  const found = new Set();
  const set = (k, v) => { if (v) { p[k] = v; found.add(k); } };
  if (typeof screen !== "string" || !screen) return { palette: p, found: [] };
  const tally = { toolFg: new Map(), replyFg: new Map() };
  const count = (map, v) => { if (v) map.set(v, (map.get(v) || 0) + 1); };
  let banded = false, glyphSeen = false;
  for (const runs of ansiRuns(screen)) {
    const textOf = runs.map((r) => r.text).join("");
    const lead = textOf.length - textOf.trimStart().length;
    // Find the run holding column `col` (and the offset in it).
    const at = (col) => { let n = 0; for (const r of runs) { if (col < n + r.text.length) return r; n += r.text.length; } return null; };
    const first = textOf.charAt(lead);
    // A prompt: its glyph then a space, on a band (a past prompt) — or bare (the composer: the glyph only).
    if (PROMPT_GLYPHS.includes(first) && textOf.charAt(lead + 1) === " " && !banded) {
      const g = at(lead);
      if (g && g.bg) {
        banded = true; glyphSeen = true;
        set("promptGlyph", first); set("promptBand", g.bg); set("promptFg", g.fg);
        const rest = runs.slice(runs.indexOf(g) + 1).find((r) => r.text.trim());
        if (rest) set("promptText", rest.fg);
      } else if (!glyphSeen) { glyphSeen = true; set("promptGlyph", first); }
      continue;
    }
    // A bullet at the line's start: a tool call ("● Name(" with the name bold) or a reply.
    if (lead === 0 && BULLETS.includes(first) && textOf.charAt(1) === " ") {
      set("bullet", first);
      const g = at(0), next = at(2);
      const tool = !!(next && next.bold) && /^. [^(]+\(/.test(textOf);
      count(tool ? tally.toolFg : tally.replyFg, g && g.fg);
      continue;
    }
    // A result: two spaces, its glyph.
    if (lead === 2 && RESULT_GLYPHS.includes(first)) {
      set("resultGlyph", first);
      const g = at(2); if (g) set("resultFg", g.fg);
      continue;
    }
    // A diff row: a line number then - or +, on a coloured background.
    const row = /^\s+\d+\s?([-+])/.exec(textOf);
    if (row) {
      const g = at(textOf.indexOf(row[1], lead));
      if (g && g.bg) { if (row[1] === "-") { set("delBg", g.bg); set("delFg", g.fg); } else { set("addBg", g.bg); set("addFg", g.fg); } }
    }
  }
  const top = (map) => { let best = null, n = 0; for (const [k, v] of map) if (v > n) { best = k; n = v; } return best; };
  set("toolFg", top(tally.toolFg));
  set("replyFg", top(tally.replyFg));
  return { palette: p, found: [...found] };
}

// ── Glyphs the page's fonts lack ──
const FALLBACK = { "⏺": "●", "●": "*", "⎿": "└", "└": "|", "❯": ">", "›": ">" };
const glyphCache = new Map();
/**
 * Whether `ch` draws as itself in `font` (a CSS font-family list): drawn next to a code point no font has, the two must
 * differ. No canvas (a test page): assumed drawn.
 */
export function hasGlyph(ch, font, doc = typeof document !== "undefined" ? document : null) {
  const key = `${ch}\u0000${font}`;
  if (glyphCache.has(key)) return glyphCache.get(key);
  let ok = true;
  try {
    const canvas = doc && doc.createElement ? doc.createElement("canvas") : null;
    const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (ctx && typeof ctx.getImageData === "function") {
      canvas.width = 40; canvas.height = 40;
      const draw = (c) => { ctx.clearRect(0, 0, 40, 40); ctx.font = `32px ${font}`; ctx.fillStyle = "#000"; ctx.textBaseline = "top"; ctx.fillText(c, 2, 2); return ctx.getImageData(0, 0, 40, 40).data; };
      const a = draw(ch), none = draw("\u{10FFFD}");
      ok = false;
      for (let i = 3; i < a.length; i += 4) if (a[i] !== none[i]) { ok = true; break; }
    }
  } catch { ok = true; }
  glyphCache.set(key, ok);
  return ok;
}
/** The glyph as drawn on this page: itself, or its fallback when the fonts lack it. */
export function drawable(ch, font, doc) {
  let g = ch;
  for (let i = 0; i < 3 && g && !hasGlyph(g, font, doc); i++) g = FALLBACK[g] || g;
  return g;
}

// ── Which steps the live screen already shows ──
// Text a needle is compared by: no whitespace (a wrap moves it) and no markdown marks (Claude draws them away).
const squash = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").replace(/[\s*_`#>│]/g, "");
/** The part of a prompt or a reply looked for on the screen (none for a tool: Claude may draw it summarised). */
function needle(step) {
  if (step.kind !== "user" && step.kind !== "assistant") return null;
  const s = squash(step.body || "").slice(0, 24);
  return s.length >= 4 ? s : null;
}
/**
 * The steps before the live screen: walking back from the newest, every prompt and reply found on the screen is on it;
 * the first one not found, and everything older, is history. Tool calls go with their neighbours (a step the screen
 * shows may come twice — never one it does not show not at all).
 */
export function beforeScreen(steps, screen) {
  const text = squash(screen || "");
  let cut = steps.length;
  for (let i = steps.length - 1; i >= 0; i--) {
    const n = needle(steps[i]);
    if (n === null) continue;
    if (!text.includes(n)) break;
    cut = i;
  }
  return steps.slice(0, cut);
}

// ── Drawing ──
const TOOL_WORDS = { Edit: "Update", MultiEdit: "Update", Grep: "Search", Glob: "Search", WebFetch: "Fetch", WebSearch: "Web Search", TodoWrite: "Update Todos", Agent: "Task", NotebookEdit: "Edit Notebook" };
/** Claude's word for a tool, as its screen shows it ("Update" for Edit; "server - tool (MCP)" for an MCP tool). */
export function toolWord(tool) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || "");
  if (mcp) return `${mcp[1]} - ${mcp[2]} (MCP)`;
  return TOOL_WORDS[tool] || tool || "?";
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function span(doc, text, color, extra) {
  const s = el(doc, "span", extra || null, text);
  if (color) s.style.color = color;                     // CSSOM, never a style attribute (#1300)
  return s;
}
/** A Read result's "12\tcode" lines as the terminal shows them ("  12  code"). */
const unTab = (text, tool) => (tool === "Read" ? text.replace(/^(\d+)\t/gm, (_, n) => `${n.padStart(4)}  `) : text.replace(/\t/g, "  "));

/** One step's block. `onMore`: the folded step, clicked. */
export function drawStep(doc, step, pal, glyphs, onMore) {
  const box = el(doc, "div", "vh-step");
  box.dataset.step = step.id;
  const line = (cls) => box.appendChild(el(doc, "div", `vh-line${cls ? ` ${cls}` : ""}`));
  if (step.kind === "user") {
    (step.body || "").split("\n").forEach((text, i) => {
      const l = line("vh-prompt");
      l.style.background = pal.promptBand;
      l.appendChild(span(doc, i === 0 ? `${glyphs.prompt} ` : "  ", pal.promptFg));
      l.appendChild(span(doc, text || " ", pal.promptText));
    });
    if (step.cut) line("vh-dim").textContent = `  ${w("cut", step.cut)}`;
    return box;
  }
  if (step.kind === "assistant") {
    (step.body || "").split("\n").forEach((text, i) => {
      const l = line();
      l.appendChild(i === 0 ? span(doc, `${glyphs.bullet} `, pal.replyFg) : span(doc, "  "));
      l.appendChild(span(doc, text || " "));
    });
    if (step.cut) line("vh-dim").textContent = `  ${w("cut", step.cut)}`;
    return box;
  }
  if (step.kind === "tool") {
    const head = line();
    const fg = step.status === "failed" ? pal.failedFg : step.status === "running" || step.status === "interrupted" ? pal.runningFg : pal.toolFg;
    head.appendChild(span(doc, `${glyphs.bullet} `, fg));
    head.appendChild(span(doc, toolWord(step.tool), null, "vh-b"));
    head.appendChild(span(doc, step.subject ? `(${step.subject})` : ""));
  }
  // The result: "  ⎿  " then its first line; the rest under it — or the edit's diff rows.
  const resultColor = step.kind === "error" || step.status === "failed" ? pal.errorFg : null;
  let firstRow = true;
  const mark = () => { const s = firstRow ? span(doc, `  ${glyphs.result}  `, pal.resultFg) : span(doc, "     "); firstRow = false; return s; };
  if (step.diff) {
    for (const h of step.diff) {
      for (const [rows, sign, bg, fg] of [[h.del, "-", pal.delBg, pal.delFg], [h.add, "+", pal.addBg, pal.addFg]]) {
        for (const text of rows) {
          const l = line("vh-res");
          l.appendChild(mark());
          const row = span(doc, `${sign} ${text}`, fg, "vh-diff");
          row.style.background = bg;
          l.appendChild(row);
        }
      }
    }
  } else if (step.body != null && step.body !== "") {
    for (const text of unTab(step.body, step.tool).split("\n")) {
      const l = line("vh-res");
      l.appendChild(mark());
      l.appendChild(span(doc, text || " ", resultColor));
    }
  }
  if (step.more) {
    const l = line("vh-res");
    l.appendChild(span(doc, "     "));
    const b = el(doc, "button", "vh-more", w("more", step.more));
    b.type = "button";
    b.style.color = pal.resultFg;
    b.addEventListener("click", () => onMore && onMore(step, box, b));
    l.appendChild(b);
  } else if (step.cut) line("vh-res vh-dim").textContent = `     ${w("cut", step.cut)}`;
  return box;
}

/**
 * The history above one agent's live screen. `fetch(url)` reads under the View's lease; `alive()` is false once the
 * View moved on (nothing is drawn then). `root` is the block panel-view.js puts above the screen it shows.
 */
export function createHistory({ name, fetch, alive = () => true, doc = document, font = "monospace", cols = 0 }) {
  ensureStylesheet(doc);
  const root = el(doc, "div", "vh");
  root.setAttribute("data-trust", "panel-content");
  if (cols > 0) root.style.width = `${cols}ch`;
  const pages = el(doc, "div", "vh-pages");
  const capNote = el(doc, "div", "vh-cap");
  const divider = el(doc, "div", "vh-divider", w("divider"));
  divider.setAttribute("role", "separator");
  root.append(pages, divider);
  let pal = DEFAULT_PALETTE, glyphs = null;
  let key = null, before = null, shown = 0, busy = false;
  const base = `/api/pane/${encodeURIComponent(name)}?transcript=1`;
  const read = async (query) => {
    const r = await fetch(`${base}${query}`);
    // An older server answers the pane's text here: not this history.
    const type = r.headers && typeof r.headers.get === "function" ? String(r.headers.get("Content-Type") || "") : "";
    if (!r.ok) return { failed: true, status: r.status };
    if (!type.includes("application/json")) return { unsupported: true };
    const body = await r.json();
    if (!body || body.view_history !== 1) return { unsupported: true };
    return body;
  };
  const block = (steps, end) => {
    const frag = doc.createDocumentFragment();
    for (const s of steps) {
      const b = drawStep(doc, s, pal, glyphs, more);
      b.dataset.end = String(end);
      frag.appendChild(b);
    }
    return frag;
  };
  async function more(step, box, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const body = await read(`&step=${encodeURIComponent(step.id)}&end=${encodeURIComponent(box.dataset.end)}&key=${encodeURIComponent(key || "")}`);
      if (!alive()) return;
      if (!body.supported || !body.step) throw new Error("gone");
      const whole = drawStep(doc, body.step, pal, glyphs, more);
      whole.dataset.end = box.dataset.end;
      box.replaceWith(whole);
    } catch {
      if (!alive()) return;
      button.disabled = false;
      if (!box.querySelector(".vh-more-failed")) button.parentNode.insertBefore(span(doc, `  ${w("moreFailed")}`, pal.errorFg, "vh-more-failed"), button.nextSibling);
    }
  }
  return {
    root,
    /** Older steps exist and the cap is not reached. */
    hasOlder: () => before !== null && shown < HISTORY_STEP_CAP,
    /**
     * The newest page, minus what the live `screen` (ANSI) shows. "ok" | "empty" (nothing before the screen) |
     * "unsupported" (no history here) | "failed" (with `status`).
     */
    async first(screen) {
      pal = samplePalette(screen);
      glyphs = { prompt: drawable(pal.promptGlyph, font, doc), bullet: drawable(pal.bullet, font, doc), result: drawable(pal.resultGlyph, font, doc) };
      let body;
      try { body = await read(""); } catch { return { kind: "failed", status: 0 }; }
      if (body.failed) return { kind: "failed", status: body.status };
      if (body.unsupported) return { kind: "unsupported" };
      // No history here at all (not Claude, or no reader) — or none YET (a session that has written nothing so far):
      // that one is only nothing earlier, asked again next time.
      if (!body.supported) return { kind: body.reason === "unsupported" || body.reason === "unavailable" ? "unsupported" : "empty" };
      key = body.key; before = body.before;
      let steps = beforeScreen(body.steps || [], screen);
      let end = body.end;
      // Everything in the newest page is on the screen: the page before it is the history.
      if (!steps.length && before !== null) {
        let older;
        try { older = await read(`&before=${before}&key=${encodeURIComponent(key)}`); } catch { older = { failed: true, status: 0 }; }
        if (!older.failed && older.supported && !older.reset) { steps = older.steps || []; before = older.before; end = older.end; }
      }
      if (!alive()) return { kind: "failed", status: 0 };
      if (!steps.length) return { kind: "empty" };
      pages.replaceChildren(block(steps, end));
      shown = steps.length;
      return { kind: "ok" };
    },
    /** The page before what is shown, drawn above it. "ok" | "none" | "capped" | "failed". */
    async older() {
      if (busy) return { kind: "none" };
      if (before === null) return { kind: "none" };
      if (shown >= HISTORY_STEP_CAP) {
        if (!capNote.isConnected) { capNote.textContent = w("capped", HISTORY_STEP_CAP); root.prepend(capNote); }
        return { kind: "capped" };
      }
      busy = true;
      try {
        const body = await read(`&before=${before}&key=${encodeURIComponent(key || "")}`);
        if (!alive()) return { kind: "failed" };
        if (body.failed || body.unsupported || !body.supported) return { kind: "failed" };
        // Another transcript now (a new session): what is shown stays; nothing older of it.
        if (body.reset) { before = null; return { kind: "none" }; }
        before = body.before;
        const steps = body.steps || [];
        if (steps.length) { pages.prepend(block(steps, body.end)); shown += steps.length; }
        return { kind: "ok" };
      } catch { return { kind: "failed" }; }
      finally { busy = false; }
    },
  };
}

/** This module's own stylesheet, linked once (a tab opened before an upgrade has an app.css without these rules). */
function ensureStylesheet(doc) {
  try {
    if (!doc.head || doc.querySelector('link[data-vh="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "/assets/view-history.css");
    link.setAttribute("data-vh", "1");
    doc.head.appendChild(link);
  } catch { /* the history still reads without it */ }
}
