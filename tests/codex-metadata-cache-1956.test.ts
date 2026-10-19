/**
 * #1956 item 2: codex effort metadata is read once per version of its files. The fleet's status asked for it for every
 * codex instance on every build, and each ask parsed the whole models_cache.json (hundreds of KB) again.
 * - Same answers as before; a second ask reads neither file again.
 * - A changed file is read on the next ask: rewritten in place, rewritten at the same size, replaced by a rename, its
 *   mode changed; config.toml too (another model). A file written less than FILE_SETTLED_MS ago is read on every ask
 *   (a filesystem's coarse clock can give two quick writes the same stamp), until it has settled.
 * - A missing, unreadable, oversized or broken file gives today's answer, and is not kept as an answer (it is asked
 *   again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reads: string[] = [];
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => { reads.push(String(args[0])); return actual.readFileSync(...args); } };
});
const { CODEX_MODELS_CACHE_MAX_BYTES, FILE_CACHE_MAX, FILE_SETTLED_MS, codexMetadataClock, readCodexEffortLevels, readCodexModelEffortLevels, resetCodexMetadataCache } = await import("../src/backend/codex-metadata.js");
/** Files changed now look a minute old to the cache: settled, so a cached answer is trusted (ctime can't be set back). */
const settledClock = () => { codexMetadataClock.now = () => Date.now() + 60_000; };
const realClock = () => { codexMetadataClock.now = () => Date.now(); };
/** Last written a minute ago (as a settled file in use is): any rewrite now gets another mtime. */
const age = (file: string) => { const then = new Date(Date.now() - 60_000); utimesSync(file, then, then); };

let root: string, shared: string, isolated: string;
const homes = () => ({ isolatedHome: isolated, sharedHome: shared });
const cache = (levels: Record<string, string[]>, pad = 0) => JSON.stringify({ models: Object.entries(levels).map(([slug, l]) => ({ slug,
  supported_reasoning_levels: l.map((effort) => ({ effort })), description: "x".repeat(pad) })) });
const readsOf = (name: string) => reads.filter((p) => p.endsWith(name)).length;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1956-")); shared = join(root, "shared"); isolated = join(root, "isolated");
  mkdirSync(shared); mkdirSync(isolated);
  writeFileSync(join(shared, "config.toml"), 'model = "demo-a"\n');
  writeFileSync(join(shared, "models_cache.json"), cache({ "demo-a": ["low", "high"], "demo-b": ["medium"] }));
  age(join(shared, "config.toml")); age(join(shared, "models_cache.json"));
  settledClock();
  resetCodexMetadataCache(); reads.length = 0;
});
afterEach(() => { realClock(); rmSync(root, { recursive: true, force: true }); });

