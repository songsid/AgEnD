// #2911 (1): the versions of a page in the preview panel, and the changes from one to the next. Pure functions: the
// panel (preview-panel.js) draws them. Nothing here runs a preview — a version is shown as any block is, waiting for
// Preview (#1481 §14).
import "./chat-render.js";

const R = () => globalThis.AgendChatRender;

/** The text of a block's <title>, or "" — what says two blocks are versions of one thing. */
export function htmlTitle(code) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(code || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Every version of the shown block in the loaded thread, oldest first, and where the shown one is in it.
 * - An attached file: the agent's attachments of the same name (case-insensitive). Their HTML is read when picked (code: null).
 * - A titled block: the agent's complete ```html blocks with the same <title>.
 * - An untitled block: the agent's complete untitled blocks — a titled one is another page.
 * Only agent replies count, and only complete blocks, as for a card. `index` is -1 (and `list` is just the shown block)
 * when the block is no longer in the thread.
 */
export function versionsOf(open, msgs, keyOf) {
  if (!open) return { list: [], index: -1 };
  const list = [];
  const all = Array.isArray(msgs) ? msgs : [];
  if (open.att) {
    const name = String(open.att.name || "").trim().toLowerCase();
    for (const x of all) {
      if (x.role !== "agent" || !Array.isArray(x.attachments)) continue;
      const msgKey = keyOf(x);
      for (const a of x.attachments) {
        if (!R().isHtmlAttachment(a) || a.name.trim().toLowerCase() !== name) continue;
        list.push({ key: `${msgKey}:a${a.id}`, instance: open.instance, msgKey, att: { id: a.id, name: a.name, size: a.size }, code: null, sender: x.sender, ts: x.ts });
      }
    }
  } else {
    const title = htmlTitle(open.code);
    for (const x of all) {
      if (x.role !== "agent") continue;
      const msgKey = keyOf(x);
      R().htmlFences(x.text).forEach((f, n) => {
        if (!f.terminated || htmlTitle(f.code) !== title) return;
        list.push({ key: `${msgKey}:f${n}`, instance: open.instance, msgKey, n, code: f.code, sender: x.sender, ts: x.ts });
      });
    }
  }
  const index = list.findIndex(v => v.key === open.key);
  return index < 0 ? { list: [open], index: -1 } : { list, index };
}

// ── Changes: a line diff (Myers), bounded ──

/** Past these, "Changes" says the versions are too large or too different to compare here. */
export const DIFF_LIMITS = { maxChars: 5 * 1024 * 1024, maxEdits: 2000, context: 3, maxLines: 3000 };

const lines = (s) => { if (!s) return []; const v = String(s).replace(/\r\n?/g, "\n").split("\n"); if (v.length > 1 && v[v.length - 1] === "") v.pop(); return v; };

/**
 * The line edits from `a` to `b`: [{ t: " " | "-" | "+", text }] in order, or null when it cannot be done within
 * DIFF_LIMITS (either side over maxChars, or more than maxEdits lines differ after the common head and tail).
 */
export function lineDiff(a, b, limits = DIFF_LIMITS) {
  if (String(a ?? "").length > limits.maxChars || String(b ?? "").length > limits.maxChars) return null;
  const A = lines(a), B = lines(b);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const x = A.slice(head, A.length - tail), y = B.slice(head, B.length - tail);
  const mid = myers(x, y, limits.maxEdits);
  if (!mid) return null;
  return [...A.slice(0, head).map(text => ({ t: " ", text })), ...mid, ...A.slice(A.length - tail).map(text => ({ t: " ", text }))];
}

/** Myers' O((N+M)·D) shortest edit script, with D capped (the trace is kept for the walk back). */
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= n && j >= m) return walkBack(a, b, trace, d);
    }
  }
  return null;
}

function walkBack(a, b, trace, dEnd) {
  const out = [];
  let i = a.length, j = b.length;
  for (let d = dEnd; d >= 0; d--) {
    const vd = trace[d], at = (k) => vd[k + d + 1];   // trace[d] holds v[-d-1 .. d+1] before step d
    const k = i - j;
    if (d === 0) { while (i > 0 && j > 0) { out.push({ t: " ", text: a[--i] }); j--; } break; }
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1, pi = at(pk), pj = pi - pk;
    while (i > pi && j > pj) { out.push({ t: " ", text: a[--i] }); j--; }
    if (down) out.push({ t: "+", text: b[--j] }); else out.push({ t: "-", text: a[--i] });
  }
  return out.reverse();
}

/**
 * The edits as hunks with `context` lines around each change, as a unified diff shows them:
 * [{ oldStart, oldLines, newStart, newLines, lines: [{ t, text }] }] (1-based starts). [] when nothing changed.
 */
export function diffHunks(ops, context = DIFF_LIMITS.context) {
  // Each op's line numbers on either side (before it), then the changed spans widened by `context` and merged.
  const oldAt = [], newAt = [];
  let o = 1, n = 1;
  for (const op of ops) { oldAt.push(o); newAt.push(n); if (op.t !== "+") o++; if (op.t !== "-") n++; }
  const ranges = [];
  ops.forEach((op, idx) => {
    if (op.t === " ") return;
    const from = Math.max(0, idx - context), to = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to); else ranges.push({ from, to });
  });
  return ranges.map(({ from, to }) => {
    const part = ops.slice(from, to + 1);
    return {
      oldStart: oldAt[from], newStart: newAt[from],
      oldLines: part.filter(x => x.t !== "+").length, newLines: part.filter(x => x.t !== "-").length,
      lines: part,
    };
  });
}
