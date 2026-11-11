// AGEND-181: which steps belong above which chat reply — a pure function, no DOM, no fetch.
//
// Input: the chat ledger's rows (`rows`: role user/agent/…, `anchor`, `text`, `ts`) and the instance's steps in file order
// (log-steps.ts; the same list the Log tab shows). Output: groups of steps, each placed on a ledger row or at the end:
//
//   • a turn starts at a user step and runs to the next one; `turn_end` closes it;
//   • inside a turn every `reply` tool call closes a segment: the steps since the previous reply (or the turn's start) are
//     what produced THAT reply — thinking, intermediate text, tool calls; the `reply` row itself is the bubble below;
//   • steps after the turn's last reply (the CLI often says one more thing that is never sent) stay on that reply's
//     group as `trailing` once the turn ended; before that they are the live group at the end of the thread.
//
// A segment is placed on its reply's row by the most exact thing that matches, and says which (`level`):
//   id    the reply call's result `messageId` equals the row's `anchor` (what afterReplyRouted records);
//   text  the start of the call's text equals the start of an agent row's text — rows taken in order, never back (a
//         monotonic cursor: two replies that say the same short thing each get their own row);
//   time  an unclaimed agent row written within TIME_SLACK_MS of the call;
//   turn  the turn has no `reply` at all (a backend that has none): its steps go above the last agent row between its
//         user row and the next user row;
//   none  nothing matched: an "activity" group of its own, between the rows by time. Never attached to a guess.
// A page labels `text`, `time`, `turn` and `none` as inferred. A reply call seen a moment before its row arrives is
// `live` (placed at the end) so the group does not jump when the row comes.
//
// Keys: `act:<turn>:<n>` (n: the segment's number in its turn) — the same key while a segment is live and after its
// reply arrives, so the page keeps the node (no remount, no scroll jump).

export const TIME_SLACK_MS = 5000;
/** A reply call this recent, with no row yet, is assumed to be about to get one. */
export const AWAIT_ROW_MS = 15000;
/** The steps a timeline shows (the rest — the user's prompt, the turn's end, compaction notes — are bubbles or noise). */
const SHOWN = new Set(["thinking", "assistant", "tool", "error"]);
const REPLY_TOOL = /^(?:mcp__agend[\w-]*__|agend[\w-]*:)?reply$/;
const REPLY_TEXT = 200;

export const rowKeyOf = (x) => `${x.boot}-${x.id}`;
export const isReplyStep = (s) => s.kind === "tool" && typeof s.tool === "string" && REPLY_TOOL.test(s.tool);

const rowTs = (x) => { const t = Date.parse(x.ts); return Number.isFinite(t) ? t : 0; };
const head = (text) => String(text == null ? "" : text).slice(0, REPLY_TEXT);

/** Runs of steps with the same `turn` (the transcript's own id for it), in file order. */
function turnsOf(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && last.turn === s.turn) last.steps.push(s);
    else out.push({ turn: s.turn, steps: [s] });
  }
  return out;
}

/**
 * @param rows  ledger rows in order
 * @param steps steps in file order
 * @param opts  { now?: ms, complete?: boolean — the steps reach back to the transcript's start (false: the first turn may
 *              lack its beginning), instance? }
 * @returns { groups: Group[], live: Group|null }
 *   Group = { key, turn, n, level, rowKey: string|null, items: Step[], trailing: Step[], ts: number, partial?: true,
 *   ended: the segment is complete (false: live), turnEnded: the turn is over — only then are `trailing` steps "never sent" }
 *   `groups` are in thread order; `rowKey` is the row a group sits above (null: between rows by `ts`, or live at the end).
 */