describe("read once per version of the file", () => {
  it("the same answers; a second ask reads neither file", () => {
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: "demo-a", levels: ["low", "high"] });
    expect([readsOf("models_cache.json"), readsOf("config.toml")]).toEqual([1, 1]);
    for (let i = 0; i < 5; i++) expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
    expect([readsOf("models_cache.json"), readsOf("config.toml")]).toEqual([1, 1]);
    expect(readCodexModelEffortLevels({ ...homes(), model: "demo-b" })).toEqual({ model: "demo-b", levels: ["medium"] });
    expect(readsOf("models_cache.json")).toBe(1);                                         // another model: the same file
  });
  it("a file written less than a second ago is read on every ask, until it has settled", () => {
    const file = join(shared, "models_cache.json");
    realClock();
    writeFileSync(file, cache({ "demo-a": ["low"] }));
    expect([readCodexEffortLevels(homes()), readCodexEffortLevels(homes()), readsOf("models_cache.json")]).toEqual([["low"], ["low"], 2]);
    settledClock();                                                                       // a second later
    readCodexEffortLevels(homes()); readCodexEffortLevels(homes());
    expect(readsOf("models_cache.json")).toBe(3);                                         // settled: read once more, then kept
    expect(FILE_SETTLED_MS).toBe(1000);
  });
  it("an answer can't be changed by its caller (each gets its own list)", () => {
    const first = readCodexEffortLevels(homes());
    first.push("max");
    expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
  });
  it("models_cache.json rewritten in place: read again on the next ask", () => {
    readCodexEffortLevels(homes());
    writeFileSync(join(shared, "models_cache.json"), cache({ "demo-a": ["low", "medium", "high", "xhigh"] }));
    expect(readCodexEffortLevels(homes())).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("rewritten at the same size, its mtime put back, all inside one tick of the clock: still read again (it hadn't settled)", () => {
    const file = join(shared, "models_cache.json");
    writeFileSync(file, cache({ "demo-a": ["high", "low"] }));
    realClock(); resetCodexMetadataCache();                                                // a real clock: just written, so racy
    expect(readCodexEffortLevels(homes())).toEqual(["high", "low"]);
    const was = statSync(file);
    writeFileSync(file, cache({ "demo-a": ["low", "high"] }));                             // the same size, another order
    expect(statSync(file).size).toBe(was.size);
    utimesSync(file, was.atime, was.mtime);                                                // inside one coarse tick: the same stamp
    expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
  });
  // #2224 review (Fable): the stamp's ctime, proven with the cache trusting the old version (a settled clock) — the
  // racy rule can't be what re-reads it. A filesystem clock tick is waited out, so the change's ctime is a new one.
  const nextTick = () => new Promise((r) => setTimeout(r, 50));
  it("trusted, then rewritten at the same size with its mtime put back (cp -p, rsync -t, touch -r): read again by its ctime", async () => {
    const file = join(shared, "models_cache.json");
    writeFileSync(file, cache({ "demo-a": ["high", "low"] })); age(file);
    resetCodexMetadataCache();
    expect(readCodexEffortLevels(homes())).toEqual(["high", "low"]);
    const was = statSync(file);
    await nextTick();
    writeFileSync(file, cache({ "demo-a": ["low", "high"] }));                             // same inode, same size
    utimesSync(file, was.atime, was.mtime);                                               // and its mtime as it was
    const now = statSync(file);
    expect([now.ino, now.size, now.mtimeMs, now.ctimeMs === was.ctimeMs]).toEqual([was.ino, was.size, was.mtimeMs, false]);
    expect(codexMetadataClock.now() - Math.max(now.mtimeMs, now.ctimeMs)).toBeGreaterThanOrEqual(FILE_SETTLED_MS);   // still "settled"
    expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
  });
  it("trusted while unreadable, then made readable (a chmod: only its ctime moves): read again", async () => {
    if (process.getuid?.() === 0) return;                                                 // root reads anything
    const file = join(shared, "config.toml");
    chmodSync(file, 0o000); age(file);
    resetCodexMetadataCache();
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: null, levels: null });
    await nextTick();
    chmodSync(file, 0o644);
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: "demo-a", levels: ["low", "high"] });
  });
  it(`at most FILE_CACHE_MAX files are kept: past ${256}, the oldest is read again`, () => {
    readCodexEffortLevels(homes());
    expect(readsOf("config.toml")).toBe(1);
    for (let i = 0; i < FILE_CACHE_MAX; i++) {                                           // that many other homes' files
      const h = join(root, `h${i}`); mkdirSync(h); writeFileSync(join(h, "config.toml"), 'model = "demo-a"\n'); age(join(h, "config.toml"));
      readCodexModelEffortLevels({ isolatedHome: h, sharedHome: shared });
    }
    reads.length = 0;
    readCodexEffortLevels(homes());
    expect(readsOf(join(shared, "config.toml"))).toBe(1);                                 // it was let go
  });
  it("replaced by a rename (codex writes a new file): read again", () => {
    readCodexEffortLevels(homes());
    const tmp = join(shared, "models_cache.json.tmp");
    writeFileSync(tmp, cache({ "demo-a": ["xhigh"] }));
    renameSync(tmp, join(shared, "models_cache.json"));
    expect(readCodexEffortLevels(homes())).toEqual(["xhigh"]);
  });
  it("replaced by a rename with the same size and mtime (only the inode, and ctime, differ): read again", () => {
    const file = join(shared, "models_cache.json");
    writeFileSync(file, cache({ "demo-a": ["high", "low"] })); age(file);
    resetCodexMetadataCache();
    expect(readCodexEffortLevels(homes())).toEqual(["high", "low"]);
    const was = statSync(file), tmp = join(shared, "models_cache.json.tmp");
    writeFileSync(tmp, cache({ "demo-a": ["low", "high"] })); utimesSync(tmp, was.atime, was.mtime);
    renameSync(tmp, file);
    expect([statSync(file).size, statSync(file).mtimeMs, statSync(file).ino === was.ino]).toEqual([was.size, was.mtimeMs, false]);
    expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
  });
  it("a slug listed twice: the first entry's levels, as before", () => {
    const file = join(shared, "models_cache.json");
    writeFileSync(file, JSON.stringify({ models: [{ slug: "demo-a", supported_reasoning_levels: [{ effort: "low" }] }, { slug: "demo-a", supported_reasoning_levels: [{ effort: "high" }] }] }));
    age(file); resetCodexMetadataCache();
    expect(readCodexEffortLevels(homes())).toEqual(["low"]);
  });
  it("config.toml changed to another model: its levels on the next ask", () => {
    expect(readCodexEffortLevels(homes())).toEqual(["low", "high"]);
    writeFileSync(join(shared, "config.toml"), 'model = "demo-b"\n');
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: "demo-b", levels: ["medium"] });
  });
  it("the instance's own cache appearing wins from the next ask (as before)", () => {
    readCodexEffortLevels(homes());
    writeFileSync(join(isolated, "models_cache.json"), cache({ "demo-a": ["medium", "high"] }));
    expect(readCodexEffortLevels(homes())).toEqual(["medium", "high"]);
  });
});

