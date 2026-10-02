import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { InstanceLifecycle, codexQuotaVerdictFromUsage, type CodexQuotaVerdict, type LifecycleContext } from "../src/instance-lifecycle.js";
import { fetchCodexUsage } from "../src/usage/providers.js";

/**
 * #1103 — a real "usage limit" hit never paused: codex paints its composer right
 * after the error line, and the daemon read "live composer + Context footer" as
 * proof that Luna Reserve was running (the stale-reserve guard of 5408a7dc).
 * The decision now rests on facts that can tell the two apart:
 *   E1  AgEnD itself saw (and answered) the Luna Reserve menu in this spawn;
 *       usage-limit text up to that count is the incident it handled, a larger
 *       count is a new hit.
 *   E2  the live usage endpoint: a full regular window with Luna Reserve room
 *       → codex continues on the reserve, nothing to pause; a full regular
 *       window without → pause, whatever the composer looks like.
 * Unknown (no OAuth login, API key, timeout) pauses.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (n: string) => readFileSync(join(fixtures, `codex-${n}.pane.txt`), "utf8");
// Real 0.160.0 pane: the error line followed by the live composer + Context footer.
const REAL_HIT = pane("0160-usage-limit-curly-apostrophe");

const ERROR_LINE = "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:00 AM.";
// The real 0.156.1 menu (captured live, see codex.ts), with the error line above it.
const RESERVE_MENU = [
  "› hello",
  ERROR_LINE,
  "",
  "• Automatically switched to Luna Reserve xhigh due to usage limits.",
  "  You're now using Luna, a faster model for simpler tasks.",
  "  Use your reset to continue using the most advanced models, or",
  "  wait for usage to reset after 08:00 on 27 Sep.",
  "› 1. Reset usage",
  "  2. Add Credits",
  "  3. Continue with Luna Reserve",
  "  Press enter to confirm or esc to continue working",
].join("\n");
const COMPOSER = ["› Ask Codex to do anything", "  Context 100% left · GPT-6-Luna"].join("\n");
/** After Escape: the reserve session is live; the error line is history above the composer. */
const AFTER_ESCAPE = ["› hello", ERROR_LINE, "", "• ok", "  Worked for 2s", COMPOSER].join("\n");
/** …and later the reserve ran out too: a SECOND error line. */
const SECOND_HIT = ["› hello", ERROR_LINE, "", "• ok", "› again", ERROR_LINE.replace("8:00 AM", "9:00 AM"), COMPOSER].join("\n");

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// ───────────────────────────── E2: the verdict ─────────────────────────────

describe("the usage verdict from the live endpoint (real #936 body shape)", () => {
  const home = mkdtempSync(join(tmpdir(), "agend-1103-usage-")); dirs.push(home);
  const prev = process.env.CODEX_HOME;
  beforeEach(() => {
    process.env.CODEX_HOME = home;
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: ["test", "payload", "value"].join("."), account_id: "account" } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  });

  /** The captured shape: the regular weekly window and, optionally, the `gpt-reserve` additional limit. */
  function body(primaryUsed: number, reserveUsed?: number, extra: Record<string, unknown> = {}) {
    return {
      rate_limit: { secondary_window: { used_percent: primaryUsed, limit_window_seconds: 604_800 } },
      ...(reserveUsed === undefined ? {} : {
        additional_rate_limits: [{
          limit_name: "gpt-reserve",
          metered_feature: "base_model_inference",
          normal_model_slug: "gpt-5.6-luna",
          rate_limit: { secondary_window: { used_percent: reserveUsed, limit_window_seconds: 604_800 } },
        }],
      }),
      ...extra,
    };
  }
  const verdictFor = async (json: unknown, ok = true): Promise<CodexQuotaVerdict> => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => json }));
    return codexQuotaVerdictFromUsage(await fetchCodexUsage());
  };

  it("regular window full + Luna Reserve with room → reserve (codex continues on it)", async () => {
    expect(await verdictFor(body(100, 4))).toBe("reserve");
    expect(await verdictFor(body(100, 0))).toBe("reserve");
    expect(await verdictFor(body(100, 99))).toBe("reserve");
  });

  it("regular window full + reserve full → exhausted", async () => {
    expect(await verdictFor(body(100, 100))).toBe("exhausted");
  });

  it("regular window full + no reserve row → exhausted", async () => {
    expect(await verdictFor(body(100))).toBe("exhausted");
    expect(await verdictFor(body(100, undefined, { additional_rate_limits: [] }))).toBe("exhausted");
  });

  it("a reserve with ANY full window is not usable (both windows must have room)", async () => {
    const twoWindows = (a: number, b: number) => ({
      rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604_800 } },
      additional_rate_limits: [{
        limit_name: "gpt-reserve", normal_model_slug: "gpt-5.6-luna",
        rate_limit: {
          primary_window: { used_percent: a, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: b, limit_window_seconds: 604_800 },
        },
      }],
    });
    expect(await verdictFor(twoWindows(4, 4))).toBe("reserve");
    expect(await verdictFor(twoWindows(100, 4))).toBe("exhausted");
    expect(await verdictFor(twoWindows(4, 100))).toBe("exhausted");
  });

  it("a model-specific limit that is not the reserve does not count as one", async () => {
    const spark = { additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { secondary_window: { used_percent: 1, limit_window_seconds: 604_800 } } }] };
    expect(await verdictFor(body(100, undefined, spark))).toBe("exhausted");
  });

  it("regular window with room → available, whatever the reserve says", async () => {
    expect(await verdictFor(body(60))).toBe("available");
    expect(await verdictFor(body(60, 100))).toBe("available");
    expect(await verdictFor(body(99, 4))).toBe("available");
  });

  it("anything it cannot read → unknown", async () => {
    expect(await verdictFor({}, true)).toBe("unknown");
    expect(await verdictFor({ additional_rate_limits: body(100, 4).additional_rate_limits })).toBe("unknown");   // reserve row but no regular window
    expect(await verdictFor({}, false)).toBe("unknown");                                                          // HTTP error
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(codexQuotaVerdictFromUsage(await fetchCodexUsage())).toBe("unknown");
    expect(codexQuotaVerdictFromUsage({ status: "no-credentials", metrics: [] } as never)).toBe("unknown");
  });
});