export function groupSteps(rows, steps, opts = {}) {
  const now = opts.now ?? Date.now();
  const agents = rows.map((x, i) => ({ x, i })).filter((r) => r.x.role === "agent");
  const users = rows.map((x, i) => ({ x, i })).filter((r) => r.x.role === "user");
  const taken = new Set();
  let cursor = 0;                                        // an index into `rows`: text matches never go back past it
  const turns = turnsOf(steps);
  const groups = [];
  let live = null;

  const claim = (r, level) => { taken.add(r.i); if (r.i + 1 > cursor) cursor = r.i + 1; return { rowKey: rowKeyOf(r.x), level }; };
  /** The agent row a `reply` call produced, by the most exact match that holds. */
  const place = (replyStep) => {
    const a = replyStep.anchor || {};
    if (a.messageId) {
      const r = agents.find((c) => !taken.has(c.i) && c.x.anchor === a.messageId);
      if (r) return claim(r, "id");
    }
    if (a.replyText) {
      const r = agents.find((c) => c.i >= cursor && !taken.has(c.i) && c.x.text !== undefined && head(c.x.text) === a.replyText);
      if (r) return claim(r, "text");
    }
    if (replyStep.ts) {
      let best = null, bestD = TIME_SLACK_MS + 1;
      for (const c of agents) {
        if (taken.has(c.i)) continue;
        const d = Math.abs(rowTs(c.x) - replyStep.ts);
        if (d < bestD) { best = c; bestD = d; }
      }
      if (best) return claim(best, "time");
    }
    return null;
  };

  turns.forEach((turn, ti) => {
    const first = turn.steps.find((s) => s.kind === "user");
    const ended = turn.steps.some((s) => s.kind === "turn_end");
    const lastTurn = ti === turns.length - 1;
    const userRow = first && first.anchor && first.anchor.messageId
      ? users.find((r) => r.x.anchor === first.anchor.messageId) || null : null;
    const tkey = turn.turn || `~${ti}`;
    let seg = [], n = 0, replied = 0;
    const segs = [];
    const flush = (replyStep) => { segs.push({ n: n++, items: seg, reply: replyStep }); seg = []; };
    for (const s of turn.steps) {
      if (s.kind === "user" || s.kind === "turn_end" || s.kind === "state") continue;
      if (isReplyStep(s)) { replied++; flush(s); continue; }
      if (SHOWN.has(s.kind)) seg.push(s);
    }
    const tail = seg;                                      // after the last reply (or the whole turn when it had none)
    const partial = ti === 0 && opts.complete === false && !first;
    // A turn with no reply at all that has ended: its steps go above the last agent row after its user row (`turn`).
    if (!replied && ended && tail.length && userRow) {
      const next = users.find((r) => r.i > userRow.i);
      const cand = agents.filter((r) => r.i > userRow.i && (!next || r.i < next.i) && !taken.has(r.i));
      const last = cand[cand.length - 1];
      if (last) {
        taken.add(last.i);
        groups.push({ key: `act:${tkey}:0`, turn: turn.turn, n: 0, level: "turn", rowKey: rowKeyOf(last.x), items: tail, trailing: [], ts: tail[0].ts || 0, ended: true, turnEnded: true, ...(partial ? { partial: true } : {}) });
        return;
      }
    }
    segs.forEach((sg) => {
      const where = place(sg.reply);
      const ts = (sg.items[0] && sg.items[0].ts) || sg.reply.ts || 0;
      const base = { key: `act:${tkey}:${sg.n}`, turn: turn.turn, n: sg.n, items: sg.items, trailing: [], ts, ended: true, turnEnded: ended, ...(partial && sg.n === 0 ? { partial: true } : {}) };
      if (where) { groups.push({ ...base, ...where }); return; }
      const awaiting = lastTurn && (sg.reply.status === "running" || (sg.reply.ts && now - sg.reply.ts < AWAIT_ROW_MS));
      if (!awaiting) { groups.push({ ...base, level: "none", rowKey: null }); return; }
      if (live) groups.push({ ...live, level: "none", ended: true });
      live = { ...base, level: "live", rowKey: null, ended: false };
    });
    if (!tail.length) return;
    // What came after the last reply.
    if (!ended && lastTurn) {
      // Still going. A reply whose row has not arrived yet is the live group, and this is more work after it.
      if (live) live.trailing = tail;
      else live = { key: `act:${tkey}:${n}`, turn: turn.turn, n, level: "live", rowKey: null, items: tail, trailing: [], ts: tail[0].ts || 0, ended: false, turnEnded: false, ...(partial && !segs.length ? { partial: true } : {}) };
      return;
    }
    // Ended (or an earlier turn that never saw its end): they ride on the last reply's group, shown as never sent.
    const lastPlaced = [...groups].reverse().find((g) => g.turn === turn.turn);
    if (lastPlaced) { lastPlaced.trailing = tail; return; }
    groups.push({ key: `act:${tkey}:${n}`, turn: turn.turn, n, level: "none", rowKey: null, items: tail, trailing: [], ts: tail[0].ts || 0, ended: true, turnEnded: ended, ...(partial && !segs.length ? { partial: true } : {}) });
  });
  return { groups, live };
}

/**
 * The ledger rows with each group as a synthetic `{ role: "activity" }` row before the reply it belongs to; a group
 * with no row (`none`, by its time) between the rows; the live group last. The rows themselves are never changed.
 */
export function composeRows(rows, { groups, live }) {
  const before = new Map();
  const loose = [];
  for (const g of groups) {
    if (g.rowKey) { const l = before.get(g.rowKey) || []; l.push(g); before.set(g.rowKey, l); } else loose.push(g);
  }
  const act = (g) => ({ role: "activity", boot: "act", id: g.key, group: g, ts: g.ts ? new Date(g.ts).toISOString() : "" });
  const out = [];
  const looseLeft = loose.slice().sort((a, b) => a.ts - b.ts);
  for (const x of rows) {
    const t = rowTs(x);
    while (looseLeft.length && t && looseLeft[0].ts && looseLeft[0].ts < t) out.push(act(looseLeft.shift()));
    for (const g of before.get(rowKeyOf(x)) || []) out.push(act(g));
    out.push(x);
  }
  for (const g of looseLeft) out.push(act(g));
  if (live) out.push(act(live));
  return out;
}
