import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkEffectEntry } from "../src/web-effect-bundle.js";
import { WebEffectLibrary, type EffectPrincipal } from "../src/web-effect-library.js";
vi.mock("node:child_process", () => { const denied = () => { throw Error("process launch forbidden"); }; return { spawn: denied, spawnSync: denied, exec: denied, execSync: denied, execFile: denied, execFileSync: denied }; });
const A: EffectPrincipal = { kind: "agent", id: "agent-a" }, B: EffectPrincipal = { kind: "agent", id: "agent-b" }, H: EffectPrincipal = { kind: "human", id: "person-a" }, P: EffectPrincipal = { kind: "human", id: "person-b" };
const M1 = "mod:" + "1".repeat(32), M2 = "mod:" + "2".repeat(32);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0))
  rmSync(root, { recursive: true, force: true }); });
function fixture(options: ConstructorParameters<typeof WebEffectLibrary>[1] = {}, parent = join(process.cwd(), ".artifacts")) {
  mkdirSync(parent, {recursive:true});
  const dir = mkdtempSync(join(parent, "library-test-"));
  roots.push(dir);
  return { dir, lib: new WebEffectLibrary(dir, options) };
}
function files(code = "agend.ready()") { return new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: [] }))], ["worker.js", Buffer.from(code)]]); }
function stage(lib: WebEffectLibrary, principal = A, code = "agend.ready()", holder?: string) {
  const value = lib.stage(files(code), principal, holder ? { holder } : {});
  expect(value.ok).toBe(true);
  if (!value.ok)
    throw Error(value.error);
  return value;
}
function upload(lib: WebEffectLibrary, principal = A, code = "agend.ready()", holder?: string) {
  const s = stage(lib, principal, code, holder), c = lib.commit(s.stageId);
  expect(c.ok).toBe(true);
  if (!c.ok)
    throw Error(c.error);
  return c;
}
function visible(lib: WebEffectLibrary, principal: EffectPrincipal) { const value = lib.list(principal); expect(value.ok).toBe(true); if (!value.ok)
  throw Error(value.error); return value.entries.map(e => e.id); }