describe("a file that can't be used gives today's answer, and is asked again", () => {
  it("no models_cache.json: the default levels; one written later is read", () => {
    rmSync(join(shared, "models_cache.json"));
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: "demo-a", levels: null });
    expect(readCodexEffortLevels(homes())).toEqual(["low", "medium", "high", "xhigh"]);
    writeFileSync(join(shared, "models_cache.json"), cache({ "demo-a": ["high"] }));
    expect(readCodexEffortLevels(homes())).toEqual(["high"]);
  });
  it("broken JSON: null each time, and read again each time (a parse that throws is not kept); fixed, it is read", () => {
    writeFileSync(join(shared, "models_cache.json"), "{ not json");
    expect(readCodexModelEffortLevels(homes()).levels).toBeNull();
    expect(readCodexModelEffortLevels(homes()).levels).toBeNull();
    expect(readsOf("models_cache.json")).toBe(2);
    writeFileSync(join(shared, "models_cache.json"), cache({ "demo-a": ["low"] }));
    expect(readCodexEffortLevels(homes())).toEqual(["low"]);
  });
  it("larger than the limit: null without reading it, as before", () => {
    writeFileSync(join(shared, "models_cache.json"), cache({ "demo-a": ["low"] }, CODEX_MODELS_CACHE_MAX_BYTES));
    expect([readCodexModelEffortLevels(homes()).levels, readsOf("models_cache.json")]).toEqual([null, 0]);
  });
  it("an unreadable config.toml: no model (as before); readable again (its mode changed), read again", () => {
    if (process.getuid?.() === 0) return;                                                 // root reads anything
    realClock();                                                                          // a chmod moves only ctime: judged as it is
    chmodSync(join(shared, "config.toml"), 0o000);
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: null, levels: null });
    chmodSync(join(shared, "config.toml"), 0o644);
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: "demo-a", levels: ["low", "high"] });
  });
  it("no config.toml in either home: no model, as before", () => {
    rmSync(join(shared, "config.toml"));
    expect(readCodexModelEffortLevels(homes())).toEqual({ model: null, levels: null });
  });
});
