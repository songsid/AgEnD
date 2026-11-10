/**
 * 2.1.322 audit: Claude's cold-resume prompt (with the server's summary option and the new-conversation focus) paints
 * before it takes keys. The Escape AgEnD sent on first sight was dropped — live, 5 of 6 launches on 2.1.322 and 1 of 6
 * on 2.1.319 — and the one-shot answer then left the prompt up for good: the startup scan read the menu's own `❯` as
 * ready and the runtime scanner never answered it again (deliveries held; a person had to press Escape).
 *
 * Escape there is the prompt's own "resume" (or "dismiss"): it keeps the conversation either way, so the answer is
 * retrySafe — re-sent while the SAME exact prompt is still up, at most 3 sends, each at least 1 s after the last. And
 * no answered dialog that is still on screen passes the startup scan's ready check. Fixtures: the live 2.1.322 frames
 * (scripts/manual/claude-version-audit/cold-resume, the summary-newfocus case). Real Daemon and ClaudeCodeBackend,
 * fake timers (performance.now included), a stub tmux that drops the first N Escapes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon } from "../src/daemon.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const PROMPT = fx("claude-2.1.322-cold-resume-live-summary-newfocus");
const AFTER = fx("claude-2.1.322-cold-resume-live-after-escape");
/** The same title with options AgEnD does not know: the hold entry's screen, never answered. */
const UNKNOWN = PROMPT.replace("3. Resume from summary ", "3. Resume elsewhere    ");

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real backend; `oneShot` strips retrySafe (the pre-fix entry: verifyAfterKeys + autoResolutionKey, one send). */
function backendFor(dir: string, oneShot = false) {
  const b = new ClaudeCodeBackend(dir);
  if (oneShot) {
    const strip = <T extends { retrySafe?: unknown }>(list: T[]) => list.map(({ retrySafe: _drop, ...d }) => d as T);
    const s = b.getStartupDialogs!.bind(b), r = b.getRuntimeDialogs!.bind(b);
    b.getStartupDialogs = () => strip(s()); b.getRuntimeDialogs = () => strip(r());
  }
  return b;
}

/** A daemon whose stub tmux drops the first `drop` Escapes, then turns the screen into `after` on the next one. */
function rig(opts: { pane?: string; drop: number; after?: string; oneShot?: boolean; onEscape?: (n: number, state: { pane: string }) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2322-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon: any = new Daemon("worker", {
    working_directory: dir, backend: "claude-code", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
  } as any, dir, false, backendFor(dir, opts.oneShot) as any, undefined, { child: () => logger } as any);
  const state = { pane: opts.pane ?? PROMPT };
  const keys: { key: string; at: number }[] = [];
  let escapes = 0;
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (key: string) => {
      keys.push({ key, at: performance.now() });
      if (key === "Escape") {
        escapes++;
        opts.onEscape?.(escapes, state);
        if (escapes > opts.drop && opts.after !== undefined) state.pane = opts.after;
      }
      return true;
    }),
    sendKeys: vi.fn(async () => true), pasteText: vi.fn(async () => true), pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9", getLastPasteError: () => null, isLastPasteFailureRecoverable: () => true, getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
  daemon.submitSystemPaste = vi.fn(async () => true);
  vi.spyOn(daemon, "paneLiveness").mockResolvedValue("alive");
  const warned = (text: string) => logger.warn.mock.calls.some((c: unknown[]) => c.includes(text));
  return { daemon, state, keys, warned };
}

/** Run the startup scan to its end under fake timers; resolves with its verdict and how long it took (monotonic). */
async function startupScan(daemon: any, budgetMs: number) {
  const t0 = performance.now();
  let verdict: boolean | undefined;
  const done = daemon.dismissDialogsUntilReady(budgetMs, 250).then((v: boolean) => { verdict = v; });
  for (let i = 0; i < (budgetMs + 4_000) / 100 && verdict === undefined; i++) await vi.advanceTimersByTimeAsync(100);
  await done;
  return { verdict, tookMs: performance.now() - t0 };
}

const gaps = (keys: { at: number }[]) => keys.slice(1).map((k, i) => k.at - keys[i]!.at);

describe("fixtures", () => {
  it("the live prompt is the exact retrySafe entry (Escape); the variant is the hold; the after-frame is ready", () => {
    const b = new ClaudeCodeBackend("/tmp/agend-test-2322-nonexistent");
    const hit = (pane: string) => b.getStartupDialogs!().find(d => { d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); });
    expect(hit(PROMPT)?.keys).toEqual(["Escape"]);
    expect(hit(PROMPT)?.retrySafe).toEqual({ max: 3, afterMs: 1_000 });
    expect(hit(UNKNOWN)?.holdOnly).toBe(true);
    expect(hit(AFTER)).toBeUndefined();
    // the reason the prompt can never be left to the ready check: its own menu row carries the ready glyph
    expect(b.getReadyPattern().test(PROMPT)).toBe(true);
    // the retrySafe flag is on the cold-resume answer only
    const retrySafe = [...b.getStartupDialogs!(), ...b.getRuntimeDialogs!()].filter(d => d.retrySafe).map(d => d.autoResolutionKey);
    expect(new Set(retrySafe)).toEqual(new Set(["claude-cold-resume-prompt"]));
  });
});

