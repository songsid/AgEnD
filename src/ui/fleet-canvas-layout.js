// #1918: the org canvas's layout (fleet-canvas.js draws it; fleet-traffic.js routes lines through its empty lanes).
// Fixed slots, no layout engine: the same structure always gives the same picture.

/**
 * Sizes in canvas units. NW×NH a member card, LW×LH a General card; FOLDED a folded (or empty) team's height. GAP and
 * PAD (#2182): the gutters between cards and a box's padding are the traffic lines' channels inside a box — wide
 * enough that the router (fleet-route-scene.js) keeps a few lines apart in each; a phone's narrow packing keeps the
 * tighter GAP_NARROW and PAD_NARROW, so General and the first team still open at a readable size. A layout says which
 * it used (L.gap, L.pad).
 */
export const OC = { NW: 184, NH: 56, GAP: 28, PAD: 32, GAP_NARROW: 18, PAD_NARROW: 24, HEAD: 34, TEAM_GAP: 72, ROW_GAP: 96, ROW_MAX: 1400, ROW_MAX_NARROW: 460, LW: 232, LH: 68, TOP_Y: 20, BUS: 44, FOLDED: 64, TRUNK: -30 };
const colsFor = (n, narrow) => (n <= 1 ? 1 : n <= 4 || narrow ? 2 : 3);
/** The key a team folds by (per device): its name; the instances in no team have one of their own no team name can be. */
export const REST_KEY = "\u0000rest";

/**
 * Where everything goes, from buildOrgView's answer and the folded teams' keys: `tops` (General's cards), `boxes`
 * (each team: its slot, its header, its member cells unless folded), the tree lines (`tree`: SVG path data) and the
 * size of the whole. `narrow`: a phone's packing.
 */
export function canvasLayout(view, folded = new Set(), { narrow = false, label = (s, n) => `${n} ${s}` } = {}) {
  const { NW, NH, HEAD } = OC, GAP = narrow ? OC.GAP_NARROW : OC.GAP, PAD = narrow ? OC.PAD_NARROW : OC.PAD;
  const groups = [...view.teams.map((tm) => ({ key: tm.name, name: tm.name, loose: false, nodes: tm.nodes, counts: tm.counts })),
    ...(view.rest.nodes.length ? [{ key: REST_KEY, name: null, loose: true, nodes: view.rest.nodes, counts: view.rest.counts }] : [])];
  const rows = [];
  let row = [], x = 0;
  for (const g of groups) {
    const n = g.nodes.length, cols = colsFor(n, narrow), lines = Math.ceil(n / cols);
    const w = PAD * 2 + cols * NW + (cols - 1) * GAP;
    const fullH = n ? HEAD + PAD + lines * NH + (lines - 1) * GAP + PAD : OC.FOLDED;
    if (row.length && x + w > (narrow ? OC.ROW_MAX_NARROW : OC.ROW_MAX)) { rows.push(row); row = []; x = 0; }
    row.push({ ...g, cols, w, fullH, x });
    x += w + OC.TEAM_GAP;
  }
  if (row.length) rows.push(row);
  const boxes = [];
  let y = view.top.length ? OC.TOP_Y + OC.LH + 100 : OC.BUS + 16;
  for (const r of rows) {
    const slotH = Math.max(...r.map((b) => b.fullH));
    for (const b of r) {
      const isFolded = b.nodes.length > 0 && folded.has(b.key);
      // Folded: its members' states in rows that fit the box (never wider; never taller than its open slot).
      const summary = isFolded ? summaryRows(b.counts, b.w, label) : [];
      const box = { key: b.key, name: b.name, loose: b.loose, nodes: b.nodes, counts: b.counts, cols: b.cols, x: b.x, y, w: b.w,
        h: isFolded ? Math.min(b.fullH, Math.max(OC.FOLDED, HEAD + 10 + summary.length * SUM_LINE)) : b.fullH, slotH, folded: isFolded, summary,
        busY: y - OC.BUS, cells: [] };
      if (!isFolded) b.nodes.forEach((node, i) => box.cells.push({ node, key: `${b.key}/${node.name}`,
        x: b.x + PAD + (i % b.cols) * (NW + GAP), y: y + HEAD + PAD + Math.floor(i / b.cols) * (NH + GAP), w: NW, h: NH }));
      boxes.push(box);
    }
    y += slotH + OC.ROW_GAP;
  }
  const rowsW = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : 0;
  const topW = view.top.length * OC.LW + Math.max(0, view.top.length - 1) * GAP;
  const width = Math.max(rowsW, topW);
  const tops = view.top.map((node, i) => ({ node, key: `\u0000top/${node.name}`, x: width / 2 - topW / 2 + i * (OC.LW + GAP), y: OC.TOP_Y, w: OC.LW, h: OC.LH }));
  const height = boxes.length ? y - OC.ROW_GAP : tops.length ? OC.TOP_Y + OC.LH : 0;
  return { tops, boxes, width, height, tree: treeLines(tops, boxes), gap: GAP, pad: PAD };
}

