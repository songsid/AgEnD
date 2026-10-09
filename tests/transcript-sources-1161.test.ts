import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRolloutSource, KiroSessionSource } from "../src/transcript-sources.js";
import { RolloutIndex, resetSharedRolloutIndexesForTests, type RolloutFsOps } from "../src/rollout-index.js";

/** #1161 D2 / D3: what the transcript sources stopped doing on every 2 s poll. */
let root: string;
let work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-ts-1161-"));
  work = mkdtempSync(join(tmpdir(), "agend-ts-1161-work-"));
  resetSharedRolloutIndexesForTests(0);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const call = (name: string) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: "{}" } }) + "\n";
const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { id: "x", cwd } }) + "\n";

describe("Codex: the active rollout's session_meta is read once, not on every poll (D2)", () => {
  const dayDir = () => join(root, "sessions", "2026", "10", "04");
  it("a positive verdict is as final as a rejection", async () => {
    mkdirSync(dayDir(), { recursive: true });
    const mine = join(dayDir(), "rollout-mine.jsonl");
    writeFileSync(mine, meta(work));
    const source = new CodexRolloutSource(work, join(root, "sessions"), Date.now());
    appendFileSync(mine, call("first"));
    expect((await source.poll()).toolUses.map(u => u.name)).toEqual(["first"]);
    // The head of the file can no longer be read as ours — a cache that re-reads it would lose the file…
    const body = `${"#".repeat(statSync(mine).size - call("x").length)}`;
    writeFileSync(mine, body.padEnd(statSync(mine).size, "#"));
    appendFileSync(mine, call("second"));
    // …a cache that remembers the verdict keeps following it.
    expect((await source.poll()).toolUses.map(u => u.name)).toEqual(["second"]);
  });

  it("reset() forgets the verdicts (a new session may live in the same path set)", async () => {
    mkdirSync(dayDir(), { recursive: true });
    const mine = join(dayDir(), "rollout-mine.jsonl");
    writeFileSync(mine, meta(work));
    const source = new CodexRolloutSource(work, join(root, "sessions"), Date.now());
    appendFileSync(mine, call("a"));
    await source.poll();
    writeFileSync(mine, "#".repeat(statSync(mine).size));        // head no longer ours
    source.reset();
    appendFileSync(mine, call("b"));
    expect((await source.poll()).toolUses).toEqual([]);          // verdict re-evaluated after reset: not ours any more
  });
});

