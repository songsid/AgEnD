/**
 * Board 003648ac (kiro, the user's case): a web /compact on kiro is followed to its end by what kiro itself records
 * (tests/fixtures/kiro-2.30.0-compact, captured from the real 2.30.0 in a private tmux):
 * - TUI V2: a top-level `Compaction` record in the session log. Its snapshot of old messages is not new tool activity.
 * - Classic V1: a summary the store's row did not carry before — on a new row for a conversation created since the
 *   monitor started, or on the same row. An older conversation selected by --resume, with its own summary, is not one.
 * - The daemon reports it (transcript_compacted); the watch for that instance, once its paste was written under the
 *   same daemon, is done. V3 and other backends record nothing AgEnD sees: not followed.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiroDbReader, kiroSummaryMarker } from "../src/kiro-db-reader.js";
import { KiroSessionSource, type TranscriptEvents, type TranscriptSource } from "../src/transcript-sources.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { CompactWatch } from "../src/compact-watch.js";

const FX = new URL("./fixtures/kiro-2.30.0-compact/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FX), "utf8");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-kiro-compact-")); dirs.push(d); return d; };

describe("what kiro-cli 2.30.0 shows and records (the saved captures)", () => {
  it("TUI: 'Compacting conversation...' on the pane; one top-level Compaction record in the session log", () => {
    expect(fixture("tui-v2-compacting.pane.txt")).toContain("• Compacting conversation...");
    const kinds = fixture("tui-v2-session.jsonl").trim().split("\n").map(l => JSON.parse(l).kind);
    expect(kinds).toEqual(["Prompt", "AssistantMessage", "Prompt", "AssistantMessage", "Compaction"]);
  });
  it("classic: 'Creating summary...'; a new conversation row whose latest_summary was null before", () => {
    expect(fixture("classic-v1-compacting.pane.txt")).toContain("Creating summary...");
    expect(fixture("classic-v1-compacted.pane.txt")).toContain("The conversation history has been replaced with this summary.");
    const { rows } = JSON.parse(fixture("classic-v1-rows.json"));
    expect(rows.map((r: any) => [r.value.history.length, r.value.latest_summary === null])).toEqual([[2, true], [2, false]]);
    expect(rows[0].conversation_id).not.toBe(rows[1].conversation_id);
    expect(kiroSummaryMarker(rows[0].value.latest_summary)).toBeNull();
    expect(kiroSummaryMarker(rows[1].value.latest_summary)).toBe(`r:${rows[1].value.latest_summary[1].request_id}`);
    expect(kiroSummaryMarker(["text only"])).toMatch(/^h:[0-9a-f]{32}$/);
    expect(kiroSummaryMarker(undefined)).toBeNull();
  });
});

describe("the TUI session log: its Compaction record", () => {
  function session(lines: string[]) {
    const root = tmp(), sessionsDir = join(root, "sessions"), work = join(root, "work");
    mkdirSync(sessionsDir, { recursive: true }); mkdirSync(work);
    const now = new Date().toISOString();
    writeFileSync(join(sessionsDir, "s1.json"), JSON.stringify({ session_id: "s1", cwd: work, created_at: now, updated_at: now }));
    const jsonl = join(sessionsDir, "s1.jsonl");
    writeFileSync(jsonl, lines.map(l => `${l}\n`).join(""));
    const source = new KiroSessionSource(work, sessionsDir, Date.now() - 1000, join(root, "no-store.sqlite3"));
    return { source, jsonl };
  }
  const snapshotWithTool = JSON.stringify({ version: "v1", kind: "Compaction", data: { summary: "s", strategy: {},
    messages_snapshot: [{ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { toolUseId: "t1", name: "shell", input: { command: "old" } } }] } }] } });

  it("the real record counts as one compaction; the prompts before it as none", async () => {
    const { source } = session(fixture("tui-v2-session.jsonl").trim().split("\n"));
    const events = await source.poll();
    expect(events.compacted).toBe(1);
    source.close();
  });

  it("its snapshot of old messages is history, not new tool activity; a later live tool call still is", async () => {
    const { source, jsonl } = session([snapshotWithTool]);
    const first = await source.poll();
    expect([first.compacted, first.toolUses.length]).toEqual([1, 0]);
    appendFileSync(jsonl, `${JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { toolUseId: "t2", name: "shell", input: { command: "new" } } }] } })}\n`);
    const second = await source.poll();
    expect([second.compacted ?? 0, second.toolUses.map(u => (u.input as { command: string }).command)]).toEqual([0, ["new"]]);
    source.close();
  });

  it("a Compaction kind only nested inside another record is not one", async () => {
    const { source } = session([JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "Compaction" }] } })]);
    expect((await source.poll()).compacted ?? 0).toBe(0);
    source.close();
  });
});

describe("the classic store: a summary it did not carry before", () => {
  const { rows, key: fixtureKey } = JSON.parse(fixture("classic-v1-rows.json")) as { key: string; rows: Array<{ conversation_id: string; created_at: number; updated_at: number; value: Record<string, unknown> }> };
  function store() {
    const root = tmp(), dbPath = join(root, "data.sqlite3"), work = join(root, "work");
    mkdirSync(work);
    const db = new Database(dbPath);
    db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
    const put = (r: typeof rows[number], over: Partial<typeof rows[number]> = {}) => {
      const x = { ...r, ...over };
      db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, ?, ?)").run(work, x.conversation_id, JSON.stringify(x.value).split(fixtureKey).join(work), x.created_at, x.updated_at);
    };
    dirs.push(root);
    return { db, dbPath, work, put };
  }
  const [before, after] = rows as [typeof rows[number], typeof rows[number]];

  it("the real classic /compact: a new row since the monitor started, with a summary — one compaction, said once", () => {
    const s = store();
    s.put(before);
    const reader = new KiroDbReader(s.work, s.dbPath, before.updated_at + 1000);
    expect(reader.read()).toEqual({ toolUses: [], toolResults: [], assistantTexts: [] });
    s.put(after);
    expect(reader.read()!.compacted).toBe(1);
    s.put(after, { updated_at: after.updated_at + 5, value: { ...after.value, history: [...(after.value.history as unknown[]), (after.value.history as unknown[])[1]] } });
    expect(reader.read()!.compacted ?? 0).toBe(0);
    reader.close(); s.db.close();
  });

  it("the same conversation gaining or changing its summary is one; an older conversation resumed with its own is not", () => {
    const s = store();
    s.put(before);
    const reader = new KiroDbReader(s.work, s.dbPath, before.updated_at + 1000);
    s.put(before, { updated_at: before.updated_at + 2000, value: { ...before.value, latest_summary: after.value.latest_summary } });
    expect(reader.read()!.compacted).toBe(1);
    s.put(after, { conversation_id: "older-resumed", created_at: before.created_at - 60_000, updated_at: before.updated_at + 4000,
      value: { ...after.value, latest_summary: ["another", { request_id: "other-request" }] } });
    expect(reader.read()!.compacted ?? 0).toBe(0);
    reader.close(); s.db.close();
  });

  it("a conversation already summarized when the monitor starts: a new turn is not a compaction; a summary going away is not one", () => {
    const s = store();
    s.put(after, { created_at: before.created_at - 60_000 });
    const reader = new KiroDbReader(s.work, s.dbPath, after.updated_at + 1000);
    s.put(after, { created_at: before.created_at - 60_000, updated_at: after.updated_at + 2000, value: { ...after.value, history: [...(after.value.history as unknown[]), (after.value.history as unknown[])[1]] } });
    expect(reader.read()!.compacted ?? 0).toBe(0);
    s.put(after, { created_at: before.created_at - 60_000, updated_at: after.updated_at + 3000, value: { ...after.value, latest_summary: null } });
    expect(reader.read()!.compacted ?? 0).toBe(0);
    reader.close(); s.db.close();
  });

  it("history replaced by a shorter one together with a new summary (same conversation): one compaction", () => {
    const s = store();
    const longer = { ...before.value, history: [...(before.value.history as unknown[]), ...(before.value.history as unknown[])] };
    s.put(before, { value: longer });
    const reader = new KiroDbReader(s.work, s.dbPath, before.updated_at + 1000);
    s.put(before, { updated_at: before.updated_at + 2000, value: { ...before.value, history: [(before.value.history as unknown[])[0]], latest_summary: after.value.latest_summary } });
    expect(reader.read()).toEqual({ toolUses: [], toolResults: [], assistantTexts: [], compacted: 1 });
    reader.close(); s.db.close();
  });

  it("the summary seen survives the worker's cursor (restore after a recycle does not re-announce it)", () => {
    const s = store();
    s.put(before);
    const reader = new KiroDbReader(s.work, s.dbPath, before.updated_at + 1000);
    s.put(after);
    expect(reader.read()!.compacted).toBe(1);
    const cursor = reader.cursor();
    expect(cursor.summary).toBe(kiroSummaryMarker(after.value.latest_summary));
    const recycled = new KiroDbReader(s.work, s.dbPath, before.updated_at + 1000, false);
    recycled.restore(cursor);
    s.put(after, { updated_at: after.updated_at + 9 });
    expect(recycled.read()!.compacted ?? 0).toBe(0);
    reader.close(); recycled.close(); s.db.close();
  });
});

describe("the monitor and the watch", () => {
  it("the monitor emits 'compacted' for a source that reports it", async () => {
    const batches: TranscriptEvents[] = [{ toolUses: [], toolResults: [], assistantTexts: [], compacted: 1 }, { toolUses: [], toolResults: [], assistantTexts: [] }];
    const source = { poll: async () => batches.shift() ?? { toolUses: [], toolResults: [], assistantTexts: [] }, reset() {}, close() {} } as unknown as TranscriptSource;
    const monitor = new TranscriptMonitor(tmp(), { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any, source);
    const seen = vi.fn();
    monitor.on("compacted", seen);
    await monitor.pollIncrement(); await monitor.pollIncrement();
    expect(seen.mock.calls).toEqual([[1]]);
  });

  function rig(signals: boolean) {
    const daemon = { current: {} as unknown };
    const changed = vi.fn();
    const watch = new CompactWatch({
      source: () => ({ path: null, format: null }), owner: () => daemon.current, signals: () => signals, changed, now: () => 0,
      setInterval: () => 1, clearInterval: () => {},
    });
    return { watch, daemon, changed };
  }

  it("kiro (no transcript here, but a daemon that reports): followed; done by the daemon's report after the paste was written", async () => {
    const r = rig(true);
    const id = r.watch.begin("k")!;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    r.watch.signal("k");                                                   // still queued: an earlier compaction, not ours
    expect(r.watch.view("k")!.state).toBe("running");
    r.watch.pasted("k", id, true);
    await r.watch.poll("k", id);
    expect(r.watch.view("k")!.state).toBe("running");
    r.watch.signal("v");
    expect(r.watch.view("k")!.state).toBe("running");
    r.watch.signal("k");
    expect(r.watch.view("k")).toEqual({ id, state: "done" });
    expect(r.changed).toHaveBeenCalledTimes(1);
  });

  it("another daemon by the report, or by a look: lost; nobody running it when written: lost", async () => {
    const relaunched = rig(true);
    const a = relaunched.watch.begin("k")!; relaunched.watch.pasted("k", a, true);
    relaunched.daemon.current = {};
    relaunched.watch.signal("k");
    expect(relaunched.watch.view("k")!.state).toBe("lost");
    const looked = rig(true);
    const b = looked.watch.begin("k")!; looked.watch.pasted("k", b, true);
    looked.daemon.current = null;
    await looked.watch.poll("k", b);
    expect(looked.watch.view("k")!.state).toBe("lost");
    const gone = rig(true);
    const c = gone.watch.begin("k")!;
    gone.daemon.current = null;
    gone.watch.pasted("k", c, true);
    expect(gone.watch.view("k")!.state).toBe("lost");
  });

  it("a backend that neither writes a transcript here nor reports (kiro V3, others): not followed", () => {
    expect(rig(false).watch.begin("k")).toBeNull();
  });

  it("a transcript watch is not ended by a report", async () => {
    const root = tmp(), file = join(root, "s.jsonl");
    writeFileSync(file, "");
    const watch = new CompactWatch({ source: () => ({ path: file, format: "claude" }), owner: () => "d", signals: () => true, changed: () => {}, setInterval: () => 1, clearInterval: () => {} });
    const id = watch.begin("w")!;
    watch.pasted("w", id, true);
    watch.signal("w");
    expect(watch.view("w")!.state).toBe("running");
  });
});
