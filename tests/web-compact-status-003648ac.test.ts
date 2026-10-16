/**
 * Board 003648ac: a /compact sent from the web chat is followed to its end.
 * - The record: Claude Code's `system` `compact_boundary` (the real record's shape, as written to a session JSONL) and
 *   Codex's `compacted`; a long record by its head only.
 * - The watch: from the transcript's end just before the command, so an older boundary never counts; a new file, a
 *   replaced or shortened one starts again at its end; done, or timed out; one per instance.
 * - The wiring: the watch begins just before the paste and only when the command goes; the status frame carries it.
 */
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACT_WATCH_KEEP_MS, COMPACT_WATCH_POLL_MS, COMPACT_WATCH_TIMEOUT_MS, CompactWatch, isCompactionRecord,
} from "../src/compact-watch.js";
import { TopicCommands } from "../src/topic-commands.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-compact-")); dirs.push(d); return d; };

// A Claude Code compact_boundary as the CLI writes it (fields and order from a real session JSONL, ids shortened).
const CLAUDE_BOUNDARY = JSON.stringify({
  parentUuid: null, logicalParentUuid: "3c2ae4cb", isSidechain: false, type: "system", subtype: "compact_boundary",
  content: "Conversation compacted", level: "info",
  compactMetadata: { trigger: "manual", preTokens: 180000, postTokens: 14885, durationMs: 41000 }, timestamp: "2026-10-16T02:00:00.000Z",
});
const CLAUDE_TURN = JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 10, isSidechain: false });
const CODEX_COMPACTED = JSON.stringify({ timestamp: "2026-10-16T02:00:00.000Z", type: "compacted", payload: { message: "summary" } });

describe("the record that says a conversation was compacted", () => {
  it("claude: system compact_boundary, not in a sidechain; nothing else", () => {
    expect(isCompactionRecord("claude", CLAUDE_BOUNDARY)).toBe(true);
    expect(isCompactionRecord("claude", CLAUDE_BOUNDARY.replace('"isSidechain":false', '"isSidechain":true'))).toBe(false);
    expect(isCompactionRecord("claude", CLAUDE_TURN)).toBe(false);
    expect(isCompactionRecord("claude", JSON.stringify({ type: "user", subtype: "compact_boundary" }))).toBe(false);
    expect(isCompactionRecord("claude", CODEX_COMPACTED)).toBe(false);
    for (const bad of ["", "{", "null", "[]", "\"compact_boundary\""]) expect(isCompactionRecord("claude", bad), bad).toBe(false);
  });
  it("codex: a compacted record; an event or response that only mentions it is not", () => {
    expect(isCompactionRecord("codex", CODEX_COMPACTED)).toBe(true);
    expect(isCompactionRecord("codex", JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "compacted" } }))).toBe(false);
    expect(isCompactionRecord("codex", CLAUDE_BOUNDARY)).toBe(false);
  });
  it("a record too long to parse: by its head, only as that record starts", () => {
    const long = (head: string) => ({ at: 0, head, bytes: 9e6, complete: true, offset: 0 });
    expect(isCompactionRecord("claude", long(CLAUDE_BOUNDARY.slice(0, 160)))).toBe(true);
    expect(isCompactionRecord("claude", long('{"parentUuid":null,"isSidechain":true,"type":"system","subtype":"compact_boundary"'))).toBe(false);
    expect(isCompactionRecord("claude", long('{"type":"user","message":{"content":"x \\"type\\":\\"system\\",\\"subtype\\":\\"compact_boundary\\""'))).toBe(false);
    expect(isCompactionRecord("codex", long('{"timestamp":"2026-10-16T02:00:00.000Z","type":"compacted","payload":{"replacement_history":['))).toBe(true);
    expect(isCompactionRecord("codex", long('{"timestamp":"2026-10-16T02:00:00.000Z","type":"response_item","payload":{"type":"compacted"'))).toBe(false);
  });
});

