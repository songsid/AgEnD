import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon, backendNeedsPaneReloadNotice, warmupNoticeAction } from "../src/daemon.js";
import type { Logger } from "../src/logger.js";

/**
 * Two places can tell an agent its instructions moved: the warmup paste, and the
 * deferred pendingInstructionsNotice that fires on the next real message. Only
 * the second one excluded backends that re-read instructions on resume, so
 * claude-code was still being told to reload instructions the resume had just
 * given it. Both now ask backendNeedsPaneReloadNotice, so they cannot drift
 * apart again.
 */
describe("backendNeedsPaneReloadNotice", () => {
  it("does not notify a backend that re-reads instructions on resume", () => {
    expect(backendNeedsPaneReloadNotice({ instructionsReloadedOnResume: true })).toBe(false);
  });

  it("notifies a backend that does not", () => {
    expect(backendNeedsPaneReloadNotice({ instructionsReloadedOnResume: false })).toBe(true);
    expect(backendNeedsPaneReloadNotice({})).toBe(true);
    expect(backendNeedsPaneReloadNotice(undefined)).toBe(true);
  });
});

describe("warmupNoticeAction", () => {
  const reloads = { instructionsReloadedOnResume: true };
  const doesNot = { instructionsReloadedOnResume: false };

  it("says nothing when the instructions did not change", () => {
    expect(warmupNoticeAction({ warmupNeeded: false, backend: doesNot, pasteQueueDepth: 3 })).toBe("skip");
  });

  it("says nothing to a backend that reloads on resume, even with a delivery in flight", () => {
    // The regression this fix exists for: the warmup path used to reach the
    // paste regardless of the backend, so claude-code got a redundant notice.
    expect(warmupNoticeAction({ warmupNeeded: true, backend: reloads, pasteQueueDepth: 3 })).toBe("skip");
  });

  it("defers to the next real message when nobody is talking to the instance", () => {
    expect(warmupNoticeAction({ warmupNeeded: true, backend: doesNot, pasteQueueDepth: 0 })).toBe("defer");
  });

  it("pastes now when a delivery is already in flight", () => {
    expect(warmupNoticeAction({ warmupNeeded: true, backend: doesNot, pasteQueueDepth: 1 })).toBe("paste");
  });

  it("never reaches defer or paste for a backend that needs no notice", () => {
    // The alignment itself: whatever the queue depth, a backend excluded by the
    // shared predicate is excluded by the warmup path too.
    for (const depth of [0, 1, 5]) {
      expect(warmupNoticeAction({ warmupNeeded: true, backend: reloads, pasteQueueDepth: depth })).toBe("skip");
    }
  });

  it("skips exactly when the shared predicate says no notice is needed", () => {
    for (const backend of [reloads, doesNot, {}, undefined]) {
      const action = warmupNoticeAction({ warmupNeeded: true, backend, pasteQueueDepth: 2 });
      expect(action === "skip", `backend ${JSON.stringify(backend)}`)
        .toBe(!backendNeedsPaneReloadNotice(backend));
    }
  });
});

describe("the real backends", () => {
  it("excludes claude-code and includes the CLIs that cannot re-read on resume", async () => {
    const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
    const claude = new (ClaudeCodeBackend as any)("/tmp/probe-instance");
    expect(backendNeedsPaneReloadNotice(claude), "claude-code re-reads on resume").toBe(false);

    // kiro/codex/grok/agy declare nothing, so they still need the pane notice —
    // the behaviour this fix must not weaken.
    for (const mod of ["kiro.js", "codex.js", "grok.js"]) {
      const exports: Record<string, any> = await import(`../src/backend/${mod}`);
      const Ctor = Object.values(exports).find(v => typeof v === "function" && /Backend$/.test((v as any).name));
      expect(Ctor, `a backend class in ${mod}`).toBeTruthy();
      const be = new (Ctor as any)("/tmp/probe-instance");
      expect(backendNeedsPaneReloadNotice(be), `${mod} still needs the notice`).toBe(true);
    }
  });
});

