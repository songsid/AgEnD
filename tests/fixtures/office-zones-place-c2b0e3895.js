// The release tip's (c2b0e3895) placeBubbles, verbatim from src/ui/fleet-office-zones.js: what a page still holding the older
// module runs (it knows no boxAt and no skin tail). tests/office-bubble-fit-retained-m3743.test.ts places with it (#4474 review).
export function placeBubbles(items, lift = 22, blocked = [], soft = [], air = 0) {
  if (air) soft = soft.map((b) => ({ x: b.x - air, y: b.y - air, w: b.w + 2 * air, h: b.h + 2 * air }));
  const rank = (it) => (it.rank ?? (it.calling ? 0 : 2));
  const order = [...items].sort((a, b) => (rank(a) - rank(b)) || (b.shown - a.shown) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = [...blocked], out = [];
  const hit = (list, r) => list.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);
  // M-3722: `flipBox` (the box on the tail's left) is a call's other side: tried before a call covers an area's name.
  const at = (it, dy, flip = false) => {
    const box = flip && it.flipBox ? it.flipBox : it.box;
    const r = { x: box.x, y: box.y + dy, w: box.w, h: box.h };
    return { r, t: it.tail ? { x: it.tail.x - 1, y: r.y + r.h, w: 9, h: Math.max(0, it.tail.y - (r.y + r.h)) } : null };
  };
  // M-3722: an area's name (`soft`) keeps a bubble's BOX off it; a tail may cross a name (the Office writes the name again
  // over it) — a caller standing at a name's height would otherwise always cover it.
  const free = (it, [dy, flip], names) => { const { r, t } = at(it, dy, flip); return !hit(taken, r) && !(t && hit(taken, t)) && !(names && hit(soft, r)); };
  const first = (it, spots, names) => spots.find((spot) => free(it, spot, names));
  const sides = (dys) => dys.map((dy) => [dy, false]);
  for (const it of order) {
    let spot = first(it, sides([0, -lift]), true);
    if (spot === undefined && it.calling) {
      spot = (it.flipBox ? first(it, [[0, true], [-lift, true]], true) : undefined)
        ?? first(it, [[-2 * lift, false], ...(it.flipBox ? [[-2 * lift, true]] : [])], true)
        ?? first(it, sides([0, -lift, -2 * lift]), false);                       // M-3648: a name never keeps a call out
    }
    if (spot === undefined) continue;
    const [dy, flip] = spot, { r, t } = at(it, dy, flip);
    taken.push(r); if (t) taken.push(t); out.push({ ...it, dy, ...(flip ? { flip: true } : {}) });
  }
  return out;
}