/** A folded team's summary line height, and a label's width estimate (canvas units: wide for CJK, narrow otherwise). */
export const SUM_LINE = 20;
const textWidth = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x2e80 ? 12 : 6.6), 0);
/**
 * A folded team's states as rows of { s, n, label, dx } that fit a box `w` wide (dx from the box's left), most pressing
 * first; an item never splits, and one wider than a row has the row to itself.
 */
export function summaryRows(counts, w, label) {
  const rows = [];
  let row = [], x = 14;
  for (const [s, n] of counts) {
    const text = label(s, n), iw = 24 + textWidth(text);
    if (row.length && x + iw > w - 14) { rows.push(row); row = []; x = 14; }
    row.push({ s, n, label: text, dx: x });
    x += iw;
  }
  if (row.length) rows.push(row);
  return rows;
}

/** General's stem, a bus over each row of teams, the trunk joining the rows at the left, one drop per team. */
function treeLines(tops, boxes) {
  const d = [];
  const teamed = boxes.filter((b) => !b.loose);
  if (!teamed.length) return d;
  const buses = [...new Set(teamed.map((b) => b.busY))].sort((a, b) => a - b);
  const first = buses[0], last = buses[buses.length - 1];
  let stemX = null;
  if (tops.length) {
    const cx = tops.map((tp) => tp.x + tp.w / 2), bottom = tops[0].y + tops[0].h;
    stemX = (Math.min(...cx) + Math.max(...cx)) / 2;
    if (tops.length > 1) {
      const joinY = bottom + 16;
      for (const x of cx) d.push(`M${x} ${bottom} V${joinY}`);
      d.push(`M${Math.min(...cx)} ${joinY} H${Math.max(...cx)}`, `M${stemX} ${joinY} V${first}`);
    } else d.push(`M${stemX} ${bottom} V${first}`);
  }
  if (last > first) d.push(`M${OC.TRUNK} ${first} V${last}`);
  for (const busY of buses) {
    const xs = teamed.filter((b) => b.busY === busY).map((b) => b.x + b.w / 2);
    const ends = busY === first ? [...xs, ...(stemX === null ? [] : [stemX]), ...(last > first ? [OC.TRUNK] : [])] : [...xs, OC.TRUNK];
    d.push(`M${Math.min(...ends)} ${busY} H${Math.max(...ends)}`);
  }
  for (const b of teamed) d.push(`M${b.x + b.w / 2} ${b.busY} V${b.y}`);
  return d;
}

/** The region the canvas opens on: General and the first row of teams (the whole canvas when there is neither). */
export function openingRegion(L) {
  const firstBus = L.boxes.length ? Math.min(...L.boxes.map((b) => b.busY)) : null;
  // The trunk at the left joins the rows: in view too, not cut by the edge.
  const trunk = L.boxes.some((b) => b.busY !== firstBus) ? [{ x: OC.TRUNK - 8, y: firstBus, w: 1, h: 1 }] : [];
  const parts = [...L.tops, ...L.boxes.filter((b) => b.busY === firstBus).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.slotH })), ...trunk];
  if (!parts.length) return { x: 0, y: 0, w: Math.max(1, L.width), h: Math.max(1, L.height) };
  const x0 = Math.min(...parts.map((p) => p.x)), y0 = Math.min(...parts.map((p) => p.y));
  return { x: x0, y: y0, w: Math.max(...parts.map((p) => p.x + p.w)) - x0, h: Math.max(...parts.map((p) => p.y + p.h)) - y0 };
}