describe("Codex: instances following the same directory share one listing (D2)", () => {
  function countingIndex(ttlMs: number) {
    const stats: string[] = [];
    const ops: RolloutFsOps = { readdir: dir => readdirSync(dir), stat: p => { stats.push(p); return statSync(p); } };
    let now = 1_000_000;
    return { index: new RolloutIndex(join(root, "sessions"), { ttlMs, ops, now: () => now }), stats, advance: (ms: number) => { now += ms; } };
  }

  it("N sources polling inside one TTL cost one scan, not N", async () => {
    const day = join(root, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(join(day, `rollout-r${i}.jsonl`), meta(`/some/where/${i}`));
    const { index, stats, advance } = countingIndex(1_000);
    const sources = Array.from({ length: 8 }, (_, i) => new CodexRolloutSource(`/some/where/${i % 6}`, join(root, "sessions"), Date.now(), index));
    stats.length = 0;
    advance(5_000);                                              // past the TTL of the construction-time scan
    for (const source of sources) await source.poll();
    const oneScan = stats.length;
    expect(oneScan).toBeGreaterThan(0);
    stats.length = 0;
    for (const source of sources) await source.poll();           // still inside the TTL
    expect(stats.length).toBe(0);
    advance(1_500);
    await sources[0]!.poll();
    expect(stats.length).toBeGreaterThan(0);                     // and it refreshes after the TTL
  });

  it("each source still follows ITS OWN rollout out of the shared listing", async () => {
    const day = join(root, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    const a = join(day, "rollout-a.jsonl"); const b = join(day, "rollout-b.jsonl");
    writeFileSync(a, meta("/w/a")); writeFileSync(b, meta("/w/b"));
    const { index } = countingIndex(1_000);
    const sa = new CodexRolloutSource("/w/a", join(root, "sessions"), Date.now(), index);
    const sb = new CodexRolloutSource("/w/b", join(root, "sessions"), Date.now(), index);
    appendFileSync(a, call("only-a")); appendFileSync(b, call("only-b"));
    expect((await sa.poll()).toolUses.map(u => u.name)).toEqual(["only-a"]);
    expect((await sb.poll()).toolUses.map(u => u.name)).toEqual(["only-b"]);
  });
});

describe("Codex: a rollout created in the same coarse tick as the directory's last change is picked up at the real poll cadence (D2)", () => {
  it("polls 2 s apart still find it on the second poll — not a full refresh (60 s) later", async () => {
    const day = join(root, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    const base = Date.now();
    const stamp = new Date(base);
    let now = base;
    const index = new RolloutIndex(join(root, "sessions"), { ttlMs: 1_000, fullRefreshMs: 3_600_000, now: () => now });
    const pinDirs = () => { for (const d of [join(root, "sessions"), join(root, "sessions", "2026"), join(root, "sessions", "2026", "10"), day]) utimesSync(d, stamp, stamp); };
    writeFileSync(join(day, "rollout-other.jsonl"), meta("/not/ours"));
    pinDirs();
    now = base + 900;
    const source = new CodexRolloutSource(work, join(root, "sessions"), Date.now(), index);   // baseline scan inside the hot window
    const mine = join(day, "rollout-mine.jsonl");
    writeFileSync(mine, meta(work) + call("late"));            // created in the same tick as the directory's mtime
    pinDirs();
    now = base + 2_900;                                         // the next normal poll: the directory has cooled
    expect((await source.poll()).toolUses.map(u => u.name)).toEqual(["late"]);
  });
});

describe("Codex: a baseline never trusts a shared listing (D2)", () => {
  it("a rollout created (with history) inside the listing's TTL is still baselined to its EOF, not replayed", async () => {
    const day = join(root, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    const now = 1_000_000;
    const index = new RolloutIndex(join(root, "sessions"), { ttlMs: 3_600_000, now: () => now });
    index.list();                                                  // an earlier source built the shared listing
    const history = join(day, "rollout-history.jsonl");
    writeFileSync(history, meta(work) + call("old-1") + call("old-2"));   // created AFTER that listing, before this source
    const source = new CodexRolloutSource(work, join(root, "sessions"), Date.now(), index);
    appendFileSync(history, call("fresh"));
    expect((await source.poll()).toolUses.map(u => u.name)).toEqual(["fresh"]);   // history was baselined, not replayed
  });

  it("checkpoint() sees a rollout the shared listing has not caught up with", async () => {
    const day = join(root, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    const index = new RolloutIndex(join(root, "sessions"), { ttlMs: 3_600_000, now: () => 1_000_000 });
    const source = new CodexRolloutSource(work, join(root, "sessions"), Date.now(), index);
    const mine = join(day, "rollout-late.jsonl");
    writeFileSync(mine, meta(work));
    expect((await source.checkpoint())?.path).toBe(mine);
  });
});

describe("Kiro JSON fallback: a session's metadata is parsed once per change, not on every poll (D3)", () => {
  const sessionsDir = () => join(root, "kiro-sessions");
  const missingDb = () => join(root, "missing.sqlite3");
  function writeSession(id: string, cwd: string, updatedAt: string, reason?: string): string {
    mkdirSync(sessionsDir(), { recursive: true });
    const metaPath = join(sessionsDir(), `${id}.json`);
    writeFileSync(metaPath, JSON.stringify({ session_id: id, cwd, created_at: updatedAt, updated_at: updatedAt, ...(reason ? { session_created_reason: reason } : {}) }));
    writeFileSync(join(sessionsDir(), `${id}.jsonl`), "");
    return metaPath;
  }
  const pin = (path: string, at: Date) => utimesSync(path, at, at);
  const active = async (source: KiroSessionSource) => (await (source as unknown as { resolveActiveSession(): Promise<{ jsonlPath: string } | null> }).resolveActiveSession())?.jsonlPath;

  it("an unchanged file is not re-read: its cached verdict stands", async () => {
    const when = new Date(Date.now() - 60_000);
    const mine = writeSession("mine", work, "2026-10-04T10:00:00Z"); pin(mine, when);
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
    // Rewrite it as someone else's, same size, same mtime: only a re-read could notice.
    const size = statSync(mine).size;
    const mtimeBefore = statSync(mine).mtimeMs;
    const foreign = JSON.stringify({ session_id: "mine", cwd: "/z", created_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T10:00:00Z" });
    expect(foreign.length).toBeLessThan(size);
    writeFileSync(mine, foreign.padEnd(size));
    pin(mine, when);
    expect(statSync(mine).mtimeMs).toBe(mtimeBefore);              // really untouched as far as stat can tell
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
  });

  it("a changed file (mtime or size) is read again", async () => {
    const mine = writeSession("mine", work, "2026-10-04T10:00:00Z");
    pin(mine, new Date(Date.now() - 60_000));
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
    writeSession("mine", "/someone/else", "2026-10-04T10:00:00Z");   // new content, new mtime
    expect(await active(source)).toBeUndefined();
  });

  it("a file that only changed in mtime is read again — and so is one that only changed in size", async () => {
    const base = new Date(Date.now() - 60_000);
    const mine = writeSession("mine", work, "2026-10-04T10:00:00Z"); pin(mine, base);
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
    const size = statSync(mine).size;
    const foreign = JSON.stringify({ session_id: "mine", cwd: "/z", created_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T10:00:00Z" });
    // same size, newer mtime
    writeFileSync(mine, foreign.padEnd(size)); pin(mine, new Date(base.getTime() + 5_000));
    expect(await active(source)).toBeUndefined();
    // back to ours with a different size, mtime pinned to the one the cache has now
    const cachedMtime = statSync(mine).mtime;
    writeFileSync(mine, JSON.stringify({ session_id: "mine", cwd: work, created_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T10:00:00Z", more: "x" }));
    utimesSync(mine, cachedMtime, cachedMtime);
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
  });

  it("the newest session for the cwd still wins, subagents and other cwds still skipped", async () => {
    pin(writeSession("old", work, "2026-10-04T09:00:00Z"), new Date(Date.now() - 90_000));
    pin(writeSession("new", work, "2026-10-04T11:00:00Z"), new Date(Date.now() - 80_000));
    pin(writeSession("sub", work, "2026-10-04T12:00:00Z", "subagent"), new Date(Date.now() - 70_000));
    pin(writeSession("foreign", "/other", "2026-10-04T13:00:00Z"), new Date(Date.now() - 60_000));
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    expect(await active(source)).toBe(join(sessionsDir(), "new.jsonl"));
    expect(await active(source)).toBe(join(sessionsDir(), "new.jsonl"));   // and again, from the cache
    pin(writeSession("newer", work, "2026-10-04T14:00:00Z"), new Date());
    expect(await active(source)).toBe(join(sessionsDir(), "newer.jsonl"));
  });

  it("a half-written metadata file is retried next poll, not cached as 'not ours'", async () => {
    mkdirSync(sessionsDir(), { recursive: true });
    const metaPath = join(sessionsDir(), "mine.json");
    writeFileSync(metaPath, '{"session_id":"mine","cwd":');           // torn
    writeFileSync(join(sessionsDir(), "mine.jsonl"), "");
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    expect(await active(source)).toBeUndefined();
    writeSession("mine", work, "2026-10-04T10:00:00Z");
    expect(await active(source)).toBe(join(sessionsDir(), "mine.jsonl"));
  });

  it("the cache forgets files that are gone", async () => {
    const a = writeSession("a", work, "2026-10-04T10:00:00Z"); writeSession("b", work, "2026-10-04T11:00:00Z");
    const source = new KiroSessionSource(work, sessionsDir(), Date.now(), missingDb());
    await active(source);
    expect((source as unknown as { metaCache: Map<string, unknown> }).metaCache.size).toBe(2);
    rmSync(a); rmSync(join(sessionsDir(), "a.jsonl"));
    await active(source);
    expect((source as unknown as { metaCache: Map<string, unknown> }).metaCache.size).toBe(1);
  });
});
