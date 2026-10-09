/**
 * #1510 part 2: the reply-completion guard covers muse, its turn end read from muse's own session log.
 *
 * Part 1 replays the real muse 1.4.4 session logs (tests/fixtures/reply-guard-1510/muse-1.4.4) through the
 * production MuseSessionSource and the turn ledger. Part 2 runs the real Daemon with the real MuseBackend and the
 * recorded panes: only the pane writer, the IPC and the MCP liveness probe are stubbed.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuseBackend } from "../src/backend/muse.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { setLocale } from "../src/locale.js";
import type { Logger } from "../src/logger.js";
import { MuseSessionSource, createTranscriptSource } from "../src/transcript-sources.js";
import { TranscriptTurnLedger, type TranscriptTurnEvent } from "../src/transcript-turns.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const FIX = join(import.meta.dirname, "fixtures", "reply-guard-1510", "muse-1.4.4");
const LOG = readFileSync(join(FIX, "session.jsonl"), "utf8").trim().split("\n");
const CANCEL = readFileSync(join(FIX, "session-cancel.jsonl"), "utf8").trim().split("\n");
const frame = (name: string) => readFileSync(join(FIX, "frames", `${name}.txt`), "utf8");
const CWD = "/home/user/project";
const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1510m-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Each intent's text → the wall time muse accepted it (the guard arms at the paste, i.e. then). */
const acceptedAt = new Map<string, number>();
for (const line of [...LOG, ...CANCEL]) {
  const o = JSON.parse(line);
  if (o.payload_type === "runtime.user_intent.accepted") acceptedAt.set(o.payload.model_messages[0].content[0].text, Math.floor(o.recorded_at / 1000));
}