function disk(dir: string) { return JSON.parse(readFileSync(join(dir, "web-effects.json"), "utf8")); }
describe("#1629 scoped CW1 library", () => {
  it("does no constructor/stage writes, then publishes complete blobs before the index", () => {
    let checked = false;
    const { dir, lib } = fixture({ beforeIndexRename: () => { const files = diskTempExpected!; expect(existsSync(join(dir, "web-effects", files, "worker.js"))).toBe(true); checked = true; } });
    let diskTempExpected: string | undefined;
    expect(existsSync(lib.path)).toBe(false);
    const s = stage(lib);
    diskTempExpected = s.ids[0];
    expect(existsSync(join(dir, "web-effects"))).toBe(false);
    expect(lib.commit(s.stageId).ok).toBe(true);
    expect(checked).toBe(true);
    expect(statSync(lib.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "web-effects", s.ids[0], "worker.js")).mode & 0o777).toBe(0o600);
  });
  it("lists only own claims plus human-shared entries, including after reopening", () => {
    const { dir, lib } = fixture(), a = upload(lib).ids[0], h = upload(lib, H, "// human\nagend.ready()").ids[0];
    expect(visible(lib, B)).toEqual([]);
    expect(lib.read(a, B)).toEqual({ ok: false, error: "not_found" });
    expect(lib.setShared(a, A, true).ok).toBe(false);
    expect(lib.setShared(h, H, true)).toEqual({ ok: true });
    expect(visible(new WebEffectLibrary(dir), B)).toEqual([h]);
    expect(visible(lib, A)).toEqual([a, h]);
  });
  it("deduplicates bytes without sharing an agent's claim", () => {
    const { dir, lib } = fixture(), a = upload(lib), b = upload(lib, B);
    expect(a.ids).toEqual(b.ids);
    expect(a.created).toEqual(a.ids);
    expect(b.created).toEqual(a.ids);
    const id = a.ids[0];
    expect(Object.keys(disk(dir).entries)).toEqual([id]);
    expect(disk(dir).entries[id].claims).toHaveLength(2);
    expect(lib.deleteClaim(id, A).ok).toBe(true);
    expect(lib.read(id, A).ok).toBe(false);
    expect(lib.read(id, B).ok).toBe(true);
  });
  it("does not turn an agent re-upload into sharing", () => {
    const { lib } = fixture(), first = upload(lib, H);
    lib.setShared(first.ids[0], H, true);
    upload(lib, A);
    lib.setShared(first.ids[0], H, false);
    expect(lib.read(first.ids[0], B).ok).toBe(false);
    expect(lib.read(first.ids[0], A).ok).toBe(true);
  });
  it("keeps order across a multi-entry stage, with stable duplicate ids", () => {
    const { lib } = fixture(), first = files(), second = files("// second\nagend.ready()");
    const s = lib.stage([first, second, first], A);
    expect(s.ok).toBe(true);
    if (!s.ok)
      return;
    expect(s.ids[0]).toBe(s.ids[2]);
    expect(s.ids[1]).not.toBe(s.ids[0]);
    const c = lib.commit(s.stageId);
    expect(c.ok && c.ids).toEqual(s.ids);
    expect(c.ok && c.created).toHaveLength(2);
  });
  it("rejects the whole stage if any entry fails", () => { const { lib } = fixture(); const bad = files(); bad.set("extra.html", Buffer.from("x")); expect(lib.stage([files(), bad], A).ok).toBe(false); expect(visible(lib, A)).toEqual([]); });
  it("copies source and display metadata; later mutations cannot change the claim", () => {
    const { lib } = fixture(), source = files();
    const s = lib.stage(source, A);
    expect(s.ok).toBe(true);
    if (!s.ok)
      return;
    source.get("worker.js")!.fill(0);
    s.entries[0].manifest.title = "Changed";
    const c = lib.commit(s.stageId);
    expect(c.ok).toBe(true);
    const r = lib.read(s.ids[0], A);
    expect(r.ok).toBe(true);
    if (!r.ok)
      return;
    expect(Buffer.from(r.entry.files.get("worker.js")!).toString()).toBe("agend.ready()");
    expect(r.entry.manifest.title).toBe("Fixture");
  });
  it("expires stages at ten monotonic minutes, unaffected by a wall-clock jump", () => {
    let mono = 0, wall = 1;
    const { lib } = fixture({ monotonic: () => mono, now: () => wall });
    const s = stage(lib);
    wall += 1e10;
    mono = 599999;
    expect(lib.commit(s.stageId).ok).toBe(true);
    const expired = stage(lib, A, "// expired");
    mono += 600000;
    expect(lib.commit(expired.stageId)).toEqual({ ok: false, error: "unknown_stage" });
  });
  it("forgets aborted stages and every stage on restart", () => { const { dir, lib } = fixture(), a = stage(lib), b = stage(lib); lib.abort(a.stageId); expect(lib.commit(a.stageId)).toEqual({ ok: false, error: "unknown_stage" }); expect(new WebEffectLibrary(dir).commit(b.stageId)).toEqual({ ok: false, error: "unknown_stage" }); });
  it("enforces ten unique uploads per principal without charging duplicate holders", () => {
    const { lib } = fixture();
    for (let i = 0; i < 10; i++)
      upload(lib, A, `// ${i}`);
    expect(lib.stage(files("// eleventh"), A)).toEqual({ ok: false, error: "effect_quota" });
    expect(lib.stage(files("// 0"), A, { holder: M1 }).ok).toBe(true);
    expect(lib.stage(files("// other"), B).ok).toBe(true);
  });
  it("enforces the eight-MiB principal byte quota below the file-count cap", () => {
    const { lib } = fixture();
    for (let i = 0; i < 9; i++)
      upload(lib, A, "//" + String(i) + "x".repeat(900000));
    expect(lib.stage(files("// extra" + "x".repeat(900000)), A)).toEqual({ ok: false, error: "effect_quota" });
  });
  it("checks the current quota again at commit", () => {
    const { lib } = fixture();
    const held = stage(lib, A, "// held");
    for (let i = 0; i < 10; i++)
      upload(lib, A, `// ${i}`);
    expect(lib.commit(held.stageId)).toEqual({ ok: false, error: "effect_quota" });
  });
  it("bounds stages per principal and globally", () => {
    const { lib } = fixture();
    for (let i = 0; i < 4; i++)
      stage(lib);
    expect(lib.stage(files(), A)).toEqual({ ok: false, error: "stage_full" });
    for (let p = 0; p < 15; p++)
      for (let i = 0; i < 4; i++)
        stage(lib, { kind: "agent", id: "p" + p });
    expect(lib.stage(files(), B)).toEqual({ ok: false, error: "stage_full" });
  });
  it("distinguishes an unreadable index from absence, never overwriting corruption", () => {
    const { dir, lib } = fixture();
    const bad = "{broken";
    writeFileSync(lib.path, bad);
    expect(lib.stage(files(), A)).toEqual({ ok: false, error: "library_unreadable" });
    expect(readFileSync(lib.path, "utf8")).toBe(bad);
    expect(existsSync(join(dir, "web-effects"))).toBe(false);
  });
  it("rejects a changed/corrupt full hash instead of overwriting a prefix id", () => {
    const { lib, dir } = fixture(), c = upload(lib), doc = disk(dir), id = c.ids[0];
    doc.entries[id].sha256 = id + "0".repeat(32);
    writeFileSync(lib.path, JSON.stringify(doc));
    expect(lib.read(id, A).ok).toBe(false);
    const s = stage(lib);
    expect(lib.commit(s.stageId)).toEqual({ ok: false, error: "hash_conflict" });
  });
  it("refuses corrupted blob bytes on reads and later uploads", () => {
    const { dir, lib } = fixture(), c = upload(lib), id = c.ids[0];
    writeFileSync(join(dir, "web-effects", id, "worker.js"), "// changed");
    expect(lib.read(id, A)).toEqual({ ok: false, error: "not_found" });
    expect(lib.commit(stage(lib).stageId).ok).toBe(false);
  });
  it("retains complete unclaimed blobs on index failure, without read or quota authority, and allows retry", () => {
    let broken = true;
    const { dir, lib } = fixture({ beforeIndexRename: () => { if (broken)
        throw Error("injected"); } });
    const s = stage(lib);
    expect(lib.commit(s.stageId).ok).toBe(false);
    expect(existsSync(lib.path)).toBe(false);
    expect(lib.read(s.ids[0], A).ok).toBe(false);
    expect(existsSync(join(dir, "web-effects", s.ids[0], "worker.js"))).toBe(true);
    broken = false;
    expect(lib.commit(s.stageId).ok).toBe(true);
  });
  it("does not lose a second store's sequential write", () => {
    const { dir, lib } = fixture(), second = new WebEffectLibrary(dir);
    const a = stage(lib), b = upload(second, B, "// b");
    expect(lib.commit(a.stageId).ok).toBe(true);
    expect(visible(second, B)).toEqual(b.ids);
  });
  it("detects index changes immediately before rename", () => {
    let tamper = false;
    const { lib } = fixture({ beforeIndexRename: () => { if (tamper)
        writeFileSync(lib.path, JSON.stringify({ version: 1, rev: 77, entries: {} })); } });
    upload(lib);
    const s = stage(lib, A, "// second");
    tamper = true;
    expect(lib.commit(s.stageId)).toEqual({ ok: false, error: "library_changed" });
    expect(JSON.parse(readFileSync(lib.path, "utf8")).rev).toBe(77);
  });
});
describe("#1629 mod-holder retention and undo", () => {
  it("reports created only for newly owned ids and releases only its mod holder", () => {
    const { lib } = fixture();
    const direct = upload(lib, H);
    const mod = upload(lib, H, "agend.ready()", M1);
    expect(mod.created).toEqual([]);
    expect(lib.releaseHolder(M1, H).ok).toBe(true);
    expect(lib.read(direct.ids[0], H).ok).toBe(true);
  });
  it("keeps a later direct upload after uninstalling the creating mod", () => {
    const { lib } = fixture(), mod = upload(lib, H, "agend.ready()", M1);
    upload(lib, H);
    expect(lib.releaseHolder(M1, H).ok).toBe(true);
    expect(lib.read(mod.ids[0], H).ok).toBe(true);
  });
  it("does not need custody handoffs between two mods or principals", async () => {
    const { lib, dir } = fixture(), first = upload(lib, H, "agend.ready()", M1), second = upload(lib, P, "agend.ready()", M2), id = first.ids[0];
    expect(second.ids).toEqual(first.ids);
    const refs = [{ id, holder: M1 }, { id, holder: M2 }];
    lib.registerReferenceSource("mods", () => refs);
    expect(lib.releaseHolder(M1, H).ok).toBe(true);
    refs.splice(0, 1);
    await Promise.resolve();
    expect(lib.read(id, H).ok).toBe(false);
    expect(lib.read(id, P).ok).toBe(true);
    expect(existsSync(join(dir, "web-effects", id))).toBe(true);
    expect(lib.releaseHolder(M2, P).ok).toBe(true);
    refs.length = 0;
    await Promise.resolve();
    expect(existsSync(join(dir, "web-effects", id))).toBe(false);
  });
  it("blocks normal delete while a stage or reference holds the id", () => {
    const { lib } = fixture(), c = upload(lib), s = stage(lib);
    expect(lib.deleteClaim(c.ids[0], A)).toEqual({ ok: false, error: "effect_in_use" });
    lib.abort(s.stageId);
    const detach = lib.registerReferenceSource("instances", () => [{ id: c.ids[0], holder: "instance:a" }]);
    expect(lib.deleteClaim(c.ids[0], A)).toEqual({ ok: false, error: "effect_in_use" });
    detach();
    expect(lib.deleteClaim(c.ids[0], A).ok).toBe(true);
  });
  it("requires the exact reference pair; mentioning an id/holder grants nothing", () => {
    const { lib } = fixture(), c = upload(lib);
    expect(lib.readReferenced(c.ids[0], M1).ok).toBe(false);
    lib.registerReferenceSource("mods", () => [{ id: c.ids[0], holder: M2 }]);
    expect(lib.readReferenced(c.ids[0], M1).ok).toBe(false);
    expect(lib.readReferenced(c.ids[0], M2).ok).toBe(true);
  });
  it("a provider failure refuses delete and mod release without any write", () => {
    const { lib } = fixture(), c = upload(lib, H, "agend.ready()", M1);
    upload(lib, H);
    const before = readFileSync(lib.path);
    lib.registerReferenceSource("broken", () => { throw Error("unreadable"); });
    expect(lib.releaseHolder(M1, H)).toEqual({ ok: false, error: "references_unreadable" });
    expect(lib.deleteClaim(c.ids[0], H)).toEqual({ ok: false, error: "references_unreadable" });
    expect(readFileSync(lib.path)).toEqual(before);
  });
  it("undo restores only this synchronous commit's claim effects and keeps preexisting uploads", () => {
    const { lib } = fixture(), first = upload(lib, H);
    const c = upload(lib, A);
    expect(c.undo()).toBe(true);
    expect(c.undo()).toBe(false);
    expect(lib.read(first.ids[0], H).ok).toBe(true);
    expect(lib.read(first.ids[0], A).ok).toBe(false);
  });
  it("restores a released mod holder on synchronous transaction rollback", () => {
    const { lib } = fixture(), c = upload(lib, H, "agend.ready()", M1);
    const r = lib.releaseHolder(M1, H);
    expect(r.ok).toBe(true);
    if (!r.ok)
      return;
    expect(r.released).toEqual(c.ids);
    expect(lib.read(c.ids[0], H).ok).toBe(false);
    expect(r.undo()).toBe(true);
    expect(lib.read(c.ids[0], H).ok).toBe(true);
  });
  it("refuses undo after an intervening index write or a new reference", () => {
    const { lib } = fixture(), first = upload(lib);
    upload(lib, B, "// other");
    expect(first.undo()).toBe(false);
    const second = upload(lib, A, "// second");
    lib.registerReferenceSource("new", () => [{ id: second.ids[0], holder: "instance:a" }]);
    expect(second.undo()).toBe(false);
    expect(lib.read(second.ids[0], A).ok).toBe(true);
  });
  it("undo accepts preexisting references to shared bytes, without removing them", () => {
    const { lib } = fixture(), c = upload(lib, H);
    lib.registerReferenceSource("old", () => [{ id: c.ids[0], holder: M1 }]);
    const second = upload(lib, A);
    expect(second.undo()).toBe(true);
    expect(lib.readReferenced(c.ids[0], M1).ok).toBe(true);
  });
  it("expires undo at the end of the synchronous stretch", async () => { const { lib } = fixture(), c = upload(lib); await Promise.resolve(); expect(c.undo()).toBe(false); });
});
describe("#1629 additional recovery and bounds", () => {
  it("does not release another principal or a direct holder", () => {
    const { lib } = fixture(), c = upload(lib, H, "agend.ready()", M1);
    const other = lib.releaseHolder(M1, P);
    expect(other.ok && other.released).toEqual([]);
    expect(lib.read(c.ids[0], H).ok).toBe(true);
    expect(lib.releaseHolder("upload", H).ok).toBe(false);
    expect(lib.read(c.ids[0], H).ok).toBe(true);
  });
  it("refuses another person's sharing request", () => { const { lib } = fixture(), c = upload(lib, H); expect(lib.setShared(c.ids[0], P, true).ok).toBe(false); expect(lib.read(c.ids[0], B).ok).toBe(false); });
  it("refuses malformed disk records, invalid UTF-8 and oversized index files", () => {
    for (const bad of [Buffer.from([0xff]), Buffer.from(JSON.stringify({ version: 1, rev: 0, entries: { invalid: {} } })), Buffer.concat([Buffer.from('{"version":1,"rev":0,"entries":{}}'), Buffer.alloc(4 * 1024 * 1024, 0x20)])]) {
      const { lib } = fixture();
      writeFileSync(lib.path, bad);
      expect(lib.stage(files(), A)).toEqual({ ok: false, error: "library_unreadable" });
      expect(readFileSync(lib.path).equals(bad)).toBe(true);
    }
  });
  it("refuses revision exhaustion without corrupting the stored index", () => {
    const { lib } = fixture();
    const doc = JSON.stringify({ version: 1, rev: Number.MAX_SAFE_INTEGER - 1, entries: {} });
    writeFileSync(lib.path, doc);
    const s = stage(lib);
    expect(lib.commit(s.stageId)).toEqual({ ok: false, error: "revision_exhausted" });
    expect(readFileSync(lib.path, "utf8")).toBe(doc);
  });
  it("refuses an unknown calendar or monotonic clock", () => {
    const { lib } = fixture({ now: () => NaN });
    const s = stage(lib);
    expect(lib.commit(s.stageId)).toEqual({ ok: false, error: "clock_unavailable" });
    expect(fixture({ monotonic: () => NaN }).lib.stage(files(), A)).toEqual({ ok: false, error: "clock_unavailable" });
  });
  it("bounds iteration independently of logical Map/Array sizes", () => {
    const { lib } = fixture(), map = files();
    map.values = function* () { for (let i = 0; i < 21; i++)
      yield new Uint8Array(); return undefined; };
    expect(lib.stage(map, A)).toEqual({ ok: false, error: "invalid_entries" });
    const array = [files()];
    array[Symbol.iterator] = function* () { for (let i = 0; i < 11; i++)
      yield files(); return undefined; };
    expect(lib.stage(array, A)).toEqual({ ok: false, error: "invalid_entries" });
  });
  it("never publishes partial authority when a multi-entry commit fails", () => {
    const { lib } = fixture({ beforeIndexRename: () => { throw Error("write failure"); } });
    const s = lib.stage([files(), files("// second")], A);
    if (!s.ok)
      throw Error(s.error);
    expect(lib.commit(s.stageId).ok).toBe(false);
    for (const id of s.ids)
      expect(lib.read(id, A).ok).toBe(false);
    expect(visible(lib, A)).toEqual([]);
  });
  it("undo failure preserves the postimage instead of overwriting it", () => {
    let broken = false;
    const { lib } = fixture({ beforeIndexRename: () => { if (broken)
        throw Error("write failure"); } });
    const c = upload(lib);
    broken = true;
    expect(c.undo()).toBe(false);
    expect(lib.read(c.ids[0], A).ok).toBe(true);
  });
  it("collects new unclaimed bytes after a synchronous rollback", async () => {
    const { dir, lib } = fixture(), c = upload(lib);
    expect(c.undo()).toBe(true);
    await Promise.resolve();
    expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(false);
  });
  it("a stage retains released bytes only until abort", async () => {
    const { dir, lib } = fixture(), c = upload(lib, H, "agend.ready()", M1), held = stage(lib, H);
    expect(lib.releaseHolder(M1, H).ok).toBe(true);
    await Promise.resolve();
    expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(true);
    lib.abort(held.stageId);
    await Promise.resolve();
    expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(false);
  });
  it("expiry releases a stage's hold without a wall timer or restart work", async () => {
    let mono = 0;
    const { dir, lib } = fixture({ monotonic: () => mono }), c = upload(lib, H, "agend.ready()", M1);
    stage(lib, H);
    lib.releaseHolder(M1, H);
    await Promise.resolve();
    mono = 600000;
    stage(lib, A, "// new");
    await Promise.resolve();
    expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(false);
  });
  it("returns warning tags and independent metadata for the import plan", () => {
    const { lib } = fixture(), s = stage(lib, A, 'fetch("https://example.invalid/")');
    expect(s.entries[0].warnings).toEqual(["network_or_import_api_unsupported"]);
    s.entries[0].warnings.length = 0;
    const c = lib.commit(s.stageId);
    expect(c.ok).toBe(true);
    const read = lib.read(s.ids[0], A);
    expect(read.ok && read.entry.warnings).toEqual(["network_or_import_api_unsupported"]);
  });
});
describe("#1629 final reference fences", () => {
  it.each(["release", "delete"])("revalidates %s references at the index write", action => {
    let moving = false;
    const refs: Array<{
      id: string;
      holder: string;
    }> = [];
    let id = "";
    const { lib } = fixture({ beforeIndexRename: () => { if (moving)
        refs.push({ id, holder: "instance:late" }); } });
    id = upload(lib, H, "agend.ready()", M1).ids[0];
    upload(lib, H);
    lib.registerReferenceSource("refs", () => refs);
    const before = readFileSync(lib.path);
    moving = true;
    const result = action === "release" ? lib.releaseHolder(M1, H) : lib.deleteClaim(id, H);
    expect(result).toEqual({ ok: false, error: "references_changed" });
    expect(readFileSync(lib.path).equals(before)).toBe(true);
  });
  it("rejects a provider that becomes unreadable before publication", () => {
    let broken = false, trigger = false;
    const { lib } = fixture({ beforeIndexRename: () => { if (trigger)
        broken = true; } });
    upload(lib, H, "agend.ready()", M1);
    lib.registerReferenceSource("changing", () => { if (broken)
      throw Error("changed"); return []; });
    const before = readFileSync(lib.path);
    trigger = true;
    expect(lib.releaseHolder(M1, H)).toEqual({ ok: false, error: "references_unreadable" });
    expect(readFileSync(lib.path).equals(before)).toBe(true);
  });
  it("keeps hostile-looking principal names as separate identities", () => {
    const { lib } = fixture(), proto: EffectPrincipal = { kind: "agent", id: "__proto__" }, ctor: EffectPrincipal = { kind: "agent", id: "constructor" };
    const c = upload(lib, proto);
    expect(lib.read(c.ids[0], ctor).ok).toBe(false);
    expect(visible(lib, proto)).toEqual(c.ids);
  });
});
it("refuses metadata that disagrees with the immutable canonical bundle", () => {
  const { lib, dir } = fixture(), c = upload(lib), doc = disk(dir);
  doc.entries[c.ids[0]].manifest.title = "Altered";
  writeFileSync(lib.path, JSON.stringify(doc));
  expect(lib.read(c.ids[0], A).ok).toBe(false);
  expect(lib.commit(stage(lib).stageId).ok).toBe(false);
});
it("bounds the retained stage memory at exactly sixty-four MiB", () => {
  const { lib } = fixture(), control = checkEffectEntry(files());
  if (!control.ok)
    throw Error("control");
  const size = 1024 * 1024 - control.files.get("effect.json")!.byteLength;
  const entries = Array.from({ length: 8 }, (_, i) => files(`//${i}` + "x".repeat(size - 3)));
  for (let i = 0; i < 8; i++)
    expect(lib.stage(entries, { kind: "agent", id: "bucket" + Math.floor(i / 4) }).ok).toBe(true);
  expect(lib.stage(files(), B)).toEqual({ ok: false, error: "stage_full" });
});
it("retains the second holder of the same principal", () => {
  const { lib } = fixture(), c = upload(lib, H, "agend.ready()", M1);
  upload(lib, H, "agend.ready()", M2);
  expect(lib.releaseHolder(M1, H).ok).toBe(true);
  expect(lib.read(c.ids[0], H).ok).toBe(true);
});

