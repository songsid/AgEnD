/**
 * Board 003648ac: a /compact sent from the web chat is followed to its end.
 * - The record: Claude Code's `system` `compact_boundary` (the real record's shape, as written to a session JSONL) and
 *   Codex's `compacted`, by their own top-level fields only; a long record is read whole, never judged by its head.
 * - The start: when the daemon says the paste was written (raw_paste_written), not when it was queued; a paste that
 *   never reached the pane ends the watch as lost.
 * - The watch: from the transcript's end then; one opened file per look (another file at the path, or this one cut
 *   short, starts again at its end); the same daemon and format throughout, else lost; done, or timed out.
 * - The wiring: a write the IPC refuses is not sent (and its watch dropped); the status frame carries the watch.
 */
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Review P2-2: a hook that runs inside a look, just before its read — to move another file onto the path.
const hooks = vi.hoisted(() => ({ beforeRead: null as null | (() => void), beforeWhole: null as null | (() => void) }));
vi.mock("../src/transcript-jsonl.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/transcript-jsonl.js")>();
  return {
    ...real,
    readNewLines: (...args: Parameters<typeof real.readNewLines>) => { const h = hooks.beforeRead; hooks.beforeRead = null; h?.(); return real.readNewLines(...args); },
    readWholeLine: (...args: Parameters<typeof real.readWholeLine>) => { const h = hooks.beforeWhole; hooks.beforeWhole = null; h?.(); return real.readWholeLine(...args); },
  };
});

const {
  COMPACT_WATCH_KEEP_MS, COMPACT_WATCH_POLL_MS, COMPACT_WATCH_TIMEOUT_MS, CompactWatch, isCompactionRecord,
} = await import("../src/compact-watch.js");
const { TopicCommands } = await import("../src/topic-commands.js");
const { FleetManager } = await import("../src/fleet-manager.js");
const { Daemon } = await import("../src/daemon.js");
const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
const { setLocale } = await import("../src/locale.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); hooks.beforeRead = null; hooks.beforeWhole = null; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-compact-")); dirs.push(d); return d; };

// A Claude Code compact_boundary as the CLI writes it (fields and order from a real session JSONL, ids shortened).
const CLAUDE_BOUNDARY = JSON.stringify({
  parentUuid: null, logicalParentUuid: "3c2ae4cb", isSidechain: false, type: "system", subtype: "compact_boundary",
  content: "Conversation compacted", level: "info",
  compactMetadata: { trigger: "manual", preTokens: 180000, postTokens: 14885, durationMs: 41000 }, timestamp: "2026-10-16T02:00:00.000Z",
});
const CLAUDE_TURN = JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 10, isSidechain: false });
const CODEX_COMPACTED = JSON.stringify({ timestamp: "2026-10-16T02:00:00.000Z", type: "compacted", payload: { message: "summary" } });
/** An assistant tool call whose input holds a boundary-looking object (review P2-1); `pad` makes it a long record. */
const nestedBoundary = (pad = 0) => JSON.stringify({
  parentUuid: "p", isSidechain: false, type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { type: "system", subtype: "compact_boundary", padding: "x".repeat(pad) } }] },
});
const LONG = 300 * 1024;

describe("the record that says a conversation was compacted", () => {
  it("claude: a system compact_boundary of its own, not in a sidechain; nothing nested, nothing else", () => {
    expect(isCompactionRecord("claude", CLAUDE_BOUNDARY)).toBe(true);
    expect(isCompactionRecord("claude", CLAUDE_BOUNDARY.replace('"isSidechain":false', '"isSidechain":true'))).toBe(false);
    expect(isCompactionRecord("claude", CLAUDE_TURN)).toBe(false);
    expect(isCompactionRecord("claude", nestedBoundary())).toBe(false);
    expect(isCompactionRecord("claude", JSON.stringify({ type: "user", subtype: "compact_boundary" }))).toBe(false);
    expect(isCompactionRecord("claude", CODEX_COMPACTED)).toBe(false);
    for (const bad of ["", "{", "null", "[]", "\"compact_boundary\""]) expect(isCompactionRecord("claude", bad), bad).toBe(false);
  });
  it("codex: a compacted record; an event or response that only mentions it is not", () => {
    expect(isCompactionRecord("codex", CODEX_COMPACTED)).toBe(true);
    expect(isCompactionRecord("codex", JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "compacted" } }))).toBe(false);
    expect(isCompactionRecord("codex", CLAUDE_BOUNDARY)).toBe(false);
  });
});

