// #1918 phase 3: live cross-instance traffic on the org canvas (fleet-canvas.js) — what src/fleet-traffic.ts sends: the
// stream's `traffic` items, and GET /ui/traffic's snapshot when the tab opens (and on the public link, which has no
// stream, every POLL_MS while the page is shown — the user's decision 1). Ids are opaque; there is never any text.
//
// - The store keeps each message's latest state: queued (a dotted line), delivering (a dash and a pulse), delivered
//   or consumed (the line stays FADE_MS while it fades, then goes — long enough to see: an MCP send is delivered and
//   read almost at once); failed, uncertain or cancelled ends it at once (a failed or uncertain delivery is Needs you's
//   to show, #1386). A finished message never comes back.
// - And the work (the server's Delegations, stream event `delegation`, the snapshot's `delegations`): a task's
//   delegator → worker line stays, "in progress" (a moving dash), until its report comes back; then a short return
//   pulse worker → delegator (RETURN_MS), and it goes. One that waits past DELEGATION_TTL_MS fades as "no report yet".
// - Every line ends on something drawn: a card, or a folded team's box (a name not on the canvas draws nothing), and
//   runs through lanes that touch the boxes it joins — two cards in one box are joined inside it.
// - Edges are routed metro-style through the lanes the layout keeps empty (beside the columns and between card rows
//   inside a box; the bus above each row of teams; the trunk at the left), so a line never crosses a card.
// - Near: one edge per (from, to, kind, phase), ×N when several share it. Far (zoomed out): one edge per team pair.
//   A broadcast (one message per recipient, sharing an `op`) is a fan-out from its sender; more than BUNDLE_AT
//   recipients, or far, it is one edge per recipient team, ×N (the user's decision 3). At most MAX_EDGES are drawn.
import { OC } from "./fleet-canvas-layout.js";

export const FADE_MS = 12000;
export const RETURN_MS = 2400;
/** As the server's (src/fleet-traffic.ts): how long a delegation waits for its report. */
export const DELEGATION_TTL_MS = 4 * 3_600_000;
export const POLL_MS = 5000;
export const MAX_EDGES = 60;
export const BUNDLE_AT = 8;
export const FAR_K = 0.55;
const MAX_ITEMS = 400, MAX_DONE = 2000, MAX_WORK = 200;
const DSTATES = new Set(["open", "done", "expired", "cancelled"]);
const LIVE = new Set(["queued", "delivering"]);
const ENDS = new Set(["failed", "uncertain", "cancelled"]);
/** Delivered, or read: the line fades out (FADE_MS). */
const SETTLED = new Set(["delivered", "consumed"]);
const KINDS = new Set(["task", "report", "query", "update", "send", "broadcast"]);
const mono = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** A traffic item as the server sends it, checked; null for anything else. */
export function itemOk(x) {
  if (!x || typeof x !== "object") return null;
  const { id, from, to, kind, state, op } = x;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof from !== "string" || !from || typeof to !== "string" || !to) return null;
  if (!KINDS.has(kind) || !(LIVE.has(state) || SETTLED.has(state) || ENDS.has(state))) return null;
  return { id, from, to, kind, state, ...(typeof op === "string" && /^[0-9a-f]{16}$/.test(op) ? { op } : {}) };
}

/** A delegation as the server sends it, checked; null for anything else. */
export function delegationOk(x) {
  if (!x || typeof x !== "object") return null;
  const { id, from, to, state, age_ms } = x;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof from !== "string" || !from || typeof to !== "string" || !to || from === to) return null;
  if (!DSTATES.has(state) || typeof age_ms !== "number" || !Number.isFinite(age_ms) || age_ms < 0) return null;
  return { id, from, to, state, age: age_ms };
}

/**
 * The page's traffic: `apply(item, nowMs)` one stream item, `delegation(d, nowMs)` one delegation event,
 * `load(snapshot, nowMs, since)` a snapshot, `sweep(nowMs)` drops faded lines; each returns whether anything shown
 * changed. `items()` what to draw: { …item, fading }. `streamRev()` counts the stream's events: a snapshot asked for
 * before the latest one (`since` older than it) may be older than what the stream already said, so it adds only what
 * is new and ends or rewinds nothing (#2135 review).
 * Ended work is remembered (bounded): a late snapshot never draws a delegation that is done, expired or taken back.
 */