it("snapshots the authenticated principal at staging", () => {
  const { lib } = fixture(), principal: EffectPrincipal = { kind: "agent", id: "agent-a" };
  const s = stage(lib, principal); principal.id = "agent-b"; expect(lib.commit(s.stageId).ok).toBe(true);
  expect(lib.read(s.ids[0], A).ok).toBe(true); expect(lib.read(s.ids[0], B).ok).toBe(false);
});
it("physical collection retains another principal's claim without references", async () => {
  const { dir, lib } = fixture(), c = upload(lib); upload(lib, B); lib.deleteClaim(c.ids[0], A); await Promise.resolve();
  expect(lib.read(c.ids[0], B).ok).toBe(true); expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(true);
});
it("physical collection retains a reference with no claim", async () => {
  const { dir, lib } = fixture(), c = upload(lib, H, "agend.ready()", M1);
  lib.registerReferenceSource("instance", () => [{ id: c.ids[0], holder: "instance:retained" }]); lib.releaseHolder(M1, H); await Promise.resolve();
  expect(lib.read(c.ids[0], H).ok).toBe(false); expect(lib.readReferenced(c.ids[0], "instance:retained").ok).toBe(true); expect(existsSync(join(dir, "web-effects", c.ids[0]))).toBe(true);
});
it("refuses reentrant writes from a host reference provider", () => {
  const { lib } = fixture(), held = stage(lib); let ran = false, reply: unknown;
  lib.registerReferenceSource("reentrant", () => { if (!ran) { ran = true; reply = lib.commit(held.stageId); } return []; });
  expect(lib.commit(held.stageId).ok).toBe(true); expect(reply).toEqual({ ok: false, error: "library_busy" });
});