function rig(format: "claude" | "codex" | null = "claude") {
  const dir = tmp();
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${CLAUDE_TURN}\n${CLAUDE_BOUNDARY}\n`);       // a boundary from before: never counts
  let clock = 1000;
  const src = { path: file as string | null, format };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const changed = vi.fn();
  const watch = new CompactWatch({
    source: () => ({ ...src }), changed, now: () => clock,
    setInterval: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearInterval: (h) => { timers.delete(h as number); },
  });
  return { dir, file, src, watch, changed, timers, tick: (ms: number) => { clock += ms; } };
}

describe("following one /compact", () => {
  it("no transcript AgEnD reads (other backends), or none yet: not followed", () => {
    expect(rig(null).watch.begin("w")).toBeNull();
    const r = rig();
    r.src.path = null;
    expect(r.watch.begin("w")).toBeNull();
    r.src.path = join(r.dir, "missing.jsonl");
    expect(r.watch.begin("w")).toBeNull();
    expect(r.timers.size).toBe(0);
  });

  it("only a boundary written after it began: running, then done once, then gone from view after a while", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect([...r.timers.values()].map(t => t.ms)).toEqual([COMPACT_WATCH_POLL_MS]);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "running" });
    appendFileSync(r.file, `${CLAUDE_TURN}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "running" });
    appendFileSync(r.file, CLAUDE_BOUNDARY);                               // not yet a whole line
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(r.file, "\n");
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "done" });
    expect(r.changed).toHaveBeenCalledTimes(1);
    expect(r.timers.size).toBe(0);
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.changed).toHaveBeenCalledTimes(1);
    r.tick(COMPACT_WATCH_KEEP_MS - 1);
    expect(r.watch.view("w")!.state).toBe("done");
    r.tick(1);
    expect(r.watch.view("w")).toBeNull();
  });

  it("codex: its compacted record", async () => {
    const r = rig("codex");
    const id = r.watch.begin("w")!;
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(r.file, `${CODEX_COMPACTED}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("no boundary in time: timed out, said once; a boundary after that changes nothing", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    r.tick(COMPACT_WATCH_TIMEOUT_MS - 1);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    r.tick(1);
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "timeout" });
    expect(r.changed).toHaveBeenCalledTimes(1);
    expect(r.timers.size).toBe(0);
  });

  it("another transcript, or this one replaced or cut short: from its end — an older boundary there is never taken", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    const other = join(r.dir, "next.jsonl");
    writeFileSync(other, `${CLAUDE_BOUNDARY}\n`);
    r.src.path = other;
    await r.watch.poll("w", id);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(other, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");

    const cut = rig();
    const cid = cut.watch.begin("w")!;
    writeFileSync(cut.file, `${CLAUDE_BOUNDARY}\n`);                       // shorter than where the watch began
    await cut.watch.poll("w", cid);
    await cut.watch.poll("w", cid);
    expect(cut.watch.view("w")!.state).toBe("running");
    appendFileSync(cut.file, `${CLAUDE_BOUNDARY}\n`);                      // from its new end: this one counts
    await cut.watch.poll("w", cid);
    expect(cut.watch.view("w")!.state).toBe("done");

    const replaced = rig();
    const rid = replaced.watch.begin("w")!;
    const next = join(replaced.dir, "replacement.jsonl");
    // Longer, with its boundary wholly past where the old file ended; written while the old one still exists.
    writeFileSync(next, `${`${CLAUDE_TURN}\n`.repeat(8)}${CLAUDE_BOUNDARY}\n`);
    renameSync(next, replaced.file);                                         // so another inode at the same path
    await replaced.watch.poll("w", rid);
    await replaced.watch.poll("w", rid);
    expect(replaced.watch.view("w")!.state).toBe("running");
  });

  it("a boundary record too long to read whole is still seen, by its head", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    const long = JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted",
      compactMetadata: { preservedMessages: { uuids: Array.from({ length: 12000 }, (_, i) => `uuid-${i}-${"x".repeat(20)}`) } } });
    expect(long.length).toBeGreaterThan(256 * 1024);
    appendFileSync(r.file, `${long}\n`);
    for (let i = 0; i < 3 && r.watch.view("w")!.state === "running"; i++) await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("one per instance: a new /compact replaces the last; a command that did not go is forgotten; stopAll ends them", async () => {
    const r = rig();
    const first = r.watch.begin("w")!;
    const second = r.watch.begin("w")!;
    expect(second).not.toBe(first);
    expect(r.timers.size).toBe(1);
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", first);
    expect(r.watch.view("w")).toEqual({ id: second, state: "running" });
    r.watch.cancel("w", first);
    expect(r.watch.view("w")!.id).toBe(second);
    r.watch.cancel("w", second);
    expect(r.watch.view("w")).toBeNull();
    expect(r.timers.size).toBe(0);
    r.watch.begin("w"); r.watch.begin("v");
    expect(r.timers.size).toBe(2);
    r.watch.forget("v");
    expect(r.timers.size).toBe(1);
    r.watch.stopAll();
    expect(r.timers.size).toBe(0);
    expect(r.watch.view("w")).toBeNull();
  });

  it("the timer drives it", async () => {
    const r = rig();
    r.watch.begin("w");
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    for (const t of [...r.timers.values()]) t.fn();
    await vi.waitFor(() => expect(r.watch.view("w")!.state).toBe("done"));
  });
});

describe("the wiring", () => {
  function topic(connected = true) {
    const order: string[] = [];
    const commands = new TopicCommands({
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { w: { backend: "claude-code" } } },
      instanceIpcClients: new Map([["w", { connected, send: (m: { content: string }) => order.push(`paste ${m.content}`) }]]),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any);
    return { commands, order };
  }

  it("the watch begins just before the paste, and only when the command goes", () => {
    setLocale("en");
    const t = topic();
    expect(t.commands.compactInstance("w", undefined, () => t.order.push("begin"))).toEqual({ sent: true, text: expect.stringContaining("/compact") });
    expect(t.order).toEqual(["begin", "paste /compact"]);
    const off = topic(false);
    expect(off.commands.compactInstance("w", undefined, () => off.order.push("begin")).sent).toBe(false);
    const long = topic();
    expect(long.commands.compactInstance("w", "x".repeat(5000), () => long.order.push("begin")).sent).toBe(false);
    expect([...off.order, ...long.order]).toEqual([]);
  });

  function fleet(compactInstance: (n: string, i: string | undefined, before: () => void) => { sent: boolean; text: string }) {
    const f: any = Object.create(FleetManager.prototype);
    Object.assign(f, {
      fleetConfig: { instances: { w: { working_directory: "/w" } } }, classicChannels: null,
      compactWatchService: { begin: vi.fn(() => "0123456789abcdef"), cancel: vi.fn() },
      topicCommands: { compactInstance: vi.fn(compactInstance) },
    });
    return f;
  }

  it("FleetManager.webCommand: the follow id of a sent /compact; none, and no watch kept, when it did not go", async () => {
    const sent = fleet((_n, _i, before) => { before(); return { sent: true, text: "sent" }; });
    expect(await sent.webCommand({ instance: "w", command: "compact" }, { publicLink: false }))
      .toEqual({ status: 200, body: { text: "sent", follow: { kind: "compact", id: "0123456789abcdef" } } });
    expect(sent.compactWatchService.begin).toHaveBeenCalledWith("w");
    const refused = fleet(() => ({ sent: false, text: "not connected" }));
    expect(await refused.webCommand({ instance: "w", command: "compact" }, { publicLink: false })).toEqual({ status: 409, body: { error: "not connected" } });
    expect(refused.compactWatchService.begin).not.toHaveBeenCalled();
    const throws = fleet((_n, _i, before) => { before(); throw new Error("ipc"); });
    await expect(throws.webCommand({ instance: "w", command: "compact" }, { publicLink: false })).rejects.toThrow("ipc");
    expect(throws.compactWatchService.cancel).toHaveBeenCalledWith("w", "0123456789abcdef");
  });

  it("the status frame carries the instance's last /compact, and only its own", () => {
    const fm = new FleetManager(tmp());
    fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: { w: { working_directory: "/tmp" }, v: { working_directory: "/tmp" } } } as any;
    (fm as any).compactWatchService = { view: (n: string) => (n === "w" ? { id: "0123456789abcdef", state: "done" } : null) };
    const ui = fm.getUiStatus() as { instances: Array<{ name: string; compact?: unknown }> };
    expect(ui.instances.find(i => i.name === "w")!.compact).toEqual({ id: "0123456789abcdef", state: "done" });
    expect(ui.instances.find(i => i.name === "v")).not.toHaveProperty("compact");
  });
});
