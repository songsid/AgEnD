// #2554: the Office view's "All offices" — every stored office as a tile on one canvas, side by side, each drawn exactly
// as its own view would be (its style, its members, seats, poses, bubbles, walking), scaled into its tile. This module
// is the pure part (fleet-office.js draws it): who is in no office (the lobby tile), where the tiles go, what a point
// on the overview hits, which tiles are on screen, and the traffic that crosses between tiles.
//
// - Shown when at least two offices are stored (overviewOk); an id no stored office can have (ALL_ID: '*' is not an
//   office id's character), kept per device as any office pick is.
// - The tiles: each as large as its office's drawn content — a zones scene its 1280×720, a desks office its rooms'
//   bounds (cropToRooms: an office of three is small) — scaled down to at most CELL_W × CELL_H, never up; a LABEL band
//   above each (the page's label sits there), GAP apart, M from the edge. Shelf packing in the stored order (the lobby
//   last): a row takes tiles while they fit a row width, each row as tall as its tallest tile and centred across. The
//   row width: whichever (of the widths a run of tiles makes) lets the whole overview show largest in the panel (Fit's
//   contain); a tie keeps the narrower. The same input always gives the same picture.
// - Traffic between people in different tiles is a straight flight between their seats in overview coordinates
//   (createCrossFlights); between two people in the same tile it is that tile's own (createFlights, along its corridors).
import { FLIGHT, createTrips, desksOf, membersOf } from "./fleet-office-model.js";

/** The switcher's "All offices" value: '*' is never in a stored office's id (fleet-office-model.js officeOk). */
export const ALL_ID = "*all";
/** The lobby tile's key: never an office's id. */
export const LOBBY_TILE = "\u0000lobby";
/** The overview's geometry, in logical units. */
export const OV = { CELL_W: 1280, CELL_H: 720, LABEL: 56, GAP: 24, M: 24 };

/** Whether "All offices" is offered: at least two stored offices. */
export const overviewOk = (stored) => Array.isArray(stored) && stored.length >= 2;

/**
 * The people in no stored office, in the org chart's order (General, the teams, the rest): the lobby tile's. An office
 * with no members holds everyone (fleet-office-model.js membersOf), so then nobody is left for the lobby.
 */
export function lobbyNodes(stored, view) {
  const placed = new Set((stored || []).flatMap((o) => membersOf(o, view).map((n) => n.name)));
  const out = new Map();
  for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!placed.has(n.name) && !out.has(n.name)) out.set(n.name, n);
  return [...out.values()];
}

/** A scene's scale in its tile: its own size, scaled down to fit a CELL_W × CELL_H cell (never up). */
export const tileScale = (w, h) => Math.min(1, OV.CELL_W / Math.max(1, w), OV.CELL_H / Math.max(1, h));

/**
 * A desks layout cropped to its rooms: everything moved so the rooms' bounds start at (0, 0), its size theirs (the
 * corridors outside the rooms and the margins are not part of a tile). Unchanged when it has no rooms.
 */
export function cropToRooms(L) {
  if (!L.rooms.length) return L;
  const x0 = Math.min(...L.rooms.map((r) => r.x)), y0 = Math.min(...L.rooms.map((r) => r.y));
  const x1 = Math.max(...L.rooms.map((r) => r.x + r.w)), y1 = Math.max(...L.rooms.map((r) => r.y + r.h));
  const mv = (p) => ({ ...p, x: p.x - x0, y: p.y - y0 });
  return { ...L, rooms: L.rooms.map((r) => ({ ...mv(r), desks: r.desks.map((d) => ({ ...mv(d), seat: mv(d.seat) })) })), waypoints: (L.waypoints || []).map(mv),
    width: x1 - x0, height: y1 - y0 };
}

/**
 * The tiles of `scenes` ([{ key, w, h }], in order) on shelves at most `rowW` wide (a tile wider than that has a row of
 * its own): each { key, x, y, w, h, s (its scale), label: { x, y, w, h } (the band above it) }; and the overview's size.
 * Each row is centred across the widest; its tiles stand at its top, under their labels.
 */