describe("the recorded muse 1.4.4 session logs, through the production MuseSessionSource", () => {
  let clock = 0;
  beforeEach(() => { clock = 0; });
  /** A sessions tree; `session(id)` makes a log there, `append` writes records as muse would. */
  function tree() {
    const root = join(temp(), "sessions");
    const session = (id: string, day = "10") => {
      const dir = join(root, "2026", "10", day, id); mkdirSync(dir, { recursive: true });
      const file = join(dir, "session.jsonl"); writeFileSync(file, "");
      return { file, append: (lines: string[]) => appendFileSync(file, lines.map(l => l + "\n").join("")) };
    };
    const source = (ttl = 30_000) => new MuseSessionSource(CWD, root, ttl, () => clock);
    return { root, session, source };
  }
  async function replay(lines: string[]) {
    const t = tree(); const s = t.source(); await s.initialize();
    t.session("01a121bb-e928-7d00-ac73-07064285b859").append(lines);
    clock += 30_000;
    const turns = (await s.poll()).turns ?? [];
    const ledger = new TranscriptTurnLedger(); ledger.observe(turns);
    return { turns, ledger };
  }
  const verdictFor = (ledger: TranscriptTurnLedger, text: string) => ledger.verdict(text, acceptedAt.get(text)!);

  it("two runs: the one taking the first message, and the one after it for the message typed mid-run", async () => {
    const { turns } = await replay(LOG);
    expect(turns.map(t => t.kind)).toEqual(["start", "user", "user", "end", "start", "end"]);
    expect(turns.filter(t => t.kind === "user").map(t => (t as { turnId: string }).turnId))
      .toEqual([(turns[0] as { turnId: string }).turnId, (turns[0] as { turnId: string }).turnId]);
  });

  it("both messages: ended once both runs ended; running while the second run (after run 1's terminal) is open", async () => {
    const { ledger } = await replay(LOG);
    expect(verdictFor(ledger, "long echo one")).toBe("ended");
    expect(verdictFor(ledger, "SECOND while running")).toBe("ended");
    const records = LOG.map(l => JSON.parse(l) as { payload?: { event?: { kind?: string } } });
    const lastStart = records.length - 1 - [...records].reverse().findIndex(o => o.payload?.event?.kind === "started");
    const cut = await replay(LOG.slice(0, lastStart + 1)); // run 2 started, its terminal not written yet
    expect(verdictFor(cut.ledger, "long echo one")).toBe("running");
    expect(verdictFor(cut.ledger, "SECOND while running")).toBe("running");
  });

  it("a cancelled run (terminal reason \"cancelled …\") is aborted", async () => {
    const { ledger } = await replay(CANCEL);
    expect(verdictFor(ledger, "cancel me")).toBe("aborted");
  });

  it("from the recorded lines, one field changed each: a run that failed is an error; an intent not on the main surface is not ours", async () => {
    const failed = LOG.map(l => l.includes('"terminal"') ? l.replace('"reason":null', '"reason":"invalid run configuration: provider does not support base instructions"') : l);
    expect(verdictFor((await replay(failed)).ledger, "long echo one")).toBe("error");
    const side = LOG.map(l => l.replace('"surface":"main"', '"surface":"side_panel"'));
    const { turns } = await replay(side);
    expect(turns.some(t => t.kind === "user")).toBe(false);
  });

  it("a log already there when the source starts is read from its end; one made after is read from its start", async () => {
    const t = tree();
    t.session("old-0000-session").append(LOG);
    const s = t.source(); await s.initialize();
    clock += 30_000;
    expect((await s.poll()).turns).toBeUndefined();
    t.session("new-0000-session").append(LOG);
    clock += 30_000;
    expect((await s.poll()).turns?.length).toBe(6);
  });

  it("another directory's log, and an observer log that never names a cwd, are not followed", async () => {
    const t = tree(); const s = t.source(); await s.initialize();
    const other = t.session("other-000-session");
    other.append(LOG.map(l => l.replace(CWD, "/home/user/elsewhere")));
    const observer = t.session("773b3f22-05d6-4cfa-abe0-fe8744cfa38a");
    observer.append(LOG.slice(1)); // no route_facts: no cwd
    const old = new Date(Date.now() - 120_000); utimesSync(observer.file, old, old);
    clock += 30_000;
    expect((await s.poll()).turns).toBeUndefined();
    // The observer log gaining a matching cwd later is not read again either: it was refused for good.
    writeFileSync(observer.file, LOG.join("\n") + "\n");
    clock += 30_000;
    expect((await s.poll()).turns).toBeUndefined();
  });

  it("a new session is found at the next listing, not before (the tree is re-listed at most every 30 s)", async () => {
    const t = tree(); const s = t.source(); await s.initialize();
    t.session("new-0000-session").append(LOG);
    clock += 10_000;
    expect((await s.poll()).turns).toBeUndefined();
    clock += 20_000;
    expect((await s.poll()).turns?.length).toBe(6);
  });

  it("the fleet builds this source for a muse instance", () => {
    expect(createTranscriptSource("muse", CWD)).toBeInstanceOf(MuseSessionSource);
  });
});