describe("startup scan: a dropped Escape on the cold-resume prompt", () => {
  it("is sent again (≥ 1 s later) and the scan ends ready on the conversation", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = rig({ drop: 1, after: AFTER });
    const { verdict } = await startupScan(daemon, 20_000);
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape"]);
    expect(gaps(keys)[0]).toBeGreaterThanOrEqual(1_000);
    expect(verdict).toBe(true);
    expect(state.pane).toBe(AFTER);
  });

  it("never more than 3 sends, and a prompt that stays up is never read as ready", async () => {
    vi.useFakeTimers();
    const { daemon, keys, warned } = rig({ drop: Infinity });
    const { tookMs } = await startupScan(daemon, 20_000);
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape", "Escape"]);
    for (const gap of gaps(keys)) expect(gap).toBeGreaterThanOrEqual(1_000);
    // it waited out its budget on the dialog instead of declaring the `❯` menu ready after two polls
    expect(tookMs).toBeGreaterThanOrEqual(20_000);
    expect(warned("Startup scan exhausted with a dialog still on screen — reporting the CLI alive; deliveries stay blocked until it is answered")).toBe(true);
    expect(warned("Startup scan exhausted without a ready prompt or a known dialog — assuming ready (unknown CLI screen)")).toBe(false);
  });

  it("control: the first Escape took — one send, nothing more", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = rig({ drop: 0, after: AFTER });
    const { verdict } = await startupScan(daemon, 10_000);
    expect(keys.map(k => k.key)).toEqual(["Escape"]);
    expect(verdict).toBe(true);
  });

  it("control: the screen became a different prompt after the first Escape — no further key at all", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = rig({ drop: Infinity, onEscape: (_n, state) => { state.pane = UNKNOWN; } });
    await startupScan(daemon, 10_000);
    expect(keys.map(k => k.key)).toEqual(["Escape"]);
  });

  it("control: a one-shot answer (no retrySafe) is never repeated — and its still-visible screen is not ready either", async () => {
    vi.useFakeTimers();
    const { daemon, keys, warned } = rig({ drop: Infinity, oneShot: true });
    const { tookMs } = await startupScan(daemon, 10_000);
    expect(keys.map(k => k.key)).toEqual(["Escape"]);
    expect(tookMs).toBeGreaterThanOrEqual(10_000);
    expect(warned("Startup scan exhausted with a dialog still on screen — reporting the CLI alive; deliveries stay blocked until it is answered")).toBe(true);
  });
});

describe("runtime scanner: the prompt painted after startup (idle trigger or a late resume)", () => {
  it("a dropped Escape is re-sent on a later poll, at most 3 sends in all, ≥ 1 s apart", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = rig({ drop: Infinity });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(60_000);
    daemon.freezeRuntimeMonitors();
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape", "Escape"]);
    for (const gap of gaps(keys)) expect(gap).toBeGreaterThanOrEqual(1_000);
  });

  it("the second send takes: the prompt is gone and nothing more is sent", async () => {
    vi.useFakeTimers();
    const { daemon, keys, state } = rig({ drop: 1, after: AFTER });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(40_000);
    daemon.freezeRuntimeMonitors();
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape"]);
    expect(state.pane).toBe(AFTER);
  });

  it("a prompt that comes back later (a new episode) gets a fresh budget of 3 sends", async () => {
    vi.useFakeTimers();
    // first episode: two dropped, the third send takes (the whole budget used)
    const { daemon, keys, state } = rig({ drop: 2, after: AFTER });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape", "Escape"]);
    expect(state.pane).toBe(AFTER);
    // the idle timer paints it again, and this time every key is dropped: three more sends, then nothing
    daemon.tmux.sendSpecialKey.mockImplementation(async (key: string) => { keys.push({ key, at: performance.now() }); return true; });
    state.pane = PROMPT;
    await vi.advanceTimersByTimeAsync(60_000);
    daemon.freezeRuntimeMonitors();
    expect(keys.map(k => k.key)).toEqual(["Escape", "Escape", "Escape", "Escape", "Escape", "Escape"]);
  });

  it("control: a different prompt after the first Escape gets no key", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = rig({ drop: Infinity, onEscape: (_n, state) => { state.pane = UNKNOWN; } });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(60_000);
    daemon.freezeRuntimeMonitors();
    expect(keys.map(k => k.key)).toEqual(["Escape"]);
  });
});
