/**
 * #2327: send_to_instance's warning about its recipient said "paused after repeated
 * errors" whenever the daemon was in any error state. One detected pattern is enough
 * for that state, so a running Grok instance that merely printed (or quoted) an error
 * line was reported as paused after repeated errors. The warning must name what is
 * actually known: an error message seen and awaiting recovery, an actual pause, a CLI
 * that is no longer supervised — never a pause or a repetition nobody observed.
 *
 * Decision path end to end: the real Daemon's error monitor arms the state, the real
 * outbound handler picks the text. No tmux, process or fleet is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setCrossInstanceRetryForTests(null);
  setLocale("en");
});

/** Grok mid-turn: its spinner is on screen, so the pane does not count as recovered. */
const WORKING = "⠋ Thinking… 3.2s";

function grokDaemon(): any {
  const dir = mkdtempSync(join(tmpdir(), "agend-2327-")); dirs.push(dir);
  return new Daemon("target", {
    working_directory: dir, backend: "grok", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, new GrokBackend(dir) as any, undefined,
  { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as any);
}

/** Run one scan of the daemon's real error monitor over `pane`; returns the events it raised. */
function scan(daemon: any, pane: string): Array<{ type: string; action: string }> {
  const events: Array<{ type: string; action: string }> = [];
  daemon.on("pty_error", (e: any) => events.push(e));
  const backend = daemon.backend;
  daemon.evaluateErrorPatterns(pane, backend.getErrorPatterns(), backend.getReadyPattern(), Date.now(), backend.getBusyPattern());
  return events;
}

function makeContext(daemon: unknown, paused = false) {
  setCrossInstanceRetryForTests({ retries: 0, intervalMs: 5 });
  return {
    fleetConfig: { defaults: {}, instances: { sender: {}, target: {} }, channel: undefined },
    adapter: null,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    instanceIpcClients: new Map([["target", { connected: true, send: vi.fn() }]]),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map([["target", daemon]]), isPaused: vi.fn(() => paused) },
    classicChannels: null,
    eventLog: { logActivity: vi.fn(), insert: vi.fn() },
    deliverToInstance: vi.fn(() => new Promise<void>(() => { /* target stays busy */ })),
    notifyInstanceTopic: vi.fn(),
    lastActivityMs: vi.fn(() => 0),
  } as any;
}

async function send(ctx: any): Promise<any> {
  let result: any; let error: string | undefined;
  await outboundHandlers.get("send_to_instance")!(ctx, { instance_name: "target", message: "hello" },
    (r, e) => { result = r; error = e; }, { instanceName: "sender", requestId: 1 } as any);
  expect(error).toBeUndefined();
  expect(result).toMatchObject({ sent: true, queued: true });
  return result;
}

describe("send_to_instance's recipient warning says only what is known (#2327)", () => {
  it("one notify-only error on a running recipient: an error message seen, not a pause after repeated errors", async () => {
    const daemon = grokDaemon();
    // The issue's counter-example: ordinary prose quoting a 426, still matched by outdated_cli.
    expect(scan(daemon, `The proxy logs show "Request failed (426)" for old clients.\n${WORKING}`))
      .toEqual([expect.objectContaining({ type: "outdated_cli", action: "notify" })]);
    expect(daemon.isPaused).toBe(false);

    const result = await send(makeContext(daemon));
    expect(result.target_state).toBe("running");
    expect(result.warning).toBe("target showed an error message and is waiting to recover. The message is queued and may be delayed.");
    expect(result.warning).not.toMatch(/paused|repeated/i);

    setLocale("zh-TW");
    const zh = await send(makeContext(daemon));
    expect(zh.warning).toBe("target 出現錯誤訊息，正在等待恢復。訊息已排入佇列，可能會延後處理。");
    expect(zh.warning).not.toMatch(/暫停|反覆/);
  });

  it("a quota line names the quota message, without claiming a pause", async () => {
    const daemon = grokDaemon();
    expect(scan(daemon, `Error: insufficient credits\n${WORKING}`)).toEqual([expect.objectContaining({ type: "quota", action: "notify" })]);
    const result = await send(makeContext(daemon));
    expect(result.warning).toBe("target showed a quota or usage-limit message and is waiting to recover. The message is queued and may be delayed.");
  });

  it("provider-limit and auth messages on a running recipient are not called a pause either", async () => {
    const limited = grokDaemon();
    expect(scan(limited, `Request failed (429) Too Many Requests\n${WORKING}`)).toEqual([expect.objectContaining({ type: "rate_limit" })]);
    const limit = await send(makeContext(limited));
    expect(limit.warning).toBe("target showed a provider rate-limit or timeout message and is waiting to recover. The message is queued and may be delayed.");

    const auth = grokDaemon();
    expect(scan(auth, `Request failed (401) Unauthorized\n${WORKING}`)).toEqual([expect.objectContaining({ type: "auth_error" })]);
    const authResult = await send(makeContext(auth));
    expect(authResult.warning).toBe("target showed an authentication error message and is waiting to recover. The message is queued and may be delayed. Check its credentials.");
    expect(authResult.warning).not.toMatch(/paused/i);
  });

  it("control — an actually paused recipient with a detected error is called paused", async () => {
    const daemon = grokDaemon();
    scan(daemon, `Error: insufficient credits\n${WORKING}`);
    const result = await send(makeContext(daemon, true));
    expect(result.target_state).toBe("paused");
    expect(result.warning).toBe("target is paused; before that it showed a quota or usage-limit message. The message is queued and may be delayed.");
    setLocale("zh-TW");
    const zh = await send(makeContext(daemon, true));
    expect(zh.warning).toBe("target 已暫停，暫停前出現額度或用量上限訊息。訊息已排入佇列，可能會延後處理。");
  });

  it("control — a healthy recipient gets no warning", async () => {
    const daemon = grokDaemon();
    expect(scan(daemon, `All tests pass.\n${WORKING}`)).toEqual([]);
    const result = await send(makeContext(daemon));
    expect(result.target_state).toBe("running");
    expect(result.warning).toBeUndefined();
  });

  it("a CLI no longer supervised is reported as not running, not by a stale earlier error", async () => {
    const daemon = grokDaemon();
    scan(daemon, `Error: insufficient credits\n${WORKING}`);
    // What a health check sets when it stops supervising (CLI exited, crash limit, restart disabled).
    daemon.healthCheckPaused = true;
    const result = await send(makeContext(daemon));
    expect(result.warning).toBe("target's CLI is not running and is not being restarted automatically. The message is queued and may not be processed until it is started again.");
  });

  it("an unsupervised CLI outranks a tmux recovery; a tmux recovery alone says so", async () => {
    const daemon = grokDaemon();
    daemon.stormWindow = { isActive: () => true };
    expect((await send(makeContext(daemon))).warning).toBe("target is recovering from a tmux failure. The message is queued and may be delayed.");
    daemon.healthCheckPaused = true;
    expect((await send(makeContext(daemon))).warning).toContain("is not running and is not being restarted automatically");
  });

  it("a crash loop admitted during a planned restart keeps its crash warning, not the unsupervised one", async () => {
    const daemon = grokDaemon();
    // The 3-crash breaker sets both: supervision ended, and a crash loop.
    daemon.healthCheckPaused = true;
    daemon.crashCount = 3;
    const ctx = makeContext(daemon);
    // A crashed target is refused unless a planned restart admits it durably.
    ctx.isInstanceRestarting = () => true;
    ctx.admitDurableDelivery = () => ({ deliveryId: "d-2327", state: "queued", duplicate: false });
    const result = await send(ctx);
    expect(result.target_state).toBe("crashed");
    expect(result.warning).toBe("target keeps crashing and needs a restart or replacement. The message is queued and may not be processed.");
  });
});
