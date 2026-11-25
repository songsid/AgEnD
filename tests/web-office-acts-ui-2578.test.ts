/**
 * #2578, the page's side: what an agent does by its own hand (office_set) in a stored office (mounted: web-office-overview-2554).
 * - actsOk: the host's acts checked (GET /ui/office-acts, the `office_acts` event) — the well-formed ones, nothing else;
 *   each end moved onto the page's clock by the host's `now`.
 * - actLive: an act holds until its end, unless its person is called (a call wins) or asleep; with the page's `seen`
 *   memory, new work begun after it (working again after being seen otherwise, or after acting while idle) ends it.
 * - actTarget: an act's point; or beside the person it goes to, where they are now (else their seat); else none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let F: any, S: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  F = await import("/ui/js/fleet-office.js");
  S = await import("/ui/js/fleet-office-store.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const ACT = { instance: "atlas", office: "front", until: 10_000, since: 0, state: "working" };

describe("actsOk", () => {
  it("keeps the well-formed acts and only their known fields", () => {
    const ok = S.actsOk([{ ...ACT, x: 10, y: 20, say: "hi", pose: "working", extra: 1 }, { ...ACT, person: "quill" }]);
    expect(ok).toEqual([{ instance: "atlas", office: "front", until: 10_000, since: 0, state: "working", x: 10, y: 20, say: "hi", pose: "working" },
      { instance: "atlas", office: "front", until: 10_000, since: 0, state: "working", person: "quill" }]);
  });
  it("each end moved onto this page's clock: the host's `now` 5 s ahead → 5 s earlier here", () => {
    const host = Date.now() + 5_000;
    const [a] = S.actsOk([{ ...ACT, until: host + 30_000 }], host);
    expect(Math.round((a.until - Date.now()) / 1000)).toBe(30);
  });
  it("drops the malformed: no instance or office, no end, a bad point, too long a line, an unknown pose; not a list → none", () => {
    const bad = [{ ...ACT, instance: "" }, { ...ACT, office: 3 }, { ...ACT, until: "soon" }, { ...ACT, x: "1", y: 2 }, { ...ACT, say: "x".repeat(41) },
      { ...ACT, pose: "dance" }, null, "act"];
    expect(S.actsOk(bad)).toEqual([]);
    expect(S.actsOk(undefined)).toEqual([]);
  });
});

describe("actLive and actTarget", () => {
  it("live until its end, not while its person is called", () => {
    expect([F.actLive(ACT, "idle", 9_999), F.actLive(ACT, "idle", 10_000), F.actLive(ACT, "needs", 5_000), F.actLive(null, "idle", 0)]).toEqual([true, false, false, false]);
  });
  it("asleep ends it too; with `seen`: the turn it acted in keeps it, new work after that ends it", () => {
    expect(F.actLive(ACT, "paused", 1_000)).toBe(false);
    const seen = new Set<string>();
    expect(F.actLive(ACT, "working", 1_000, seen)).toBe(true);                // set while working: the same turn
    expect(F.actLive(ACT, "idle", 2_000, seen)).toBe(true);                   // the turn ended: still acting
    expect(F.actLive(ACT, "working", 3_000, seen)).toBe(false);               // working again: new work wins
    const whileIdle = { ...ACT, since: 1, state: "idle" };
    expect(F.actLive(whileIdle, "working", 1_000, new Set())).toBe(false);    // acted while idle, now working: new work
  });
  it("a ride (#4458): live until its end, through work; not while its person calls (#4415) or sleeps", () => {
    const RIDE = { ...ACT, ride: "loop" };
    expect([F.rideLive(RIDE, "idle", 9_999), F.rideLive(RIDE, "working", 5_000), F.rideLive(RIDE, "idle", 10_000)]).toEqual([true, true, false]);
    expect(["needs", "crashed", "stuck", "paused"].map((s) => F.rideLive(RIDE, s, 5_000))).toEqual([false, false, false, false]);
    expect(F.rideLive(ACT, "idle", 5_000)).toBe(false);                          // no ride in it
  });
  it("a point; beside a person where they are (walking or seated); none for a person not here", () => {
    const L = { width: 1280, rooms: [{ desks: [{ node: { name: "quill" }, seat: { x: 400, y: 300 } }] }] };
    expect(F.actTarget({ ...ACT, x: 5, y: 6 }, L, null, 0)).toEqual({ x: 5, y: 6 });
    expect(F.actTarget({ ...ACT, person: "quill" }, L, { at: () => null }, 0)).toEqual({ x: 448, y: 300 });
    expect(F.actTarget({ ...ACT, person: "quill" }, L, { at: () => ({ x: 1270, y: 200 }) }, 0)).toEqual({ x: 1280, y: 200 });   // kept in the room
    expect(F.actTarget({ ...ACT, person: "nobody" }, L, { at: () => null }, 0)).toBeNull();
  });
});
