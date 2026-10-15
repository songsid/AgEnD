/**
 * #1629 r4 §3: the owner-CSS store on its own — per person, five versions kept (and never the one a trial goes back
 * to), keep-or-revert decided on the host's clock (a clock that went back counts as expired), assets checked, stripped,
 * capped and never removed while a kept version names them.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_CSS_KEEP_MS, OWNER_CSS_MAX_ASSETS, OwnerCssStore } from "../src/web-owner-css-store.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function store() {
  const dir = mkdtempSync(join(tmpdir(), "agend-oc-store-")); dirs.push(dir);
  const pointers = new Map<string, string | null>();
  let now = 1_000_000;
  const s = new OwnerCssStore(dir, {
    ownerCssActive: (p) => pointers.get(p) ?? null,
    setOwnerCssActive: (p, sha) => { pointers.set(p, sha); return { ok: true }; },
  }, () => now);
  return { s, dir, pointers, tick: (ms: number) => { now += ms; }, setNow: (t: number) => { now = t; } };
}
const keepSaved = (s: OwnerCssStore, person: string, text: string) => {
  const r = s.save(person, text);
  if (!r.ok) throw new Error(r.error);
  expect(s.keep(person, r.sha).ok).toBe(true);
  return r.sha;
};
const png = (n: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 0x49, 0x44, 0x41, 0x54, n, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);

describe("versions", () => {
  it("five kept, newest first; the sixth drops the oldest file", () => {
    const { s, dir } = store();
    const shas = [1, 2, 3, 4, 5, 6].map(n => keepSaved(s, "p", `.v${n}{}`));
    const st = s.state("p");
    expect(st.versions.map(v => v.sha)).toEqual(shas.slice(1).reverse());
    expect(st.active).toBe(shas[5]);
    const files = readdirSync(join(dir, "web-owner-css", readdirSync(join(dir, "web-owner-css"))[0]!)).filter(f => f.endsWith(".css"));
    expect(files.length).toBe(5);
  });
  it("the version a trial goes back to is kept even when it is older than five", () => {
    const { s } = store();
    const first = keepSaved(s, "p", ".v1{}");
    // Five newer versions saved and kept, each time going back to the first: it is in force, and the oldest kept.
    for (const n of [2, 3, 4, 5, 6]) { keepSaved(s, "p", `.v${n}{}`); s.restore("p", first); }
    const trial = s.save("p", ".v7{}");
    if (!trial.ok) throw new Error(trial.error);
    expect(trial.previous).toBe(first);
    expect(s.state("p").versions.map(v => v.sha)).toContain(first);
  });
  it("each person has their own: B never sees A's versions, A's sha is nothing to B", () => {
    const { s } = store();
    const a = keepSaved(s, "person:discord:1", ".a{}");
    expect([s.state("person:discord:2").versions, s.served("person:discord:2", a), s.served("person:discord:1", a)]).toEqual([[], null, ".a{}"]);
  });
});

describe("keep or revert, on the host's clock", () => {
  it("unkept past the deadline → back to the version before; kept in time → stays; keep after → 409", () => {
    const { s, tick } = store();
    const one = keepSaved(s, "p", ".one{}");
    const two = s.save("p", ".two{}");
    if (!two.ok) throw new Error(two.error);
    tick(OWNER_CSS_KEEP_MS - 1);
    expect(s.state("p").active, "still on trial").toBe(two.sha);
    tick(2);
    expect([s.state("p").active, s.state("p").pending]).toEqual([one, null]);
    expect(s.keep("p", two.sha)).toMatchObject({ ok: false, status: 409, error: "not_on_trial" });
  });
  it("a clock that went back past the save counts as expired", () => {
    const { s, setNow } = store();
    const one = keepSaved(s, "p", ".one{}");
    s.save("p", ".two{}");
    setNow(10);
    expect(s.active("p")).toBe(one);
  });
  it("a trial on a trial goes back to what was in force before the first", () => {
    const { s, tick } = store();
    const one = keepSaved(s, "p", ".one{}");
    s.save("p", ".two{}");
    const three = s.save("p", ".three{}");
    if (!three.ok) throw new Error(three.error);
    expect(three.previous).toBe(one);
    tick(OWNER_CSS_KEEP_MS + 1);
    expect(s.active("p")).toBe(one);
  });
  it("restore ends a trial; turning off (null) leaves none in force", () => {
    const { s, tick } = store();
    const one = keepSaved(s, "p", ".one{}");
    s.save("p", ".two{}");
    expect(s.restore("p", null)).toMatchObject({ ok: true, active: null });
    tick(OWNER_CSS_KEEP_MS + 1);
    expect([s.active("p"), s.state("p").pending]).toEqual([null, null]);
    expect(s.restore("p", one)).toMatchObject({ ok: true, active: one });
    expect(s.restore("p", "f".repeat(32))).toMatchObject({ ok: false, status: 404 });
  });
});

describe("assets", () => {
  it("16 at most; the same bytes twice are one; a picture a kept version names cannot be removed", () => {
    const { s } = store();
    const ids = Array.from({ length: OWNER_CSS_MAX_ASSETS }, (_v, n) => { const r = s.addAsset("p", png(n)); if (!r.ok) throw new Error(r.error); return r.id; });
    expect(new Set(ids).size).toBe(OWNER_CSS_MAX_ASSETS);
    expect(s.addAsset("p", png(0))).toMatchObject({ ok: true, id: ids[0] });
    expect(s.addAsset("p", png(99))).toMatchObject({ ok: false, status: 409, error: "asset_quota" });
    keepSaved(s, "p", `a{background:url("asset:${ids[0]}")}`);
    expect(s.removeAsset("p", ids[0]!)).toMatchObject({ ok: false, status: 409, error: "asset_in_use" });
    expect(s.removeAsset("p", ids[1]!)).toMatchObject({ ok: true });
  });
  it("a CSS naming an asset this person does not have is refused", () => {
    const { s } = store();
    expect(s.save("p", `a{background:url("asset:${"a".repeat(32)}")}`)).toMatchObject({ ok: false, error: "unknown_asset" });
  });
});
