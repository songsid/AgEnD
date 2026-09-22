import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon, backendNeedsPaneReloadNotice, warmupNoticeAction } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import type { Logger } from "../src/logger.js";
import type { CliBackend } from "../src/backend/types.js";
import type { TmuxManager } from "../src/tmux-manager.js";

/**
 * These tests drive one code path through a daemon whose collaborators are
 * stubs with only the members that path touches. Widening through `unknown`
 * names what each stub stands in for — `as any` would also switch off checking
 * for every use of it afterwards.
 */
const standingIn = <T,>(stub: object): T => stub as unknown as T;

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
/** Warnings the daemon emitted during the current test. */
let warns: unknown[] = [];
const capturingLogger = {
  child: () => ({
    debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: (...args: unknown[]) => { warns.push(args[1] ?? args[0]); },
  }),
} as unknown as Logger;
type AnyDaemon = Daemon & Record<string, any>;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(opts: {
  instructionsReloadedOnResume?: boolean;
  binaryName?: string;
  pasteQueueDepth?: number;
  warmupNeeded?: boolean;
}): { daemon: AnyDaemon; pasteText: ReturnType<typeof vi.fn>; enter: ReturnType<typeof vi.fn>; dir: string } {
  warns = [];
  const dir = mkdtempSync(join(tmpdir(), "agend-warmup-"));
  dirs.push(dir);
  const daemon = new Daemon("warmup-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, capturingLogger) as AnyDaemon;

  // The notice goes out through the shared submit primitive (submitSystemPaste):
  // paste WITHOUT Enter, then Enter, then confirm it left the input row. The
  // pane echoes whatever was pasted, which is what a CLI does on submit.
  let pane = "";
  const pasteText = vi.fn(async (text: string) => { pane = text; return true; });
  const enter = vi.fn(async () => true);
  daemon["backend"] = standingIn<CliBackend>({
    binaryName: opts.binaryName ?? "kiro-cli",
    ...(opts.instructionsReloadedOnResume !== undefined
      ? { instructionsReloadedOnResume: opts.instructionsReloadedOnResume }
      : {}),
  });
  daemon["tmux"] = standingIn<TmuxManager>({
    pasteBuffer: pasteText,
    sendSpecialKey: enter,
    capturePane: async () => pane,
    getLastSendSpecialKeyError: () => null,
  });
  // paneWriteLock is readonly on the daemon, so the write goes through a view
  // that says so rather than through `any`.
  (daemon as unknown as { paneWriteLock: { run: (fn: () => Promise<unknown>) => Promise<unknown> } })
    .paneWriteLock = { run: async (fn: () => Promise<unknown>) => await fn() };
  // A real daemon has a control client; stubbing it takes the same branch
  // production does and skips the 5s fallback timer.
  writeFileSync(join(dir, "window-id"), "warmup-win");
  daemon["controlClient"] = standingIn<NonNullable<Daemon["controlClient"]>>(
    { waitForIdle: vi.fn().mockResolvedValue(undefined) });
  daemon["warmupNeeded"] = opts.warmupNeeded ?? true;
  daemon["pasteQueueDepth"] = opts.pasteQueueDepth ?? 1;
  daemon["lastBuiltInstructions"] = "INSTRUCTIONS-v2";
  return { daemon, pasteText, enter, dir };
}

const prevFile = (dir: string) => join(dir, "prev-instructions");

describe("runWarmupInstructionNotice (through the real call site)", () => {
  it("does not paste to a backend that reloads instructions on resume", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ instructionsReloadedOnResume: true, binaryName: "claude" });

    await daemon["runWarmupInstructionNotice"]();

    expect(pasteText, "claude-code already has the new instructions").not.toHaveBeenCalled();
    expect(daemon["pendingInstructionsNotice"], "and must not be queued one either").toBeFalsy();
    // The snapshot still advances: the resume delivered the instructions.
    expect(existsSync(prevFile(dir))).toBe(true);
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  it("pastes to a backend that cannot reload on its own, and submits it", async () => {
    const { daemon, pasteText, enter, dir } = makeDaemon({ binaryName: "kiro-cli" });

    await daemon["runWarmupInstructionNotice"]();

    expect(pasteText, "kiro must still be told").toHaveBeenCalledTimes(1);
    expect(String(pasteText.mock.calls[0][0])).toContain(".kiro/steering/agend-warmup-test.md");
    // A backend with no readable input row keeps exactly what it had before:
    // the unconditional second Enter for a queue-less TUI that swallows the
    // first. Narrowing that to one Enter because "the text is visible" would be
    // the very inference this change exists to remove.
    expect(enter, "the defensive double-Enter must survive for unverifiable backends").toHaveBeenCalledTimes(2);
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  // The instruction-reload notice used to go out through tmux.pasteText: paste,
  // one Enter, no verification at all. A dropped Enter left it sitting in the
  // input row, where the next delivery's Enter submitted both as one message.
  // It now shares the delivery path's submit primitive, so a strand is noticed.
  it("retries and reports when the notice is left sitting in the input row", async () => {
    const { daemon, pasteText, enter, dir } = makeDaemon({ binaryName: "codex" });
    const codexDir = mkdtempSync(join(tmpdir(), "agend-warmup-codex-"));
    dirs.push(codexDir);
    daemon["backend"] = new CodexBackend(codexDir);
    // Codex's input row still holds the notice: the Enter never submitted it.
    daemon["tmux"]!.capturePane = async () =>
      `› ${String(pasteText.mock.calls[0]?.[0] ?? "")}\n  Context 63% left`;

    await daemon["runWarmupInstructionNotice"]();

    expect(pasteText, "the notice is pasted once, not re-pasted on top of itself").toHaveBeenCalledTimes(1);
    expect(enter, "an unsubmitted notice gets one more Enter").toHaveBeenCalledTimes(2);
    expect(warns.some(w => String(w).includes("may not have been submitted")),
      "and a strand it could not fix must be reported, not assumed delivered").toBe(true);
    // Recording the new instructions here would mark the agent as told about a
    // notice it never received, and every later restart would skip the reload.
    expect(existsSync(prevFile(dir)), "an unsubmitted notice must not be recorded as delivered").toBe(false);
    expect(daemon["pendingInstructionsNotice"], "it is handed to the next real message instead").toBe(true);
  });

  it("defers instead of pasting when nobody is talking to the instance", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ pasteQueueDepth: 0 });

    await daemon["runWarmupInstructionNotice"]();

    expect(pasteText, "an idle instance must not be provoked").not.toHaveBeenCalled();
    expect(daemon["pendingInstructionsNotice"], "it fires on the next real message").toBe(true);
    expect(readFileSync(prevFile(dir), "utf-8")).toBe("INSTRUCTIONS-v2");
  });

  it("does nothing at all when the instructions did not change", async () => {
    const { daemon, pasteText, dir } = makeDaemon({ warmupNeeded: false });

    await daemon["runWarmupInstructionNotice"]();

    expect(pasteText).not.toHaveBeenCalled();
    expect(daemon["pendingInstructionsNotice"]).toBeFalsy();
    // Nothing was told to anyone, so nothing is recorded as told.
    expect(existsSync(prevFile(dir)), "an unchanged restart must not rewrite the snapshot").toBe(false);
  });

  it("survives a paste failure rather than failing the spawn", async () => {
    const { daemon } = makeDaemon({});
    daemon["tmux"] = standingIn<TmuxManager>({ pasteText: vi.fn().mockRejectedValue(new Error("pane gone")) });

    await expect(daemon["runWarmupInstructionNotice"]()).resolves.toBeUndefined();
  });
});