function rig(format: "claude" | "codex" | null = "claude") {
  const dir = tmp();
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${CLAUDE_TURN}\n${CLAUDE_BOUNDARY}\n`);       // a boundary from before: never counts
  let clock = 1000;
  const src = { path: file as string | null, format };
  const daemon = { current: {} as unknown };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const changed = vi.fn();
  const watch = new CompactWatch({
    source: () => ({ ...src }), owner: () => daemon.current, changed, now: () => clock,
    setInterval: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearInterval: (h) => { timers.delete(h as number); },
  });
  /** begin, and the daemon's word that the paste was written. */
  const start = () => { const id = watch.begin("w")!; watch.pasted("w", id, true); return id; };
  return { dir, file, src, daemon, watch, changed, timers, start, tick: (ms: number) => { clock += ms; } };
}

describe("following one /compact", () => {
  it("no transcript AgEnD reads (other backends), or none yet: not followed", () => {
    expect(rig(null).watch.begin("w")).toBeNull();
    const r = rig();
    r.src.path = null;
    expect(r.watch.begin("w")).toBeNull();
    expect(r.timers.size).toBe(0);
  });

  it("only a boundary written after the paste reached the pane: running, then done once, then gone from view after a while", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect([...r.timers.values()].map(t => t.ms)).toEqual([COMPACT_WATCH_POLL_MS]);
    // Review P2-5: still queued behind the daemon's lock — a boundary now (an auto-compaction, earlier work) is not ours.
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "running" });
    r.watch.pasted("w", id, true);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")).toEqual({ id, state: "running" });
    appendFileSync(r.file, `${CLAUDE_TURN}\n`);
    await r.watch.poll("w", id);
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
    r.watch.pasted("w", id, false);
    expect(r.changed).toHaveBeenCalledTimes(1);
    r.tick(COMPACT_WATCH_KEEP_MS - 1);
    expect(r.watch.view("w")!.state).toBe("done");
    r.tick(1);
    expect(r.watch.view("w")).toBeNull();
  });

  it("a paste that never reached the pane: lost; a word about another watch changes nothing", async () => {
    const r = rig();
    const id = r.watch.begin("w")!;
    r.watch.pasted("w", "0".repeat(16), true);
    r.watch.pasted("v", id, true);
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    r.watch.pasted("w", id, false);
    expect(r.watch.view("w")).toEqual({ id, state: "lost" });
    expect(r.timers.size).toBe(0);
  });

  it("codex: its compacted record", async () => {
    const r = rig("codex");
    const id = r.start();
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(r.file, `${CODEX_COMPACTED}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("no boundary in time (counted from the command, queued or not): timed out, said once", async () => {
    const queued = rig();
    const qid = queued.watch.begin("w")!;
    queued.tick(COMPACT_WATCH_TIMEOUT_MS);
    await queued.watch.poll("w", qid);
    expect(queued.watch.view("w")!.state).toBe("timeout");

    const r = rig();
    const id = r.start();
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

  it("review P2-1: a long record is read whole — a boundary-looking object nested in a tool call is not one; a long real boundary is", async () => {
    const r = rig();
    const id = r.start();
    const nested = nestedBoundary(LONG);
    expect(nested.length).toBeGreaterThan(256 * 1024);
    appendFileSync(r.file, `${nested}\n`);
    await r.watch.poll("w", id); await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    const long = JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted",
      compactMetadata: { preservedMessages: { uuids: Array.from({ length: 12000 }, (_, i) => `uuid-${i}-${"x".repeat(20)}`) } } });
    expect(long.length).toBeGreaterThan(256 * 1024);
    appendFileSync(r.file, `${long.replace('"isSidechain":false', '"isSidechain":true')}\n`);
    await r.watch.poll("w", id); await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(r.file, `${long}\n`);
    for (let i = 0; i < 3 && r.watch.view("w")!.state === "running"; i++) await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("review P2-2: another file put on the path during a look is not read; that look's file is", async () => {
    const r = rig();
    const id = r.start();
    const swap = () => {
      const next = join(r.dir, "replacement.jsonl");
      writeFileSync(next, `${`${CLAUDE_TURN}\n`.repeat(8)}${CLAUDE_BOUNDARY}\n`);       // its boundary wholly past the old end
      renameSync(next, r.file);
    };
    appendFileSync(r.file, `${CLAUDE_TURN}\n`);
    hooks.beforeRead = swap;                                               // after the look opened and checked the file
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("running");
    await r.watch.poll("w", id);                                           // the next look sees another file: starts at its end
    expect(r.watch.view("w")!.state).toBe("running");
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("review P2-2: a long record is read whole from that look's file too, whatever the path holds by then", async () => {
    const r = rig();
    const id = r.start();
    const long = JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted",
      compactMetadata: { preservedMessages: { uuids: Array.from({ length: 12000 }, (_, i) => `uuid-${i}-${"x".repeat(20)}`) } } });
    appendFileSync(r.file, `${long}\n`);
    hooks.beforeWhole = () => {
      const next = join(r.dir, "replacement.jsonl");
      writeFileSync(next, "x".repeat(long.length + 4096));
      renameSync(next, r.file);
    };
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("the daemon's word comes once: a repeated 'written' does not move where the watch reads from", async () => {
    const r = rig();
    const id = r.start();
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    r.watch.pasted("w", id, true);
    await r.watch.poll("w", id);
    expect(r.watch.view("w")!.state).toBe("done");
  });

  it("another transcript of the same launch, or this one replaced or cut short: from its end — an older boundary there is never taken", async () => {
    const r = rig();
    const id = r.start();
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
    const cid = cut.start();
    writeFileSync(cut.file, `${CLAUDE_BOUNDARY}\n`);                       // shorter than where the watch began
    await cut.watch.poll("w", cid);
    await cut.watch.poll("w", cid);
    expect(cut.watch.view("w")!.state).toBe("running");
    appendFileSync(cut.file, `${CLAUDE_BOUNDARY}\n`);                      // from its new end: this one counts
    await cut.watch.poll("w", cid);
    expect(cut.watch.view("w")!.state).toBe("done");

    const replaced = rig();
    const rid = replaced.start();
    const next = join(replaced.dir, "replacement.jsonl");
    writeFileSync(next, `${`${CLAUDE_TURN}\n`.repeat(8)}${CLAUDE_BOUNDARY}\n`);
    renameSync(next, replaced.file);                                         // another inode at the same path
    await replaced.watch.poll("w", rid);
    await replaced.watch.poll("w", rid);
    expect(replaced.watch.view("w")!.state).toBe("running");
  });

  it("review P2-3: another daemon (stop, relaunch), another backend or no transcript: lost; nobody running it when written: lost", async () => {
    for (const change of ["relaunch", "stopped", "backend", "no_transcript"] as const) {
      const r = rig();
      const id = r.start();
      if (change === "relaunch") r.daemon.current = {};
      if (change === "stopped") r.daemon.current = null;
      if (change === "backend") r.src.format = null;
      if (change === "no_transcript") r.src.path = null;
      appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
      await r.watch.poll("w", id);
      expect(r.watch.view("w")!.state, change).toBe("lost");
    }
    const later = rig();
    const lid = later.watch.begin("w")!;
    later.daemon.current = null;
    later.watch.pasted("w", lid, true);
    expect(later.watch.view("w")!.state).toBe("lost");
  });

  it("one per instance: a new /compact replaces the last; a command that did not go is forgotten; stopAll ends them", async () => {
    const r = rig();
    const first = r.start();
    const second = r.start();
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
    r.start();
    appendFileSync(r.file, `${CLAUDE_BOUNDARY}\n`);
    for (const t of [...r.timers.values()]) t.fn();
    await vi.waitFor(() => expect(r.watch.view("w")!.state).toBe("done"));
  });
});

describe("review P2-5: the daemon says when the paste was written", () => {
  function daemonRig(reached = true) {
    const dir = tmp();
    mkdirSync(join(dir, "inst"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
    const d: any = new Daemon("w", {
      working_directory: dir, backend: "claude-code", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "inst"), false, new ClaudeCodeBackend(join(dir, "inst")), undefined, logger);
    d.tmux = { isWindowAlive: async () => true, capturePane: async () => "", getWindowId: () => "@1" };
    const broadcast: unknown[] = [];
    const writes: string[] = [];
    d.ipcServer = { broadcast: (m: unknown) => broadcast.push(m), send: () => {} };
    d.wake = async () => {};
    d.deliverMessage = async (text: string, _x: unknown, opts: any) => {
      opts.verdict.reached = reached; opts.verdict.paneWriteStarted = reached;
      if (reached) { writes.push(text); opts.onPaneWritten?.(); writes.push(`after ${broadcast.length}`); }
      return reached;
    };
    return { d, broadcast, writes };
  }
  const ID = "0123456789abcdef";

  it("held behind the paste lock: nothing until the write; then 'written', once, at the write", async () => {
    const r = daemonRig();
    let release!: () => void;
    r.d.pasteLock = new Promise<void>(resolve => { release = resolve; });
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect([r.broadcast, r.writes]).toEqual([[], []]);
    release();
    await r.d.pasteLock;
    expect(r.broadcast).toEqual([{ type: "raw_paste_written", id: ID, outcome: "written" }]);
    expect(r.writes).toEqual(["/compact", "after 1"]);
  });

  it("never written, or cancelled while waking: 'not_written'; no id, or a malformed one: nothing said", async () => {
    const miss = daemonRig(false);
    miss.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
    await miss.d.pasteLock;
    expect(miss.broadcast).toEqual([{ type: "raw_paste_written", id: ID, outcome: "not_written" }]);
    const woke = daemonRig();
    woke.d.wake = async () => { woke.d.deliveryEpoch++; };
    woke.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", notify_written: ID });
    await woke.d.pasteLock;
    expect([woke.broadcast, woke.writes]).toEqual([[{ type: "raw_paste_written", id: ID, outcome: "not_written" }], []]);
    for (const extra of [{}, { notify_written: "x" }, { notify_written: 7 }]) {
      const plain = daemonRig();
      plain.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact", ...extra });
      await plain.d.pasteLock;
      expect(plain.broadcast).toEqual([]);
    }
  });
});

describe("the wiring", () => {
  function topic(opts: { connected?: boolean; accepts?: boolean; backend?: string } = {}) {
    const order: string[] = [];
    const commands = new TopicCommands({
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { w: { backend: opts.backend ?? "claude-code" } } },
      instanceIpcClients: new Map([["w", { connected: opts.connected ?? true, send: (m: { content: string; notify_written?: string }) => {
        order.push(`paste ${m.content} ${m.notify_written ?? "-"}`); return opts.accepts ?? true;
      } }]]),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any);
    return { commands, order };
  }

  it("the watch's id rides with the paste; it is asked for only when the command is about to go", () => {
    setLocale("en");
    const t = topic();
    expect(t.commands.compactInstance("w", undefined, () => { t.order.push("begin"); return "0123456789abcdef"; }))
      .toEqual({ sent: true, text: expect.stringContaining("/compact") });
    expect(t.order).toEqual(["begin", "paste /compact 0123456789abcdef"]);
    const off = topic({ connected: false });
    expect(off.commands.compactInstance("w", undefined, () => { off.order.push("begin"); return null; }).sent).toBe(false);
    const long = topic();
    expect(long.commands.compactInstance("w", "x".repeat(5000), () => { long.order.push("begin"); return null; }).sent).toBe(false);
    expect([...off.order, ...long.order]).toEqual([]);
  });

  it("review P2-4: a write the IPC refuses is not sent — in each of the three ways /compact goes; /clear too", () => {
    setLocale("en");
    for (const [backend, instructions] of [["claude-code", undefined], ["claude-code", "keep notes"], ["codex", "keep notes"]] as const) {
      const t = topic({ accepts: false, backend });
      expect(t.commands.compactInstance("w", instructions, () => "0123456789abcdef").sent, `${backend} ${instructions}`).toBe(false);
      expect(t.order).toHaveLength(1);
      const ok = topic({ backend });
      expect(ok.commands.compactInstance("w", instructions, () => null).sent, `${backend} ${instructions}`).toBe(true);
    }
    expect(topic({ accepts: false }).commands.clearInstance("w").sent).toBe(false);
    expect(topic().commands.clearInstance("w")).toEqual({ sent: true, text: expect.stringContaining("/clear") });
  });

  function fleet(compactInstance: (n: string, i: string | undefined, notify: () => string | null) => { sent: boolean; text: string }) {
    const f: any = Object.create(FleetManager.prototype);
    Object.assign(f, {
      fleetConfig: { instances: { w: { working_directory: "/w" } } }, classicChannels: null,
      compactWatchService: { begin: vi.fn(() => "0123456789abcdef"), cancel: vi.fn(), pasted: vi.fn() },
      topicCommands: { compactInstance: vi.fn(compactInstance) },
    });
    return f;
  }

  it("FleetManager.webCommand: the follow id of a sent /compact; a refused write drops its watch and is a 409", async () => {
    const sent = fleet((_n, _i, notify) => { notify(); return { sent: true, text: "sent" }; });
    expect(await sent.webCommand({ instance: "w", command: "compact" }, { publicLink: false }))
      .toEqual({ status: 200, body: { text: "sent", follow: { kind: "compact", id: "0123456789abcdef" } } });
    expect(sent.compactWatchService.cancel).not.toHaveBeenCalled();
    const refused = fleet((_n, _i, notify) => { notify(); return { sent: false, text: "not connected" }; });
    expect(await refused.webCommand({ instance: "w", command: "compact" }, { publicLink: false })).toEqual({ status: 409, body: { error: "not connected" } });
    expect(refused.compactWatchService.cancel).toHaveBeenCalledWith("w", "0123456789abcdef");
    const never = fleet(() => ({ sent: false, text: "not connected" }));
    await never.webCommand({ instance: "w", command: "compact" }, { publicLink: false });
    expect(never.compactWatchService.begin).not.toHaveBeenCalled();
    const throws = fleet((_n, _i, notify) => { notify(); throw new Error("ipc"); });
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