describe("the lifecycle decision, with a logged reason", () => {
  function lifecycle(verdict: CodexQuotaVerdict, livePane: boolean) {
    const infos: Array<[Record<string, unknown>, string]> = [];
    const logger = { info: (o: Record<string, unknown>, m: string) => infos.push([o, m]), warn() {}, error() {}, debug() {} };
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger, eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic,
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`, verifyCodexQuota: async () => verdict,
    } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => livePane) });
    lc.attachIncidentHandlers("worker", daemon as any);
    return { daemon, infos, notifyInstanceTopic };
  }
  const hit = { name: "worker", type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" };

  it.each([
    ["available", false, "ignore"], ["reserve", false, "ignore"], ["exhausted", false, "pause"], ["unknown", false, "pause"],
    ["available", true, "ignore"], ["reserve", true, "ignore"], ["exhausted", true, "pause"], ["unknown", true, "pause"],
  ] as const)("verdict %s, live composer %s → %s, and the reason is logged", async (verdict, live, decision) => {
    const { daemon, infos, notifyInstanceTopic } = lifecycle(verdict, live);
    daemon.emit("pty_error", hit);
    await new Promise(r => setTimeout(r, 25));
    expect(daemon.requestPauseWhenIdle).toHaveBeenCalledTimes(decision === "pause" ? 1 : 0);
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(decision === "pause" ? 1 : 0);
    const logged = infos.find(([o]) => o.decision !== undefined);
    expect(logged?.[0]).toMatchObject({ backend: "codex", decision, evidence: `usage-${verdict}` });
    expect(logged?.[1]).toContain(`decision=${decision} evidence=usage-${verdict}`);
  });
});

// ───────────────────────────── E1: the menu AgEnD answered ─────────────────────────────

function makeDaemon(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1103-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logs: Array<Record<string, unknown>> = [];
  const logger = { debug: (o: Record<string, unknown>) => logs.push(o), info: (o: Record<string, unknown>) => logs.push(o), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("codex-1103", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initial, onKey: null as null | ((k: string) => void) };
  const keys: string[] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); state.onKey?.(k); return true; }),
    sendKeys: vi.fn(async () => true), pasteText: vi.fn(async () => true), pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9", getLastPasteError: () => null, isLastPasteFailureRecoverable: () => true, getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
  daemon.submitSystemPaste = vi.fn(async () => true);
  const errors: Array<{ type: string; action: string }> = [];
  daemon.on("pty_error", (e: { type: string; action: string }) => errors.push(e));
  const pauses = () => errors.filter(e => e.type === "quota" && e.action === "pause").length;
  return { daemon, state, keys, errors, pauses, logs };
}

describe("without any proof of Luna Reserve, a real hit is a pause candidate", () => {
  it("the real 0.160.0 pane — error line, then the live composer — raises quota/pause", () => {
    const { daemon, pauses } = makeDaemon(REAL_HIT);
    const b = daemon.backend as CodexBackend;
    daemon.evaluateErrorPatterns(REAL_HIT, b.getErrorPatterns(), b.getReadyPattern(), 1_000_000);
    expect(pauses()).toBe(1);                                      // before: 0 (swallowed by the live-composer guard)
  });

  it("an ordinary pane raises nothing", () => {
    const { daemon, errors } = makeDaemon(AFTER_ESCAPE.replace(ERROR_LINE, "ok"));
    const b = daemon.backend as CodexBackend;
    daemon.evaluateErrorPatterns("› hi\n• ok\n" + COMPOSER, b.getErrorPatterns(), b.getReadyPattern(), 1_000_000);
    expect(errors).toEqual([]);
  });
});

describe("after AgEnD answered the Luna Reserve menu, its stale text never pauses", () => {
  it("menu → Escape → live composer with the old line: nothing raised; a SECOND hit afterwards is", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, errors, pauses, logs } = makeDaemon(RESERVE_MENU);
    state.onKey = k => { if (k === "Escape") state.pane = AFTER_ESCAPE; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(16_000);                     // tick 1 answers the menu, later ticks see the stale line
    expect(keys).toEqual(["Escape"]);
    expect(errors.filter(e => e.type === "quota" && e.action === "pause")).toEqual([]);
    expect(logs.some(l => l.evidence === "reserve-menu-seen")).toBe(true);

    state.pane = SECOND_HIT;                                       // the reserve ran out too: a new occurrence
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(1);
    expect(logs.some(l => l.decision === "candidate" && l.evidence === "new-hit-after-reserve")).toBe(true);
    daemon.freezeRuntimeMonitors();
  });

  it("the handled lines scrolling out lowers the proof: 1 → 0 → a NEW single hit is still a candidate", async () => {
    vi.useFakeTimers();
    const { daemon, state, pauses } = makeDaemon(RESERVE_MENU);
    state.onKey = k => { if (k === "Escape") state.pane = AFTER_ESCAPE; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(0);
    state.pane = ["› and so on", "• ok", "  Worked for 3s", COMPOSER].join("\n");        // the old line scrolled out: 0
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pauses()).toBe(0);
    state.pane = ["• ok", "› again", ERROR_LINE.replace("8:00 AM", "9:30 AM"), COMPOSER].join("\n");   // one NEW hit: 1
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(1);                                      // before: swallowed for good (1 <= the menu-time 1)
    daemon.freezeRuntimeMonitors();
  });

  it("…and partially: 2 → 1 → a NEW hit makes 2 again, which is a candidate", async () => {
    vi.useFakeTimers();
    const second = ERROR_LINE.replace("8:00 AM", "7:00 AM");
    const MENU_WITH_TWO = RESERVE_MENU.replace("› hello", `› earlier\n${second}\n› hello`);
    const { daemon, state, pauses } = makeDaemon(MENU_WITH_TWO);
    state.onKey = k => { if (k === "Escape") state.pane = ["› earlier", second, "› hello", ERROR_LINE, "• ok", COMPOSER].join("\n"); };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(0);                                      // both old lines: stale, same as before
    state.pane = ["› hello", ERROR_LINE, "• ok", COMPOSER].join("\n");                      // the older one scrolled out: 1
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pauses()).toBe(0);
    state.pane = ["› hello", ERROR_LINE, "• ok", "› again", ERROR_LINE.replace("8:00 AM", "9:30 AM"), COMPOSER].join("\n");   // new hit: 2
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(1);
    daemon.freezeRuntimeMonitors();
  });

  it("the proof belongs to its spawn: after a respawn the same stale line is a candidate again", async () => {
    vi.useFakeTimers();
    const { daemon, state, pauses } = makeDaemon(RESERVE_MENU);
    state.onKey = k => { if (k === "Escape") state.pane = AFTER_ESCAPE; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(0);
    daemon.spawnGeneration++;                                      // a new CLI process: no menu seen in it
    daemon.lastErrorCount.clear();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pauses()).toBe(1);
    daemon.freezeRuntimeMonitors();
  });

  it("only the Luna Reserve menu counts: another dialog's key records nothing", () => {
    const { daemon, pauses } = makeDaemon(AFTER_ESCAPE);
    daemon.noteCodexReserveDialog({ autoResolutionKey: "codex-authorized-folder-trust" }, RESERVE_MENU);
    daemon.noteCodexReserveDialog({}, RESERVE_MENU);
    expect(daemon.codexReserveAck).toBeNull();
    const b = daemon.backend as CodexBackend;
    daemon.evaluateErrorPatterns(AFTER_ESCAPE, b.getErrorPatterns(), b.getReadyPattern(), 1_000_000);
    expect(pauses()).toBe(1);
  });

  it("a menu AgEnD never saw gives no proof: the stale line on a live composer is a candidate", async () => {
    vi.useFakeTimers();
    const { daemon, pauses } = makeDaemon(AFTER_ESCAPE);          // e.g. a human answered it before the 5 s poll
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pauses()).toBe(1);                                      // the lifecycle's usage probe then decides (E2)
    daemon.freezeRuntimeMonitors();
  });
});
