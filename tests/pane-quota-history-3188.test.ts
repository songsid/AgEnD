import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { GrokBackend } from "../src/backend/grok.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { snapshotCodexQuotaHistory } from "../src/backend/codex-quota-history.js";
import { quotaHistoryCount } from "../src/pane-quota-history.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OLD = fixture("codex-0166-resumed-quota.pane.txt");
const LAST = fixture("codex-0166-resumed-last-quota.pane.txt");
const HIT = fixture("codex-0160-usage-limit-curly-apostrophe.pane.txt");
const GROK = fixture("grok-1.0.70-audit/1.0.70-compact-120/60-compact-fail-b.pane.txt");
const WEEKLY = fixture("grok-weekly-limit-modal.pane.txt");
const MESSAGE = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 8:59 AM.";
const ID = "01a1afde-52f1-7e82-887e-c75c389cde4b";
const dirs: string[] = [], daemons: any[] = [];
afterEach(() => {
  daemons.splice(0).forEach(d => d.freezeRuntimeMonitors());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
function setup(kind: "codex" | "grok", pane: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-quota-history-")); dirs.push(root);
  const instance = join(root, "instance"), home = join(root, "codex");
  mkdirSync(instance); mkdirSync(join(home, "sessions"), { recursive: true });
  vi.stubEnv("CODEX_HOME", home);
  const backend = kind === "codex" ? new CodexBackend(instance) : new GrokBackend(instance);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const d = new Daemon("quota-fixture", { working_directory: root, backend: kind, lightweight: true,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 }, log_level: "silent",
  } as any, instance, false, backend, undefined, { child: () => logger } as any) as any;
  daemons.push(d);
  const state = { pane };
  const tmux = { capturePane: vi.fn(async () => state.pane), isWindowAlive: vi.fn(async () => true),
    getWindowId: () => "@9", respawnWindow: vi.fn(async () => {}), createWindow: vi.fn(async () => "@9"),
    setRemainOnExit: vi.fn(async () => {}), pasteBuffer: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true), sendKeys: vi.fn(async () => true),
  };
  d.tmux = tmux;
  const errors: any[] = []; d.on("pty_error", (e: any) => errors.push(e));
  const quota = () => errors.filter(e => e.type === "quota");
  const scan = (text = state.pane) => d.evaluateErrorPatterns(text, backend.getErrorPatterns(), backend.getReadyPattern(), Date.now() + 600_000);
  const admit = () => d.dismissDialogsUntilReady(15, 0);
  const record = (message = MESSAGE, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: {
    type: "task_complete", turn_id: "old-turn", error: { message, codex_error_info: "usage_limit_exceeded" }, ...extra } }) + "\n";
  const path = join(home, "sessions", `rollout-2026-01-01T00-00-00-${ID}.jsonl`);
  const saved = () => {
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: ID, cwd: root, source: "cli" } }) + "\n" + record());
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(fixture("codex-0157-state5-schema.sql"));
    db.prepare(`INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,has_user_event,first_user_message,archived,recency_at_ms,updated_at_ms)
      VALUES (?, ?, 1, 1, 'cli', 'openai', ?, 'fixture', 'read-only', 'never', 1, 'fixture', 0, 1, 1)`).run(ID, path, root);
    db.close();
  };
  const spawn = async (reuse = false) => {
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(12345);
    d.bindInstanceStateOutputListener = () => { throw new Error("inert launch boundary"); };
    await expect(d.trySpawnInsideGate(reuse)).rejects.toThrow("inert launch boundary");
  };
  return { d, backend, instance, state, tmux, quota, scan, admit, saved, spawn, record, path, logger };
}