describe("the real Daemon with the real MuseBackend: recovery only when the session log proves the run ended", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z")); setLocale("en"); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function harness() {
    const dir = temp();
    const backend = new MuseBackend(dir);
    const daemon = new Daemon("worker", {
      backend: "muse", working_directory: dir, reply_completion_guard: true, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, true, backend, undefined, logger) as any;
    let pane = "";
    const writes: string[] = [];
    daemon.tmux = { capturePane: vi.fn(async () => pane) };
    daemon.deliverMessage = vi.fn(async (text: string, _s?: unknown, opts?: { deliveryEpoch?: number }) => {
      if (opts?.deliveryEpoch !== undefined && !daemon.isDeliveryEpochCurrent(opts.deliveryEpoch)) return false;
      writes.push(text);
      return true;
    });
    daemon.deliverDaemonReply = vi.fn(async () => true);
    daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
    daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
    daemon.instanceStateMonitorActive = true;
    daemon.instanceStateReadyPattern = backend.getReadyPattern();
    daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
    let seq = 0;
    const h = {
      daemon, writes,
      recovery: () => writes.filter(text => text.startsWith("[system:reply-required]")),
      async inbound(content = "do the task") {
        daemon.pushChannelMessage(content, { chat_id: "guild-1", thread_id: "channel-1", adapter_id: "discord", message_id: "m-1", correlation_id: "cid-1" });
        await daemon.pasteLock;
      },
      run(end?: "complete" | "aborted" | "error", text: string | null = writes[0]) {
        const id = `run-${++seq}`;
        return [{ kind: "start", turnId: id }, ...(text === null ? [] : [{ kind: "user", turnId: id, text, at: Date.now() }]),
          ...(end ? [{ kind: "end", turnId: id, end }] : [])] as TranscriptTurnEvent[];
      },
      log(turns: TranscriptTurnEvent[]) { daemon.transcriptTurns.observe(turns); },
      async capture(next: string) {
        pane = next;
        const at = Date.now();
        daemon.instanceStateLastOutputAt = at;
        daemon.applyInstanceStateSnapshot(daemon.instanceStateMachine.recordOutput(at));
        vi.advanceTimersByTime(2_100);
        await daemon.captureAndEvaluateInstanceState("idle_debounce", at);
        await daemon.pasteLock;
      },
      async confirmIdle() {
        vi.advanceTimersByTime(61_000);
        await daemon.captureAndEvaluateInstanceState("idle_debounce", daemon.instanceStateLastOutputAt);
        await daemon.pasteLock;
      },
      async turn() { await h.capture(frame("run2-busy")); await h.capture(frame("run2-idle")); await h.confirmIdle(); },
    };
    return h;
  }

  it("muse opts in, with its turn end read from the session log", () => {
    const b = new MuseBackend(temp());
    expect(b.replyCompletionGuard).toBe(true);
    expect(b.turnEndFromTranscript).toBe(true);
  });

  it("the run holding our message ended, no reply: exactly one recovery prompt", async () => {
    const h = harness();
    await h.inbound(); h.log(h.run("complete"));
    await h.turn();
    expect(h.recovery()).toHaveLength(1);
  });

  it("our message's run ended but the run it started is open (the one idle frame between them): held", async () => {
    const h = harness();
    await h.inbound(); h.log([...h.run("complete"), ...h.run(undefined, null)]);
    await h.capture(frame("run1-last-busy")); await h.capture(frame("between-runs-idle")); await h.confirmIdle();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).not.toBeNull();
  });

  it.each([["aborted"], ["error"]] as const)("our run %s: no recovery, the obligation is closed", async end => {
    const h = harness();
    await h.inbound(); h.log(h.run(end));
    await h.turn();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("not in the log (another muse in the same directory, or no log): never a recovery — fail-safe", async () => {
    const h = harness();
    await h.inbound(); h.log(h.run("complete", "another instance's message"));
    await h.turn();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("a delivered reply settles it: no recovery", async () => {
    const h = harness();
    await h.inbound(); h.log(h.run("complete"));
    const socket = new EventEmitter() as any;
    h.daemon.socketSessionNames.set(socket, "worker");
    h.daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 1 }, socket);
    const pending = [...h.daemon.pendingIpcRequests.entries()].find(([key]: any) => key.endsWith("_1"));
    pending![1]({ result: { ok: true } });
    await h.turn();
    expect(h.recovery()).toEqual([]);
  });

  it("the recorded frames: busy through each run, one idle frame between them, idle at the end", () => {
    const b = new MuseBackend(temp());
    expect(b.getBusyPattern().test(frame("run1-last-busy"))).toBe(true);
    expect(b.getBusyPattern().test(frame("between-runs-idle"))).toBe(false);
    expect(b.getBusyPattern().test(frame("run2-busy"))).toBe(true);
    expect(b.getBusyPattern().test(frame("run2-idle"))).toBe(false);
  });
});
