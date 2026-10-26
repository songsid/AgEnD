/**
 * #2706: an office's Edit-layout overrides are kept beside the offices in web-offices.json, never in the office's entry.
 * 2.3.1 accepts only id/name/skin/members/layout in an entry: an `overrides` key there dropped the office on read, and
 * 2.3.1's next save deleted it. Now 2.3.1 keeps every office (without its layout).
 * - On disk: entries without `overrides`; beside them `overrides` by office id (without night places and seat
 *   reservations, which keep their own maps, #2665/#2691).
 * - Read: from beside the office, else from its entry (a file a beta before #2706 wrote); the next write moves them.
 * - Overrides that do not check leave the office in, without them (wherever they were).
 * The published 2.3.1 store itself is run against this in scripts/check-office-config-downgrade.mjs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeStore } from "../src/web-office-store.js";
import { checkSkinPack } from "../src/ui/fleet-office-pack.js";

const STRIP = (src: string) => ({ src, frames: 1, w: 16, h: 16 });
const PACK = (() => {
  const c = checkSkinPack({ format: 1, id: "snug", background: "bg.png",
    areas: { desks: { rect: [0, 0, 600, 720], seats: [[100, 100], [200, 100]] }, lounge: { rect: [640, 0, 640, 720], seats: [[700, 300], [800, 300]] } },
    stateZones: { working: "desks", idle: "lounge" }, characters: { default: { idle: STRIP("i.png") } },
    furniture: [{ id: "lamp", sprite: STRIP("l.png"), x: 300, y: 300 }, { id: "bed", sprite: STRIP("b.png"), x: 900, y: 600, night: { sprite: STRIP("n.png") } }] });
  if (!c.ok) throw new Error(c.error);
  return c.pack;
})();
const OV = { pack: "snug", door: [600, 710], seats: { lounge: [[720, 280], [820, 280]] }, furniture: { lamp: [310, 320] },
  furnitureNight: { bed: [880, 640] }, seatFor: { desks: { 0: { for: ["alpha"], lend: false } } } };
const LAID = { id: "laid", name: "Laid out", skin: "snug", members: ["team:core"], overrides: OV };
const PLAIN = { id: "plain", name: "Plain", skin: "studio", members: [] };
const { overrides: _o, ...LAID_BARE } = LAID;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const store = () => { const d = mkdtempSync(join(tmpdir(), "agend-ov-2706-")); dirs.push(d); return { d, s: new OfficeStore(d, (id) => (id === "snug" ? PACK : null)) }; };
const file = (d: string) => JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
const put = (d: string, doc: unknown) => writeFileSync(join(d, "web-offices.json"), JSON.stringify(doc));
/** 2.3.1's read (v2.3.1:src/web-office-store.ts): version/rev/offices, each entry's keys a closed list — else dropped. */
const read231 = (doc: any) => doc.offices.filter((o: any) => Object.keys(o).every((k) => ["id", "name", "skin", "members", "layout"].includes(k)));

describe("on disk", () => {
  it("every entry is one 2.3.1 keeps; the overrides, night places and reservations are beside the offices", () => {
    const { d, s } = store();
    expect(s.replace([LAID, PLAIN], 0).ok).toBe(true);
    const doc = file(d);
    expect(doc.offices).toEqual([LAID_BARE, PLAIN]);
    expect(read231(doc).map((o: any) => o.id)).toEqual(["laid", "plain"]);
    expect(doc.overrides).toEqual({ laid: { pack: "snug", door: [600, 710], seats: { lounge: [[720, 280], [820, 280]] }, furniture: { lamp: [310, 320] } } });
    expect(doc.furnitureNight).toEqual({ laid: OV.furnitureNight });
    expect(doc.seatFor).toEqual({ laid: OV.seatFor });
    expect(new OfficeStore(d).list().offices).toEqual([LAID, PLAIN]);           // read back whole
  });
  it("no office with overrides: no overrides key", () => {
    const { d, s } = store();
    expect(s.replace([PLAIN], 0).ok).toBe(true);
    expect(file(d)).toEqual({ version: 1, rev: 1, offices: [PLAIN] });
  });
  it("2.3.1's save (version/rev/offices only) leaves every office, without its layout", () => {
    const { d, s } = store();
    expect(s.replace([LAID, PLAIN], 0).ok).toBe(true);
    const doc = file(d);
    put(d, { version: 1, rev: doc.rev + 1, offices: read231(doc) });
    expect(new OfficeStore(d).list().offices).toEqual([LAID_BARE, PLAIN]);
  });
});

describe("a file a beta before #2706 wrote (overrides in the entry)", () => {
  const IN_ENTRY = { pack: "snug", door: [600, 710], seats: OV.seats, furniture: OV.furniture };
  const BETA = { version: 1, rev: 7, offices: [{ ...LAID, overrides: IN_ENTRY }, PLAIN],
    furnitureNight: { laid: OV.furnitureNight }, seatFor: { laid: OV.seatFor } };
  it("reads whole, and the next write moves the overrides beside the offices", () => {
    const { d, s } = store();
    put(d, BETA);
    expect(s.list()).toEqual({ rev: 7, offices: [LAID, PLAIN], readable: true });
    expect(s.replace(s.list().offices, 7).ok).toBe(true);
    const doc = file(d);
    expect(doc.offices).toEqual([LAID_BARE, PLAIN]);
    expect(doc.overrides.laid).toEqual(IN_ENTRY);
    expect(new OfficeStore(d).list().offices).toEqual([LAID, PLAIN]);
  });
  it("overrides in the entry that do not check: the office kept without them (it used to be dropped)", () => {
    const { d, s } = store();
    put(d, { ...BETA, offices: [{ ...LAID, overrides: { pack: "snug", door: [-1, 0] } }, PLAIN] });
    expect(s.list().offices).toEqual([LAID_BARE, PLAIN]);
  });
  it("both shapes (only by hand): the overrides beside the office win", () => {
    const { d, s } = store();
    put(d, { ...BETA, overrides: { laid: { pack: "snug", door: [10, 10] } }, furnitureNight: {}, seatFor: {} });
    expect(s.list().offices[0].overrides).toEqual({ pack: "snug", door: [10, 10] });
  });
});

describe("per part: a broken map drops only itself", () => {
  it("overrides beside the office that do not check: the office kept, without them (and so without its night places and reservations)", () => {
    const { d, s } = store();
    expect(s.replace([LAID, PLAIN], 0).ok).toBe(true);
    put(d, { ...file(d), overrides: { laid: { pack: "snug", seats: "no" } } });
    expect(new OfficeStore(d).list().offices).toEqual([LAID_BARE, PLAIN]);
  });
  it("an overrides map that is not an object, or names no office here: every office kept", () => {
    const { d, s } = store();
    expect(s.replace([LAID, PLAIN], 0).ok).toBe(true);
    put(d, { ...file(d), overrides: ["x"] });
    expect(new OfficeStore(d).list().offices).toEqual([LAID_BARE, PLAIN]);
    put(d, { ...file(d), overrides: { other: { pack: "snug" } } });
    expect(new OfficeStore(d).list().offices).toEqual([LAID_BARE, PLAIN]);
  });
  it("a broken reservation beside good overrides: the overrides and the night places stay", () => {
    const { d, s } = store();
    expect(s.replace([LAID], 0).ok).toBe(true);
    put(d, { ...file(d), seatFor: { laid: { desks: { 0: { for: "x" } } } } });
    const { seatFor: _s, ...rest } = OV;
    expect(new OfficeStore(d).list().offices).toEqual([{ ...LAID, overrides: rest }]);
  });
});