export function createTrafficStore() {
  const items = new Map();          // id → { item, fadeAt }
  const work = new Map();           // delegation id → { d, phase: "work" | "return" | "stale", until }
  const done = new Set();           // message ids that ended: a late item for one is ignored
  const ended = new Set();          // delegation ids that ended: never drawn in progress again
  let rev = 0;
  const finish = (id) => {
    items.delete(id);
    done.add(id);
    if (done.size > MAX_DONE) done.delete(done.values().next().value);
  };
  const end = (id) => {
    ended.add(id);
    if (ended.size > MAX_DONE) ended.delete(ended.values().next().value);
  };
  const applyItem = (raw, now) => {
    const it = itemOk(raw);
    if (!it || done.has(it.id)) return false;
    const prev = items.get(it.id);
    if (ENDS.has(it.state)) { const had = !!prev; finish(it.id); return had; }
    if (prev && prev.fadeAt !== null) return false;                            // fading: never goes back, nor starts again
    if (prev && prev.item.state === it.state) return false;
    if (it.state === "consumed" && !prev) { finish(it.id); return false; }      // read before this page drew it
    items.delete(it.id);
    // A message keeps what it was (from, to, kind) through its states; only the state moves.
    items.set(it.id, { item: prev ? { ...prev.item, state: it.state } : it, fadeAt: SETTLED.has(it.state) ? now + FADE_MS : null });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    return true;
  };
  const applyDelegation = (raw, now) => {
    const d = delegationOk(raw);
    if (!d || ended.has(d.id)) return false;
    const prev = work.get(d.id);
    if (d.state === "open") {
      if (prev) return false;
      work.set(d.id, { d, phase: "work", until: now + Math.max(0, DELEGATION_TTL_MS - d.age) });
      while (work.size > MAX_WORK) { const oldest = work.keys().next().value; work.delete(oldest); end(oldest); }
      return true;
    }
    end(d.id);
    if (d.state === "cancelled") return work.delete(d.id);
    if (d.state === "done") { work.set(d.id, { d, phase: "return", until: now + RETURN_MS }); return true; }
    if (!prev || prev.phase !== "work") return false;                              // expired: only one this page shows
    work.set(d.id, { d, phase: "stale", until: now + FADE_MS });
    return true;
  };
  const store = {
    apply(raw, now = mono()) { rev++; return applyItem(raw, now); },
    delegation(raw, now = mono()) { rev++; return applyDelegation(raw, now); },
    streamRev: () => rev,
    /**
     * A snapshot is the truth for what is in flight: anything live it no longer lists has ended (missed while away) —
     * unless the stream has spoken since it was asked for (`since`): then it may be older than what is drawn, and only
     * what is new to this page is taken from it.
     */
    load(snap, now = mono(), since = rev) {
      const fresh = since === rev;
      const list = snap && Array.isArray(snap.items) ? snap.items.map(itemOk).filter(Boolean) : [];
      const listed = new Set(list.map((i) => i.id));
      let changed = false;
      if (fresh) for (const [id, e] of items) if (!listed.has(id) && LIVE.has(e.item.state)) { finish(id); changed = true; }
      // Delivered or read, for a line drawn here: it fades now (with no stream, the snapshot is the only news of it). Any
      // other finished message is not drawn (it finished up to two minutes ago), and an ended one goes.
      for (const it of list) {
        if (!fresh && items.has(it.id)) continue;                                    // the stream knows it better
        if (LIVE.has(it.state) || (SETTLED.has(it.state) && items.has(it.id))) changed = applyItem(it, now) || changed;
        else if (fresh) { const had = items.has(it.id); finish(it.id); changed = changed || had; }
      }
      // The open delegations: the snapshot's list is the truth (one it no longer lists ended while this page was away).
      const open = snap && Array.isArray(snap.delegations) ? snap.delegations.filter((d) => delegationOk(d)?.state === "open") : [];
      const ids = new Set(open.map((d) => d.id));
      if (fresh) for (const [id, e] of work) if (e.phase === "work" && !ids.has(id)) { work.delete(id); end(id); changed = true; }
      for (const d of open) changed = applyDelegation(d, now) || changed;
      return changed;
    },
    sweep(now = mono()) {
      let changed = false;
      for (const [id, e] of items) if (e.fadeAt !== null && now >= e.fadeAt) { finish(id); changed = true; }
      for (const [id, e] of work) {
        if (now < e.until) continue;
        if (e.phase === "work") { end(id); work.set(id, { ...e, phase: "stale", until: now + FADE_MS }); }    // its wait ran out here
        else work.delete(id);
        changed = true;
      }
      return changed;
    },
    /** What to draw: the messages, then the work (a done one is its return, worker → delegator). */
    items: () => [...[...items.values()].map((e) => ({ ...e.item, fading: e.fadeAt !== null })),
      ...[...work.values()].map(({ d, phase }) => phase === "return"
        ? { id: `r${d.id}`, from: d.to, to: d.from, kind: "report", state: "delivering", phase, fading: false }
        : { id: `w${d.id}`, from: d.from, to: d.to, kind: "task", state: "delivering", phase, fading: false })],
    fadingCount: () => [...items.values()].filter((e) => e.fadeAt !== null).length,
  };
  return store;
}

