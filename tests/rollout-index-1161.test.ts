import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RolloutIndex, sharedRolloutIndex, resetSharedRolloutIndexesForTests, type RolloutFsOps } from "../src/rollout-index.js";

/** #1161 (D2): one shared, incrementally refreshed listing of Codex's rollout tree. */
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-rollout-index-")); resetSharedRolloutIndexesForTests(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function counting() {
  const calls = { readdir: [] as string[], stat: [] as string[] };
  const ops: RolloutFsOps = {
    readdir: dir => { calls.readdir.push(dir); return readdirSync(dir); },
    stat: path => { calls.stat.push(path); return statSync(path); },
  };
  return { ops, calls, reset: () => { calls.readdir.length = 0; calls.stat.length = 0; } };
}

function rollout(date: string, name: string, mtimeSecondsAgo = 0, body = "{}\n"): string {
  const dir = join(root, ...date.split("/"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(path, body);
  const when = new Date(Date.now() - mtimeSecondsAgo * 1000);
  utimesSync(path, when, when);
  return path;
}
function age(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}
/** The walk this index replaced, as the reference for what must be listed and in which order. */
function oldWalk(dir: string, depth = 0, out: Array<{ path: string; mtimeMs: number; size: number }> = []): typeof out {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      const st = statSync(p);
      if (st.isDirectory() && depth < 4) oldWalk(p, depth + 1, out);
      else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* raced */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

describe("what it lists", () => {
  it("is exactly what the old per-poll walk found, newest first", () => {
    rollout("2026/08/01", "a", 500); rollout("2026/08/01", "b", 300); rollout("2026/09/02", "c", 100); rollout("2026/09/02", "d", 10);
    mkdirSync(join(root, "2026", "09", "03"), { recursive: true });                     // an empty shard
    writeFileSync(join(root, "2026", "09", "02", "notes.txt"), "not a rollout");
    const index = new RolloutIndex(root, { ttlMs: 0 });
    expect(index.list()).toEqual(oldWalk(root));
    expect(index.list().map(f => basename(f.path).slice("rollout-".length))).toEqual(["d.jsonl", "c.jsonl", "b.jsonl", "a.jsonl"]);
  });

  it("only looks as deep as the old walk did (depth 4)", () => {
    rollout("a/b/c/d", "at-depth-4", 10);          // dirs at depth 1..4 → files in the depth-4 dir are listed
    rollout("a/b/c/d/e", "at-depth-5", 5);         // one level further is not
    expect(new RolloutIndex(root, { ttlMs: 0 }).list().map(f => basename(f.path).slice("rollout-".length))).toEqual(["at-depth-4.jsonl"]);
  });

  it("a missing sessions directory lists nothing", () => {
    expect(new RolloutIndex(join(root, "nope"), { ttlMs: 0 }).list()).toEqual([]);
  });

  it("sizes and mtimes are the files' own", () => {
    const p = rollout("2026/08/01", "a", 0, "x".repeat(123));
    expect(new RolloutIndex(root).list()[0]).toMatchObject({ path: p, size: 123 });
  });
});

describe("it is shared and reused", () => {
  it("one listing serves every caller within the TTL: the second call touches no file at all", () => {
    rollout("2026/08/01", "a", 100);
    const { ops, calls, reset } = counting();
    let now = 1_000_000;
    const index = new RolloutIndex(root, { ttlMs: 1_000, ops, now: () => now });
    const first = index.list();
    reset();
    now += 900;
    expect(index.list()).toBe(first);                       // the same array
    expect(calls.stat).toEqual([]); expect(calls.readdir).toEqual([]);
  });

  it("after the TTL it refreshes (and a new rollout appears)", () => {
    rollout("2026/08/01", "a", 100);
    let now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 1_000, now: () => now });
    expect(index.list()).toHaveLength(1);
    rollout("2026/08/01", "b", 0);
    now += 500;
    expect(index.list()).toHaveLength(1);                   // still the shared listing
    now += 600;
    expect(index.list().map(f => basename(f.path).slice("rollout-".length))).toEqual(["b.jsonl", "a.jsonl"]);
  });

  it("`fresh` bypasses the TTL (baselines and checkpoints need the truth)", () => {
    rollout("2026/08/01", "a", 100);
    const now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 60_000, now: () => now });
    index.list();
    rollout("2026/08/01", "b", 0);
    expect(index.list()).toHaveLength(1);
    expect(index.list(true)).toHaveLength(2);
  });

  it("the shared registry hands every source of one directory the same index", () => {
    expect(sharedRolloutIndex(root)).toBe(sharedRolloutIndex(root));
    expect(sharedRolloutIndex(root)).not.toBe(sharedRolloutIndex(join(root, "other")));
  });
});

