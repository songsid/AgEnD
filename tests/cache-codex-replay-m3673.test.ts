import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheService } from "../src/cache-service.js";
import { addTurn, codexRebuild, emptyLedger, type FileCursor } from "../src/cache-ledger.js";

const NOW = Date.parse("2026-11-24T14:00:00Z");
const usage = (timestamp: string, turn: string, total: number, input = 100) => [
  { timestamp, type: "turn_context", payload: { turn_id: turn, model: "gpt-5.5" } },
  { timestamp, type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 10, total_tokens: input + 10 },
    total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total },
  } } },
];

describe("Codex fork replay accounting M3673", () => {
  let dir: string;
  let service: CacheService | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-replay-")); mkdirSync(join(dir, "sessions")); });
  afterEach(() => { service?.stop(); rmSync(dir, { recursive: true, force: true }); });
  const rollout = (id: string, rows: unknown[], parent?: string) => {
    const path = join(dir, "sessions", `${id}.jsonl`);
    writeFileSync(path, [{ type: "session_meta", payload: { id, cwd: dir, ...(parent ? { forked_from_id: parent } : {}) } }, ...rows].map(r => JSON.stringify(r)).join("\n") + "\n");
    return path;
  };
  const make = (over: Partial<ConstructorParameters<typeof CacheService>[0]> = {}) => service = new CacheService({
    instances: () => [{ name: "example", backend: "codex", workingDirectory: dir, ledgerPath: join(dir, "state", "cache-ledger.json") }],
    claudeProjectsDir: () => join(dir, "claude"), claudeKey: x => x,
    codexSessionsDir: () => join(dir, "sessions"),
    listRollouts: root => readdirSync(root).map(name => { const path = join(root, name); return { path, mtimeMs: statSync(path).mtimeMs }; }),
    metaPath: join(dir, "rollouts.json"), now: () => NOW, ...over,
  });
  const requests = async (s: CacheService, window: "24h" | "7d") => (await s.report(window)).instances[0]!.analysis?.requests ?? 0;

  it("counts inherited requests once at their original dates and keeps genuine child work across restart", async () => {
    const original = usage("2026-11-22T12:00:00Z", "shared-turn", 110);
    rollout("parent", original);
    const a = make(); await a.kick(); a.stop();
    // Codex thread_spawn rewrites timestamps while retaining original turn IDs and usage.
    rollout("child", [...usage("2026-11-24T12:00:00Z", "shared-turn", 110), ...usage("2026-11-24T12:01:00Z", "child-turn", 220)], "parent");
    const b = make(); await b.kick();
    expect(await requests(b, "24h")).toBe(1);
    expect(await requests(b, "7d")).toBe(2);
    b.stop();
    const c = make(); await c.kick();
    expect(await requests(c, "7d")).toBe(2);
  });

  it("keeps distinct requests whose per-request usage is equal", async () => {
    rollout("parent", [...usage("2026-11-24T12:00:00Z", "turn-a", 110), ...usage("2026-11-24T12:01:00Z", "turn-b", 220)]);
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(2);
  });

  it("keeps multiple requests in one turn and ignores a repeated announcement or copied envelope", async () => {
    const rows = [...usage("2026-11-24T12:00:00Z", "turn-a", 110), ...usage("2026-11-24T12:01:00Z", "turn-a", 220)];
    const parent = rollout("parent", [...rows, ...usage("2026-11-24T12:02:00Z", "turn-a", 220)]);
    rollout("child", rows, "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(2);
    appendFileSync(parent, usage("2026-11-24T12:03:00Z", "turn-b", 330).map(r => JSON.stringify(r)).join("\n") + "\n");
    await s.kick();
    expect(await requests(s, "24h")).toBe(3);
  });

  it("reads an ancestor outside the mtime window before a recent child and never charges its ancient prefix today", async () => {
    const parent = rollout("parent", usage("2026-09-01T12:00:00Z", "old-turn", 110));
    utimesSync(parent, new Date("2026-09-01"), new Date("2026-09-01"));
    rollout("child", [...usage("2026-11-24T12:00:00Z", "old-turn", 110), ...usage("2026-11-24T12:01:00Z", "new-turn", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "7d")).toBe(1);
  });

  it("completes a permanently absent parent's fork and repairs its dates if that parent later becomes available", async () => {
    rollout("child", [...usage("2026-11-24T12:00:00Z", "old-turn", 110), ...usage("2026-11-24T12:01:00Z", "fresh", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(2);
    expect(s.scanning().caughtUp).toBe(true);
    const orphan = JSON.parse(readFileSync(join(dir, "state", "cache-ledger.json"), "utf8"));
    expect(orphan.files[join(dir, "sessions", "child.jsonl")].orphaned).toBe(true);
    rollout("parent", usage("2026-11-22T12:00:00Z", "old-turn", 110));
    await s.kick();
    expect(await requests(s, "24h")).toBe(1);
    expect(await requests(s, "7d")).toBe(2);
    expect(s.scanning().caughtUp).toBe(true);
  });

  it("finds an archived ancestor outside the mtime window and uses its original dates", async () => {
    const parent = rollout("parent", usage("2026-09-01T12:00:00Z", "shared", 110));
    mkdirSync(join(dir, "archived_sessions"));
    const archived = join(dir, "archived_sessions", "parent.jsonl");
    renameSync(parent, archived); utimesSync(archived, new Date("2026-09-01"), new Date("2026-09-01"));
    rollout("child", [...usage("2026-11-24T12:00:00Z", "shared", 110), ...usage("2026-11-24T12:01:00Z", "fresh", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(1);
    expect(await requests(s, "7d")).toBe(1);
    expect(s.scanning().caughtUp).toBe(true);
  });

  it("counts recent owned archived records once as well as the fresh child turn", async () => {
    const parent = rollout("parent", usage("2026-11-22T12:00:00Z", "shared", 110));
    mkdirSync(join(dir, "archived_sessions")); renameSync(parent, join(dir, "archived_sessions", "parent.jsonl"));
    rollout("child", [...usage("2026-11-24T12:00:00Z", "shared", 110), ...usage("2026-11-24T12:01:00Z", "fresh", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(1);
    expect(await requests(s, "7d")).toBe(2);
  });

  it("transfers a legacy archive move by inode, preserving its offset across restart and append", async () => {
    const legacy = (at: string, total: number) => usage(at, "unused", total).filter(row => row.type !== "turn_context");
    const parent = rollout("legacy", [...legacy("2026-11-24T11:00:00Z", 110), ...legacy("2026-11-24T11:01:00Z", 220)]);
    const a = make(); await a.kick(); expect(await requests(a, "24h")).toBe(2);
    mkdirSync(join(dir, "archived_sessions")); const archived = join(dir, "archived_sessions", "legacy.jsonl");
    renameSync(parent, archived); await a.kick();
    expect(await requests(a, "24h")).toBe(2);
    a.stop(); const b = make(); await b.kick();
    expect(await requests(b, "24h")).toBe(2);
    appendFileSync(archived, legacy("2026-11-24T11:02:00Z", 330).map(r => JSON.stringify(r)).join("\n") + "\n");
    await b.kick(); expect(await requests(b, "24h")).toBe(3);
  });

  it("does not load metadata for unrelated historical rollouts", async () => {
    const unrelated = rollout("unrelated-old", usage("2026-09-01T12:00:00Z", "unrelated", 110));
    utimesSync(unrelated, new Date("2026-09-01"), new Date("2026-09-01"));
    rollout("current", usage("2026-11-24T12:00:00Z", "current", 110));
    const s = make(); await s.kick(); await s.kick();
    const metadata = JSON.parse(readFileSync(join(dir, "rollouts.json"), "utf8"));
    expect(metadata[unrelated]).toBeUndefined();
    expect(await requests(s, "24h")).toBe(1);
  });

  it("preserves the existing fleet caught-up behavior for an unreadable non-Codex store", async () => {
    const notDirectory = join(dir, "not-directory"); writeFileSync(notDirectory, "fixture");
    const s = make({
      instances: () => [{ name: "other", backend: "grok", workingDirectory: dir, ledgerPath: join(dir, "state", "grok.json") }],
      grokSessionsDir: () => notDirectory,
    });
    await s.kick();
    expect(s.scanning().caughtUp).toBe(true);
    expect((await s.usageData()).instances[0]!.days.coverage).toEqual([]);
  });

  it("does not charge another workspace's ancestor to the child's workspace", async () => {
    const parent = rollout("parent", usage("2026-11-24T11:00:00Z", "old-turn", 110));
    writeFileSync(parent, readFileSync(parent, "utf8").replace(JSON.stringify(dir), JSON.stringify(join(dir, "other-workspace"))));
    rollout("child", [...usage("2026-11-24T12:00:00Z", "old-turn", 110), ...usage("2026-11-24T12:01:00Z", "new-turn", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(1);
  });

  it("repairs inflated v2 totals in a durable candidate, preserving published totals until complete and other readers", async () => {
    const parent = rollout("parent", usage("2026-11-24T11:00:00Z", "shared", 110));
    rollout("child", [...usage("2026-11-24T12:00:00Z", "shared", 110), ...usage("2026-11-24T12:01:00Z", "fresh", 220)], "parent");
    const old = emptyLedger();
    const cur: FileCursor = { kind: "codex", ino: 1, offset: 0 };
    const turn = { t: NOW - 1000, model: "gpt-5.5", prompt: 100, uncached: 60, read: 40, write5m: 0, write1h: 0, write: null, output: 10 };
    for (let n = 0; n < 8; n++) addTurn(old, cur, turn, 0);
    addTurn(old, { kind: "claude", ino: 2, offset: 0 }, { ...turn, model: "claude-sonnet-4-5" }, 0);
    old.files[parent] = cur;
    mkdirSync(join(dir, "state"));
    writeFileSync(join(dir, "state", "cache-ledger.json"), JSON.stringify(old));
    const a = make({ passBytes: 128 });
    expect(await a.pass()).toBeGreaterThan(0);
    expect(await requests(a, "24h")).toBe(9);
    const pending = JSON.parse(readFileSync(join(dir, "state", "cache-ledger.json"), "utf8"));
    expect(pending.codexRebuild).toBeDefined();
    expect(pending.codexMethod).toBeUndefined();
    a.stop();
    const b = make({ passBytes: 128, pauseMs: 0 }); await b.kick();
    expect(await requests(b, "24h")).toBe(3); // Two unique Codex requests plus untouched Claude history.
    const repaired = JSON.parse(readFileSync(join(dir, "state", "cache-ledger.json"), "utf8"));
    expect(repaired.codexMethod).toBe(1);
    expect(repaired.codexRebuild).toBeUndefined();
    expect(Object.keys(repaired.codexEvents)).toHaveLength(2);
    b.stop();
    const c = make(); await c.kick();
    expect(await requests(c, "24h")).toBe(3);
  });

  it("rejects cyclic ancestry without spinning or publishing a guessed count", async () => {
    rollout("a", usage("2026-11-24T12:00:00Z", "a-turn", 110), "b");
    rollout("b", usage("2026-11-24T12:00:00Z", "b-turn", 110), "a");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(0);
    expect(s.scanning().caughtUp).toBe(false);
  });

  it("does not spin on an ancestor's unfinished last line", async () => {
    const parent = rollout("parent", usage("2026-11-24T11:00:00Z", "shared", 110));
    appendFileSync(parent, '{"type":');
    rollout("child", [...usage("2026-11-24T12:00:00Z", "shared", 110), ...usage("2026-11-24T12:01:00Z", "fresh", 220)], "parent");
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(2);
    expect(s.scanning().caughtUp).toBe(true);
  });

  it.each([false, true])("keeps unavailable recent accounting with other sources present=%s", async hasAvailable => {
    const old = emptyLedger();
    const cur: FileCursor = { kind: "codex", ino: 1, offset: 0 };
    addTurn(old, cur, { t: NOW - 1000, model: "gpt-5.5", prompt: 100, uncached: 100, read: 0, write5m: 0, write1h: 0, write: null, output: 10 }, 0);
    old.files[join(dir, "sessions", "unavailable.jsonl")] = cur;
    if (hasAvailable) {
      const available = rollout("available", usage("2026-11-24T11:00:00Z", "available", 110));
      const other: FileCursor = { kind: "codex", ino: statSync(available).ino, offset: 0 };
      addTurn(old, other, { t: NOW - 1000, model: "gpt-5.5", prompt: 100, uncached: 100, read: 0, write5m: 0, write1h: 0, write: null, output: 10 }, 0);
      old.files[available] = other;
    }
    mkdirSync(join(dir, "state"));
    writeFileSync(join(dir, "state", "cache-ledger.json"), JSON.stringify(old));
    const s = make(); await s.kick();
    expect(await requests(s, "24h")).toBe(hasAvailable ? 2 : 1);
    expect(s.scanning().caughtUp).toBe(false);
  });

  it("preserves old hours awaiting durable rollup and never mutates the published generation", () => {
    const old = emptyLedger();
    const cur: FileCursor = { kind: "codex", ino: 1, offset: 0 };
    addTurn(old, cur, { t: NOW - 40 * 86400000, model: "gpt-5.5", prompt: 100, uncached: 100, read: 0, write5m: 0, write1h: 0, write: null, output: 10 }, 0);
    const snapshot = JSON.stringify(old);
    const candidate = codexRebuild(old, NOW - 31 * 86400000);
    expect(candidate.hours).toEqual(old.hours);
    expect(JSON.stringify(old)).toBe(snapshot);
  });

  it("retains untagged mixed-reader gaps without adding historical Codex gaps twice, then records new gaps", () => {
    const old = emptyLedger();
    const cur: FileCursor = { kind: "codex", ino: 1, offset: 0 };
    const turn = { t: NOW - 10000, model: "gpt-5.5", prompt: 100, uncached: 100, read: 0, write5m: 0, write1h: 0, write: null, output: 10 };
    addTurn(old, cur, turn, 0); addTurn(old, cur, { ...turn, t: NOW - 1000 }, 0);
    addTurn(old, { kind: "claude", ino: 2, offset: 0 }, { ...turn, model: "claude-sonnet-4-5" }, 0);
    const candidate = codexRebuild(old, NOW - 31 * 86400000);
    const rebuilt: FileCursor = { kind: "codex", ino: 1, offset: 0 };
    const gaps = () => Object.values(candidate.hours).reduce((n, h) => n + h.g.reduce((a, b) => a + b, 0), 0);
    expect(gaps()).toBe(1);
    addTurn(candidate, rebuilt, turn, 0); addTurn(candidate, rebuilt, { ...turn, t: NOW - 1000 }, 0);
    expect(gaps()).toBe(1);
    addTurn(candidate, rebuilt, { ...turn, t: NOW + 1000 }, 0);
    expect(gaps()).toBe(2);
  });

  it("suppresses replayed speed samples and gaps while retaining the inherited session point", async () => {
    const response = (turn: string, total: number, at: number) => {
      const stamp = new Date(at + 1100).toISOString();
      const [context, count] = usage(stamp, turn, total);
      return [context,
        { timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: turn } },
        { timestamp: stamp, type: "event_msg", payload: { type: "item_completed", turn_id: turn, started_at_ms: at, completed_at_ms: at + 1000, item: { type: "AgentMessage", id: "fixture" } } },
        { timestamp: stamp, type: "token_usage_record", payload: { turn_id: turn, usage: { input_tokens: 100, output_tokens: 10 } } },
        count,
        { timestamp: stamp, type: "event_msg", payload: { type: "task_complete", turn_id: turn } },
      ];
    };
    const at = Date.parse("2026-11-24T11:00:00Z");
    rollout("parent", response("shared", 110, at));
    rollout("child", [...response("shared", 110, at + 60000), ...response("fresh", 220, at + 120000)], "parent");
    const s = make(); await s.kick();
    const ledger = JSON.parse(readFileSync(join(dir, "state", "cache-ledger.json"), "utf8"));
    const hours = Object.values(ledger.hours) as Array<{ sp?: Record<string, Record<string, number[]>>; g: number[] }>;
    const samples = hours.flatMap(h => Object.values(h.sp ?? {}).flatMap(models => Object.values(models)));
    expect(samples.reduce((n, a) => n + a[2]!, 0)).toBe(2);
    expect(hours.reduce((n, h) => n + h.g.reduce((a, b) => a + b, 0), 0)).toBe(1);
    expect(await requests(s, "24h")).toBe(2);
  });
});