// ── Where a name is on the canvas ──

/** The team a name is drawn in (its first, if it is in two), null for General, undefined when it is not on the canvas. */
function teamOf(L, name) {
  if (L.tops.some((c) => c.node.name === name)) return null;
  const b = L.boxes.find((x) => x.nodes.some((n) => n.name === name));
  return b ? b : undefined;
}
/** An end of a line: General's card, a member's card, or its folded team's box. */
function endOf(L, name) {
  const top = L.tops.find((c) => c.node.name === name);
  if (top) return { kind: "top", c: top, key: top.key };
  const b = teamOf(L, name);
  if (!b) return null;
  if (b.folded) return { kind: "box", b, key: `box:${b.key}` };
  const i = b.cells.findIndex((c) => c.node.name === name);
  return { kind: "cell", b, i, c: b.cells[i], key: b.cells[i].key };
}

// ── Routing: lanes the layout keeps empty ──

/** A side lane's offset from the middle of the box's padding: at least 6 px from the box's border and from its cards. */
const laneOffset = (o) => Math.max(-OC.PAD / 2 + 6, Math.min(OC.PAD / 2 - 6, o * 0.5));

const firstBusOf = (L) => Math.min(...L.boxes.map((b) => b.busY));
/** From an end up to its row's bus lane: the points, and the lane's y. `o` spreads lines sharing a lane. */
function outward(L, end, o) {
  if (end.kind === "top") {
    const x = end.c.x + end.c.w / 2 + Math.max(-end.c.w / 2 + 12, Math.min(end.c.w / 2 - 12, o * 2.4));
    const bus = firstBusOf(L) + o;
    return { pts: [{ x, y: end.c.y + end.c.h }, { x, y: bus }], bus };
  }
  const b = end.b;
  if (end.kind === "box") {
    const x = b.x + b.w / 2 + o * 1.5;
    return { pts: [{ x, y: b.y }, { x, y: b.busY + o }], bus: b.busY + o };
  }
  const { PAD, GAP, NW, NH } = OC;
  const card = end.c, col = end.i % b.cols, rowI = Math.floor(end.i / b.cols), lines = Math.ceil(b.cells.length / b.cols);
  const io = laneOffset(o);
  const leftLane = b.x + PAD / 2 + io, rightLane = b.x + b.w - PAD / 2 + io;
  let pts;
  if (col === 0 || col === b.cols - 1) {
    const left = col === 0, lane = left ? leftLane : rightLane, cy = card.y + NH / 2 + io;
    pts = [{ x: left ? card.x : card.x + NW, y: cy }, { x: lane, y: cy }, { x: lane, y: b.y }];
  } else {
    // A middle column: down into the gutter below its row, across to the nearer side lane.
    const gy = card.y + NH + (rowI === lines - 1 ? PAD : GAP) / 2 + io / 2, cx = card.x + NW / 2 + o;
    const lane = cx - b.x < b.w / 2 ? leftLane : rightLane;
    pts = [{ x: cx, y: card.y + NH }, { x: cx, y: gy }, { x: lane, y: gy }, { x: lane, y: b.y }];
  }
  const top = pts[pts.length - 1];
  pts.push({ x: top.x, y: b.busY + o });
  return { pts, bus: b.busY + o };
}
/**
 * Inside a box, from a card to one of its side lanes (x `lane`): straight out when the card is in that lane's column,
 * else down into the gutter under its row (no card is there) and across. The last point is on the lane.
 */