it("rejects the aggregate raw input before staging or claiming",()=>{
 const {lib}=fixture();const entries=Array.from({length:9},(_,i)=>files(`//${i}`+"x".repeat(1000000)));
 expect(lib.stage(entries,A)).toEqual({ok:false,error:"stage_too_large"});expect(visible(lib,A)).toEqual([]);
});

describe("#1629 explicit unused claim cleanup", () => {
  it("lets a principal explicitly remove an orphan mod claim without deleting another principal", async () => {
    const { dir, lib } = fixture(), id = upload(lib, H, "agend.ready()", M1).ids[0];
    upload(lib, P);
    expect(lib.deleteClaim(id, H)).toEqual({ok:true});
    expect(lib.read(id, H).ok).toBe(false);
    expect(lib.read(id, P).ok).toBe(true);
    await Promise.resolve();
    expect(existsSync(join(dir,"web-effects",id,"worker.js"))).toBe(true);
  });
  it("cannot remove an installed mod claim through ordinary delete", () => {
    const { lib } = fixture(), id = upload(lib, H, "agend.ready()", M1).ids[0];
    lib.registerReferenceSource("mods", () => [{ id, holder:M1 }]);
    expect(lib.deleteClaim(id,H)).toEqual({ok:false,error:"effect_in_use"});
    expect(lib.read(id,H).ok).toBe(true);
  });
  it("collects after the final host reference disappears, including after DB reopen", async () => {
    const { dir, lib } = fixture(), id = upload(lib,H,"agend.ready()",M1).ids[0];
    let refs=[{id,holder:"instance:fixture"}];
    lib.registerReferenceSource("themes",()=>refs);
    expect(lib.releaseHolder(M1,H).ok).toBe(true);
    await Promise.resolve();
    expect(existsSync(join(dir,"web-effects",id,"worker.js"))).toBe(true);
    refs=[];
    const reopened=new WebEffectLibrary(dir);
    reopened.registerReferenceSource("themes",()=>refs);
    reopened.collectUnreferenced([id]);
    await Promise.resolve();
    expect(existsSync(join(dir,"web-effects",id))).toBe(false);
    expect(Object.keys(disk(dir).entries)).toEqual([]);
  });
  it("collection notification still retains a late claim or reference", async () => {
    const { dir, lib } = fixture(), id = upload(lib,H,"agend.ready()",M1).ids[0];
    expect(lib.releaseHolder(M1,H).ok).toBe(true);
    lib.collectUnreferenced([id]);
    upload(lib,P);
    await Promise.resolve();
    expect(lib.read(id,P).ok).toBe(true);
    expect(existsSync(join(dir,"web-effects",id,"worker.js"))).toBe(true);
    expect(()=>lib.collectUnreferenced(["../bad"])).toThrow("Invalid collection ids");
  });
});

it("creates a missing scratch parent on a fresh checkout",()=>{
  const outer=fixture(), parent=join(outer.dir,"previously-absent");
  expect(existsSync(parent)).toBe(false);
  expect(()=>fixture({},parent)).not.toThrow();
  expect(existsSync(parent)).toBe(true);
});

describe("#1629 execution-bound undo",()=>{
 it.each(["commit","release"])("refuses prequeued queueMicrotask and Promise callbacks for %s",async operation=>{
  for(const scheduler of [queueMicrotask,(fn:()=>void)=>{void Promise.resolve().then(fn);}]){
   const {lib}=fixture(),s=stage(lib,H,"agend.ready()",M1);
   let receipt: {ok:true;undo:()=>boolean}|{ok:false;error:string}|undefined;
   if(operation==="release")expect(lib.commit(s.stageId).ok).toBe(true);
   const later=new Promise<boolean>(resolve=>scheduler(()=>resolve(receipt?.ok?receipt.undo():true)));
   receipt=operation==="commit"?lib.commit(s.stageId):lib.releaseHolder(M1,H);
   expect(receipt.ok).toBe(true);
   expect(await later).toBe(false);
   expect(lib.read(s.ids[0]!,H).ok).toBe(operation==="commit");
  }
 });
});