/**
 * The wiring, not just the decision.
 *
 * warmupNoticeAction's own tests keep passing if this call site stops consulting
 * it — verified by reverting the call site to its pre-fix logic and watching the
 * whole suite stay green. That is precisely the class of bug this change fixes
 * (a path that never asked whether the backend needed telling), so the
 * regression has to be driven through the real method.
 */
const rootLogger = pino({ level: "silent" }) as Logger;
type AnyDaemon = Daemon & Record<string, any>;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(opts: {
  instructionsReloadedOnResume?: boolean;
  binaryName?: string;
  pasteQueueDepth?: number;
  warmupNeeded?: boolean;
}): { daemon: AnyDaemon; pasteText: ReturnType<typeof vi.fn>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-warmup-"));
  dirs.push(dir);
  const daemon = new Daemon("warmup-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;

  const pasteText = vi.fn().mockResolvedValue(undefined);
  daemon.backend = {
    binaryName: opts.binaryName ?? "kiro-cli",
    ...(opts.instructionsReloadedOnResume !== undefined
      ? { instructionsReloadedOnResume: opts.instructionsReloadedOnResume }
      : {}),
  };
  daemon.tmux = { pasteText };
  daemon.paneWriteLock = { run: async (fn: () => Promise<void>) => { await fn(); } };
  // A real daemon has a control client; stubbing it takes the same branch
  // production does and skips the 5s fallback timer.
  writeFileSync(join(dir, "window-id"), "warmup-win");
  daemon.controlClient = { waitForIdle: vi.fn().mockResolvedValue(undefined) };
  daemon.warmupNeeded = opts.warmupNeeded ?? true;
  daemon.pasteQueueDepth = opts.pasteQueueDepth ?? 1;
  daemon.lastBuiltInstructions = "INSTRUCTIONS-v2";
  return { daemon, pasteText, dir };
}

const prevFile = (dir: string) => join(dir, "prev-instructions");

describe("runWarmupInstructionNotice (through the real call site)", () => {
  it("does not paste to a backend that reloads instructions on resume", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ instructionsReloadedOnResume: true, binaryName: "claude" });

    await daemon.runWarmupInstructionNotice();

    expect(pasteText, "claude-code already has the new instructions").not.toHaveBeenCalled();
    expect(daemon.pendingInstructionsNotice, "and must not be queued one either").toBeFalsy();
    // The snapshot still advances: the resume delivered the instructions.
    expect(existsSync(prevFile(dir))).toBe(true);
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  it("pastes to a backend that cannot reload on its own", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ binaryName: "kiro-cli" });

    await daemon.runWarmupInstructionNotice();

    expect(pasteText, "kiro must still be told").toHaveBeenCalledTimes(1);
    expect(String(pasteText.mock.calls[0][0])).toContain(".kiro/steering/agend-warmup-test.md");
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  it("defers instead of pasting when nobody is talking to the instance", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ pasteQueueDepth: 0 });

    await daemon.runWarmupInstructionNotice();

    expect(pasteText, "an idle instance must not be provoked").not.toHaveBeenCalled();
    expect(daemon.pendingInstructionsNotice, "it fires on the next real message").toBe(true);
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  it("does nothing at all when the instructions did not change", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ warmupNeeded: false });

    await daemon.runWarmupInstructionNotice();

    expect(pasteText).not.toHaveBeenCalled();
    expect(daemon.pendingInstructionsNotice).toBeFalsy();
    // Nothing was told to anyone, so nothing is recorded as told.
    expect(existsSync(prevFile(dir)), "an unchanged restart must not rewrite the snapshot").toBe(false);
  });

  it("survives a paste failure rather than failing the spawn", async () => {
    const { daemon } = makeDaemon({});
    daemon.tmux = { pasteText: vi.fn().mockRejectedValue(new Error("pane gone")) };

    await expect(daemon.runWarmupInstructionNotice()).resolves.toBeUndefined();
  });
});