function toLane(L, end, lane, o) {
  const { PAD, GAP, NW, NH } = OC;
  const b = end.b, card = end.c, col = end.i % b.cols, rowI = Math.floor(end.i / b.cols), lines = Math.ceil(b.cells.length / b.cols);
  const io = laneOffset(o);
  const left = lane < b.x + b.w / 2;
  if ((left && col === 0) || (!left && col === b.cols - 1)) {
    const cy = card.y + NH / 2 + io;
    return [{ x: left ? card.x : card.x + NW, y: cy }, { x: lane, y: cy }];
  }
  const gy = card.y + NH + (rowI === lines - 1 ? PAD : GAP) / 2 + io / 2, cx = card.x + NW / 2 + o;
  return [{ x: cx, y: card.y + NH }, { x: cx, y: gy }, { x: lane, y: gy }];
}
/** Two cards in one open box: joined inside it, through the side lane nearer to them both (never out to the bus). */
function inBox(L, a, z, o) {
  const b = a.b, { PAD } = OC;
  const io = laneOffset(o);
  const mid = ((a.i % b.cols) + (z.i % b.cols)) / 2;
  const lane = mid <= (b.cols - 1) / 2 ? b.x + PAD / 2 + io : b.x + b.w - PAD / 2 + io;
  return [...toLane(L, a, lane, o), ...toLane(L, z, lane, o).reverse()];
}
/** Two of General's cards: under them, through the gap above the first row (or the canvas's empty space below). */
function betweenTops(a, z, o) {
  const y = a.c.y + a.c.h + 30 + o * 0.6;
  const ax = a.c.x + a.c.w / 2 + o, zx = z.c.x + z.c.w / 2 + o;
  return [{ x: ax, y: a.c.y + a.c.h }, { x: ax, y }, { x: zx, y }, { x: zx, y: z.c.y + z.c.h }];
}
/**
 * The points of a line from one end to the other: up to the bus, along it (and the trunk, between rows), down — or,
 * for two cards in one box, inside the box; for two of General's cards, just under them.
 */
export function route(L, a, z, o) {
  if (a.kind === "cell" && z.kind === "cell" && a.b === z.b) return inBox(L, a, z, o);
  if (a.kind === "top" && z.kind === "top") return betweenTops(a, z, o);
  const p = outward(L, a, o), q = outward(L, z, o);
  const back = [...q.pts].reverse();
  if (Math.abs(p.bus - q.bus) < 1) return [...p.pts, ...back];
  const tx = OC.TRUNK - 12 - o;
  return [...p.pts, { x: tx, y: p.bus }, { x: tx, y: q.bus }, ...back];
}
/** An orthogonal polyline as SVG path data, its corners rounded. */
export function pathOf(pts, r = 8) {
  const q = pts.filter((pt, i) => !i || pt.x !== pts[i - 1].x || pt.y !== pts[i - 1].y);
  let d = `M${q[0].x} ${q[0].y}`;
  for (let i = 1; i < q.length - 1; i++) {
    const a = q[i - 1], b = q[i], c = q[i + 1];
    const r1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const u = { x: Math.sign(a.x - b.x), y: Math.sign(a.y - b.y) }, v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) };
    d += ` L${b.x + u.x * r1} ${b.y + u.y * r1} Q${b.x} ${b.y} ${b.x + v.x * r1} ${b.y + v.y * r1}`;
  }
  const last = q[q.length - 1];
  return `${d} L${last.x} ${last.y}`;
}
/** Where a line's ×N goes: the middle of its longest straight run. */
export function badgeAt(pts) {
  let best = pts[0], len = -1;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (l > len) { len = l; best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 }; }
  }
  return best;
}

// ── Edges ──