describe("what a refresh skips", () => {
  const HOUR = 3600;
  function tree() {
    const old1 = rollout("2026/01/01", "old1", 30 * HOUR);
    const old2 = rollout("2026/01/02", "old2", 29 * HOUR);
    const live = rollout("2026/02/01", "live", 1);
    // directories as old as their files, so they are not "hot"
    for (const d of ["2026", "2026/01", "2026/01/01", "2026/01/02", "2026/02", "2026/02/01"]) age(join(root, ...d.split("/")), 20 * HOUR);
    age(root, 20 * HOUR);
    return { old1, old2, live };
  }

  it("a directory whose mtime has not moved is not read again, and a quiet rollout is not stat'ed again", () => {
    const { old1, old2, live } = tree();
    const { ops, calls, reset } = counting();
    let now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 0, quietMs: 10 * 60_000, fullRefreshMs: 3_600_000, ops, now: () => now });
    index.list(); reset();
    now += 5_000;
    index.list();
    expect(calls.readdir).toEqual([]);                      // nothing changed: no directory is re-read
    expect(calls.stat).not.toContain(old1);                 // quiet rollouts keep their last stat…
    expect(calls.stat).not.toContain(old2);
    expect(calls.stat).toContain(live);                     // …the one that is moving is looked at every time
  });

  it("a new rollout bumps its directory's mtime and is found without a full refresh", () => {
    tree();
    const { ops, calls, reset } = counting();
    let now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 0, fullRefreshMs: 3_600_000, ops, now: () => now });
    index.list(); reset();
    const fresh = rollout("2026/02/01", "fresh", 0);        // creating it changes 2026/02/01's mtime
    now += 5_000;
    expect(index.list().map(f => f.path)).toContain(fresh);
    expect(calls.readdir).toEqual([join(root, "2026", "02", "01")]);   // only the directory that changed
  });

  it("a rollout created in the same tick as the directory's last change is still found (a recently changed directory is always re-read)", () => {
    const { ops } = counting();
    let now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 0, fullRefreshMs: 3_600_000, ops, now: () => now });
    rollout("2026/03/01", "first", 0);
    index.list();
    const second = rollout("2026/03/01", "second", 0);
    const dir = join(root, "2026", "03", "01");
    const pinned = statSync(dir).mtime;
    utimesSync(dir, pinned, pinned);                         // same mtime as when it was last read
    now += 10;
    expect(index.list().map(f => f.path)).toContain(second);
  });

  it("a full refresh re-reads and re-stats everything, so an old rollout that was resumed moves to the front", () => {
    const { old1 } = tree();
    let now = Date.now();
    const index = new RolloutIndex(root, { ttlMs: 0, quietMs: 10 * 60_000, fullRefreshMs: 60_000, now: () => now });
    index.list();
    age(old1, 0);                                            // codex resumed the oldest session: its mtime jumps
    now += 5_000;
    expect(index.list()[0]!.path).not.toBe(old1);            // a quick refresh does not look at quiet files…
    now += 60_000;
    expect(index.list()[0]!.path).toBe(old1);                // …the next full refresh does
  });

  it("deleted rollouts and removed directories drop out", () => {
    const { old1, live } = tree();
    const index = new RolloutIndex(root, { ttlMs: 0 });
    expect(index.list()).toHaveLength(3);
    unlinkSync(old1);
    rmSync(join(root, "2026", "02"), { recursive: true });
    const after = index.list(true).map(f => f.path);
    expect(after).not.toContain(old1);
    expect(after).not.toContain(live);
    expect(after).toHaveLength(1);
  });
});