describe("quota history at the actual resume admission boundary", () => {
  it.each([OLD, LAST])("real Codex resume history is silent, including the last-error-only layout", async pane => {
    const f = setup("codex", pane); f.saved(); await f.spawn(); await f.admit();
    vi.useFakeTimers(); f.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(6_000);
    expect(f.quota()).toEqual([]);
    expect(f.logger.debug.mock.calls.some(c => c[0]?.evidence === "before-resume")).toBe(true);
  });
  it("a verified rollout auto-resume uses the same history proof when its DB row is absent", async () => {
    const f = setup("codex", OLD); f.saved();
    const db = new Database(join(process.env.CODEX_HOME!, "state_5.sqlite")); db.exec("DELETE FROM threads"); db.close();
    await f.spawn(); await f.admit(); f.scan(); expect(f.quota()).toEqual([]);
  });
  it("a genuine first monitor hit after resume admission still reports once", async () => {
    const f = setup("codex", OLD); f.saved(); await f.spawn(); await f.admit();
    f.state.pane += "\n› current turn\n" + HIT;
    vi.useFakeTimers(); f.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(6_000);
    expect(f.quota()).toHaveLength(1);
  });
  it.each([HIT, HIT.replaceAll("’", "'")])("fresh first-monitor wrapped hits retain #1103 (both apostrophes)", async pane => {
    const f = setup("codex", pane); f.d.skipResume = true; await f.spawn(); await f.admit();
    vi.useFakeTimers(); f.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(6_000);
    expect(f.quota()).toHaveLength(1);
  });
  it("a fresh retry on the same backend cannot retain a previous resume proof", async () => {
    const f = setup("codex", OLD); f.saved(); await f.spawn();
    f.d.skipResume = true; await f.spawn(); await f.admit(); f.scan();
    expect(f.quota()).toHaveLength(1);
  });
  it.each(["spawnGeneration", "launchFenceEpoch", "launchAttempt"])("a changed %s retires replay proof", async field => {
    const f = setup("codex", OLD); f.saved(); await f.spawn(); f.d[field]++;
    await f.admit(); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("an appended record before admission invalidates the old launch snapshot", async () => {
    const f = setup("codex", OLD); f.saved(); await f.spawn();
    appendFileSync(f.path, f.record(MESSAGE, { turn_id: "new-turn" }));
    await f.admit(); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("a different resumed session gets no other session's quota proof", async () => {
    const f = setup("codex", OLD); f.saved();
    writeFileSync(f.path, JSON.stringify({ type: "session_meta", payload: { id: "other-session", cwd: "/other", source: "cli" } }) + "\n" + f.record());
    await f.spawn(); await f.admit(); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("empty and loading frames before restored history do not consume its proof", async () => {
    const f = setup("codex", ""); f.saved(); await f.spawn();
    const frames = ["", fixture("codex-0159-resume-loading.pane.txt"), OLD, OLD];
    f.tmux.capturePane.mockImplementation(async () => frames.shift() ?? OLD);
    await f.admit(); f.scan(OLD); expect(f.quota()).toEqual([]);
  });
  it("history absent at admission never suppresses a later single hit", async () => {
    const f = setup("codex", "› Ask Codex to do anything\n  Context 100% left"); f.saved(); await f.spawn();
    await f.admit(); f.scan(HIT); expect(f.quota()).toHaveLength(1);
  });
  it("a handled row scrolling out then a later single hit re-arms", async () => {
    const f = setup("codex", OLD); f.saved(); await f.spawn(); await f.admit(); f.scan();
    f.scan("› Ask Codex to do anything\n  Context 100% left");
    f.scan(HIT); expect(f.quota()).toHaveLength(1);
  });
  it("Grok captures before the real respawn hook; stale text is quiet, a new error still reports", async () => {
    const f = setup("grok", GROK); writeFileSync(join(f.instance, "session-id"), ID);
    const order: string[] = [];
    f.tmux.capturePane.mockImplementation(async () => { order.push("capture"); return f.state.pane; });
    f.tmux.respawnWindow.mockImplementation(async () => { order.push("respawn"); f.state.pane = GROK; });
    await f.spawn(true); expect(order.slice(0, 2)).toEqual(["capture", "respawn"]);
    await f.admit(); f.scan(); expect(f.quota()).toEqual([]);
    f.scan(GROK + "\n┃ out of credits (new call)\n│ ❯ │"); expect(f.quota()).toHaveLength(1);
  });
  it("Grok has no history exemption without a resumed, readable preserved pane", async () => {
    const f = setup("grok", GROK); await f.spawn(true); await f.admit(); f.scan();
    expect(f.quota()).toHaveLength(1);
  });
  it("a read failure on Grok's old pane stays unknown", async () => {
    const f = setup("grok", GROK); writeFileSync(join(f.instance, "session-id"), ID);
    f.tmux.capturePane.mockRejectedValueOnce(new Error("unreadable"));
    await f.spawn(true); await f.admit(); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("Grok weekly live modal remains a live pause after historical quota was absorbed", async () => {
    const f = setup("grok", GROK); writeFileSync(join(f.instance, "session-id"), ID);
    await f.spawn(true); await f.admit(); f.scan(); f.state.pane = WEEKLY;
    f.tmux.sendKeys.mockImplementation(async () => { f.state.pane = "╭──────╮\n│ ❯    │\n╰──────╯\n  Shift+Tab:mode  │  Ctrl+x:shortcuts"; return true; });
    vi.useFakeTimers(); f.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(16_000);
    expect(f.tmux.sendKeys).toHaveBeenCalledExactlyOnceWith("X");
    expect(f.quota()).toEqual([expect.objectContaining({ action: "pause", skipUsageVerify: true })]);
  });
});

describe("pre-input observation is committed only for this input's owner", () => {
  it.each(["ordinary", "system"])("the real %s paste path absorbs only the captured old rows", async path => {
    const f = setup("grok", GROK);
    f.d.paneInTmuxMode = vi.fn(async () => false);
    f.d.sendDeliveryEnter = vi.fn(async () => true);
    f.d.confirmSubmitted = vi.fn(async () => "submitted");
    vi.useFakeTimers();
    const input = path === "ordinary" ? f.d.writeMessageToPane("next-input", "@9", false)
      : f.d.submitSystemPaste("next-input", "quota-test");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(input).resolves.toBe(true);
    expect(f.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    f.scan(); expect(f.quota()).toEqual([]);
    f.scan(GROK + "\n┃ out of credits (new request)"); expect(f.quota()).toHaveLength(1);
  });
  it("an unconfirmed Enter does not absorb the quota row", async () => {
    const f = setup("grok", GROK); f.d.sendDeliveryEnter = vi.fn(async () => false);
    vi.useFakeTimers(); const pending = f.d.submitSystemPaste("next", "quota-test");
    await vi.advanceTimersByTimeAsync(1_000); await expect(pending).resolves.toBe(false);
    f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("a failed paste does not absorb the quota row", async () => {
    const f = setup("grok", GROK); f.tmux.pasteBuffer.mockResolvedValue(false);
    await expect(f.d.submitSystemPaste("next", "quota-test")).resolves.toBe(false);
    f.scan(); expect(f.quota()).toHaveLength(1);
  });

  it.each(["codex", "grok"] as const)("%s retains old text but reports newly appended quota", async kind => {
    const f = setup(kind, kind === "codex" ? OLD : GROK);
    const evidence = await f.d.capturePaneEvidence({ value: "next-input", unique: true });
    f.d.commitPreInputQuotaHistory(evidence); f.scan(); expect(f.quota()).toEqual([]);
    f.scan(f.state.pane + (kind === "codex" ? "\n" + HIT : "\n┃ out of credits (current call)"));
    expect(f.quota()).toHaveLength(1);
  });
  it.each(["spawnGeneration", "launchFenceEpoch", "launchAttempt"])("a changed %s refuses old pre-input evidence", async field => {
    const f = setup("grok", GROK); const evidence = await f.d.capturePaneEvidence({ value: "next", unique: true });
    f.d[field]++; f.d.commitPreInputQuotaHistory(evidence); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it.each(["tmux", "window"])("a replaced %s refuses pre-input evidence", async field => {
    const f = setup("grok", GROK); const evidence = await f.d.capturePaneEvidence({ value: "next", unique: true });
    if (field === "tmux") f.d.tmux = { ...f.tmux };
    else f.tmux.getWindowId = () => "@replacement";
    f.d.commitPreInputQuotaHistory(evidence); f.scan(); expect(f.quota()).toHaveLength(1);
  });
  it("an owner change while capture is pending supplies no history", async () => {
    const f = setup("grok", GROK); let release!: (text: string) => void;
    f.tmux.capturePane.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = f.d.capturePaneEvidence({ value: "next", unique: true });
    f.d.spawnGeneration++; release(GROK);
    f.d.commitPreInputQuotaHistory(await pending); f.scan(); expect(f.quota()).toHaveLength(1);
  });
});

describe("bounded, immutable Codex rollout evidence", () => {
  it("only real structured timestamped quota completions qualify; file change revokes the snapshot", () => {
    const f = setup("codex", OLD); f.saved(); const history = snapshotCodexQuotaHistory(f.path);
    expect(history?.messages).toEqual([MESSAGE]); expect(history?.current()).toBe(true);
    appendFileSync(f.path, f.record()); expect(history?.current()).toBe(false);
  });
  it.each([
    { type: "assistant", message: MESSAGE },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn", error: { message: MESSAGE } } },
    { timestamp: "2999-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn", error: { message: MESSAGE, codex_error_info: "usage_limit_exceeded" } } },
  ])("ambiguous/quoted/future records do not qualify", record => {
    const f = setup("codex", OLD); writeFileSync(f.path, JSON.stringify(record) + "\n");
    expect(snapshotCodexQuotaHistory(f.path)).toBeNull();
  });
  it("partial records and missing files provide no proof", () => {
    const f = setup("codex", OLD); f.saved(); appendFileSync(f.path, '{"type":');
    expect(snapshotCodexQuotaHistory(f.path)).toBeNull(); rmSync(f.path);
    expect(snapshotCodexQuotaHistory(f.path)).toBeNull();
  });
  it("full messages must match; a different quota row is not old, and wrapping does not change identity", () => {
    const pattern = /you['’]ve hit your usage limit/i;
    expect(quotaHistoryCount(OLD, pattern, [MESSAGE])).toBe(1);
    expect(quotaHistoryCount(HIT, pattern, [MESSAGE])).toBe(0);
    expect(quotaHistoryCount(OLD, pattern, [MESSAGE, MESSAGE])).toBe(1);
  });
});