export function arrangeTiles(scenes, rowW) {
  const { LABEL, GAP, M } = OV;
  const rows = [];
  let row = null;
  for (const sc of scenes) {
    const s = tileScale(sc.w, sc.h), it = { key: sc.key, s, w: Math.max(1, sc.w) * s, h: Math.max(1, sc.h) * s };
    if (!row || row.w + GAP + it.w > rowW + 1e-6) { row = { items: [], w: -GAP, h: 0 }; rows.push(row); }
    row.items.push(it); row.w += GAP + it.w; row.h = Math.max(row.h, it.h);
  }
  const inner = rows.length ? Math.max(...rows.map((r) => r.w)) : 0, tiles = [];
  let y = M;
  for (const r of rows) {
    let x = M + (inner - r.w) / 2;
    for (const it of r.items) {
      tiles.push({ key: it.key, x, y: y + LABEL, w: it.w, h: it.h, s: it.s, label: { x, y, w: it.w, h: LABEL } });
      x += it.w + GAP;
    }
    y += LABEL + r.h + GAP;
  }
  return { rows: rows.length, rowW, tiles, width: 2 * M + inner, height: rows.length ? y - GAP + M : 2 * M };
}

/**
 * The tiles packed for a `size` panel: of the row widths a run of consecutive tiles makes, the one whose overview shows
 * largest there (min of the two fits); a tie keeps the narrower.
 */
export function tileLayout(scenes, size) {
  const ws = scenes.map((sc) => Math.max(1, sc.w) * tileScale(sc.w, sc.h)), cands = new Set();
  for (let i = 0; i < ws.length; i++) { let run = -OV.GAP; for (let j = i; j < ws.length; j++) { run += OV.GAP + ws[j]; cands.add(run); } }
  let best = arrangeTiles(scenes, 0), bestK = -1;
  for (const rowW of [...cands].sort((a, b) => a - b)) {
    const a = arrangeTiles(scenes, rowW), k = Math.min(size.w / a.width, size.h / a.height);
    if (k > bestK + 1e-9) { best = a; bestK = k; }
  }
  return best;
}

/** The tile whose scene holds the overview point (x, y), or null. */
export const tileAt = (lay, x, y) => lay.tiles.find((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) || null;
/** The tile whose label band holds the overview point, or null. */
export const labelAt = (lay, x, y) => lay.tiles.find((t) => x >= t.label.x && x < t.label.x + t.label.w && y >= t.label.y && y < t.label.y + t.label.h) || null;
/** Overview → the tile's own scene units, and back; a box in the scene → the overview. */
export const inTile = (t, x, y) => ({ x: (x - t.x) / t.s, y: (y - t.y) / t.s });
export const fromTile = (t, p) => ({ x: t.x + p.x * t.s, y: t.y + p.y * t.s });
export const tileBox = (t, b) => ({ x: t.x + b.x * t.s, y: t.y + b.y * t.s, w: b.w * t.s, h: b.h * t.s });
/** The tiles a view ({ k, x, y }) shows any of in a `size` viewport: the rest are not drawn. */
export function visibleTiles(lay, v, size) {
  return lay.tiles.filter((t) => {
    const x = v.x + t.x * v.k, y = v.y + t.y * v.k;
    return x < size.w && x + t.w * v.k > 0 && y < size.h && y + t.h * v.k > 0;
  });
}

/**
 * A straight flight between two people in different tiles: [the sender's seat, the receiver's] in overview units (the
 * first tile each is in), or null — when either is drawn nowhere, or some tile holds both (that tile carries it along
 * its corridors). `parts`: [{ tile, L }] in the tiles' order.
 */
export function crossPath(parts, from, to) {
  let a = null, z = null;
  for (const p of parts) {
    const ds = desksOf(p.L), da = ds.find((d) => d.node.name === from), dz = ds.find((d) => d.node.name === to);
    if (da && dz) return null;
    if (da && !a) a = fromTile(p.tile, da.seat);
    if (dz && !z) z = fromTile(p.tile, dz.seat);
  }
  return a && z ? [a, z] : null;
}

/**
 * The items in the air between tiles — fleet-office-model.js createTrips (each new item once; none for a stale delegation
 * or with reduced motion; at most `max` at once, newest first, of those with a crossing), on crossPath's straight line:
 * `frame(now, parts)` → { id, hue, kind, from, x, y, t } in overview units; one with no crossing (both in one tile, or
 * either gone) is not this one's.
 */
export const createCrossFlights = ({ max = FLIGHT.MAX } = {}) => createTrips((parts, from, to) => (parts ? crossPath(parts, from, to) : null), { max });