/** The colour family of a kind: task, report, broadcast, and the rest (send, query, update). */
export const hue = (kind) => (kind === "task" || kind === "report" || kind === "broadcast" ? kind : "send");
// A message: queued, live, fading. The work: in progress (work), its report coming back (return), or no report (stale).
const phaseOf = (it) => it.phase || (it.fading ? "fading" : it.state === "queued" ? "queued" : "live");
const RANK = { live: 0, return: 0, work: 1, queued: 2, fading: 3, stale: 3 };
const settled = (phase) => (phase === "fading" || phase === "stale" ? "fading" : phase);

/**
 * The lines to draw from the store's items on layout `L`. `far`: zoomed out (one line per team pair). Each edge:
 * { key, hue, phase, n, from, to, d, pts, badge } — `from`/`to` the instance (or team) names it joins, for search.
 */
export function trafficEdges(items, L, { far = false, max = MAX_EDGES } = {}) {
  if (!L.boxes.length && L.tops.length < 2) return [];
  // A top's way out is the first row's bus: with no box there is none, so only top ↔ top lines (betweenTops) are drawn.
  const groups = new Map();
  const add = (key, g) => { const cur = groups.get(key); if (cur) { cur.n += g.n; cur.names.push(...g.names); } else groups.set(key, g); };
  const teamKey = (name) => { const t = teamOf(L, name); return t === null ? "\u0000general" : t ? t.key : undefined; };
  const teamEnd = (name) => { const t = teamOf(L, name); return t === null ? endOf(L, name) : t ? { kind: "box", b: t, key: `box:${t.key}` } : null; };
  // Broadcasts: one fan-out per op; big ones (or far) bundle per recipient team.
  const byOp = new Map();
  for (const it of items) if (it.kind === "broadcast" && it.op) { const l = byOp.get(it.op) || []; l.push(it); byOp.set(it.op, l); }
  const bundled = new Set();
  for (const list of byOp.values()) if (far || list.length > BUNDLE_AT) for (const it of list) bundled.add(it.id);
  for (const it of items) {
    const phase = phaseOf(it), names = [it.from, it.to];
    if (far || bundled.has(it.id)) {
      const ta = teamKey(it.from), tb = teamKey(it.to);
      if (ta === tb) continue;                                                     // inside one team: not drawn far away
      const k = far ? "team" : "broadcast";
      const a = far ? teamEnd(it.from) : endOf(L, it.from), z = teamEnd(it.to);
      if (!a || !z) continue;
      // Queued and live messages share a line far away (as before); the work keeps its own.
      const ph = settled(phase), lane = ph === "queued" ? "live" : ph;
      add(`${k}|${a.key}>${z.key}|${lane}`, { a, z, hue: k === "team" ? "team" : "broadcast", phase: ph, n: 1, names });
      continue;
    }
    const a = endOf(L, it.from), z = endOf(L, it.to);
    if (!a || !z || a.key === z.key) continue;                                     // both in one folded team
    add(`${a.key}>${z.key}|${hue(it.kind)}|${phase}`, { a, z, hue: hue(it.kind), phase, n: 1, names });
  }
  const list = [...groups.entries()].sort((x, y) => RANK[x[1].phase] - RANK[y[1].phase]).slice(0, max);
  return list.map(([key, g], i) => {
    const o = ((i % 7) - 3) * 7;                                                    // neighbours 7 px apart (within the ±22 px bus lane)
    const pts = route(L, g.a, g.z, o);
    return { key, hue: g.hue, phase: g.phase, n: g.n, names: [...new Set(g.names)], d: pathOf(pts), pts, badge: g.n > 1 ? badgeAt(pts) : null };
  });
}

/** For the list: what each instance is sending now, in words ("task → quill"), live messages only. */
export function sendingBy(items) {
  const out = new Map();
  for (const it of items) {
    if (it.fading || it.phase === "stale" || it.phase === "return") continue;
    const l = out.get(it.from) || [];
    const working = it.phase === "work";
    const key = `${it.kind}>${it.to}>${working ? "work" : it.state}`;
    if (!l.some((x) => x.key === key)) l.push({ key, kind: it.kind, to: it.to, queued: it.state === "queued", working });
    out.set(it.from, l);
  }
  return out;
}
