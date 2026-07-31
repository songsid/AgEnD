import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `pasteText` sends Enter twice: the second in case a busy TUI swallowed the
 * first. Its comment claimed the extra Enter "is a no-op on an empty input for
 * all supported CLIs" — while `deliverMessage`, in the same file tree, says the
 * opposite about the same keystroke:
 *
 *   "Do NOT probe for busy — a second bare Enter can mutate the queue."
 *
 * Both cannot be true. The delivery path learned it from a real backend (codex,
 * the one with `supportsQueuedInput() === true`), so the retry is now conditional
 * on that capability.
 */

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

const { TmuxManager } = await import("../src/tmux-manager.js");
const { Daemon } = await import("../src/daemon.js");

/** Record the tmux verbs a paste issues, in order. */
function recordTmux(): string[] {
  const calls: string[] = [];
  execFile.mockImplementation((_cmd: string, args: string[], cb: (e: Error | null, out: string) => void) => {
    const verb = args.find(a => ["set-buffer", "paste-buffer", "send-keys"].includes(a));
    if (verb) calls.push(verb === "send-keys" ? `send-keys ${args[args.length - 1]}` : verb);
    cb(null, "");
  });
  return calls;
}

beforeEach(() => { execFile.mockReset(); });

describe("pasteText Enter retry", () => {
  it("sends the retry Enter by default", async () => {
    const calls = recordTmux();
    await new TmuxManager("s", "@1").pasteText("hello");

    expect(calls).toEqual(["set-buffer", "paste-buffer", "send-keys Enter", "send-keys Enter"]);
  }, 10_000);

  it("sends exactly one Enter when the caller opts out", async () => {
    const calls = recordTmux();
    await new TmuxManager("s", "@1").pasteText("hello", { retryEnter: false });

    expect(calls).toEqual(["set-buffer", "paste-buffer", "send-keys Enter"]);
  }, 10_000);

  it("treats an absent option as the long-standing behaviour", async () => {
    // Every existing caller passes nothing; none of them may change behaviour.
    const calls = recordTmux();
    await new TmuxManager("s", "@1").pasteText("hello", {});

    expect(calls.filter(c => c === "send-keys Enter")).toHaveLength(2);
  }, 10_000);
});

describe("daemon's system-paste policy", () => {
  function makeDaemon(backend: unknown) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-enter-retry-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("er", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, backend as any, undefined, { child: () => logger } as any);
    const opts = () => (daemon as any).systemPasteOptions() as { retryEnter: boolean };
    return { opts, instanceDir };
  }

  it("keeps the retry for a backend without a native input queue", () => {
    const { opts, instanceDir } = makeDaemon({ getReadyPattern: () => /❯/ });
    try {
      expect(opts()).toEqual({ retryEnter: true });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("drops the retry for a backend that queues input natively", () => {
    const { opts, instanceDir } = makeDaemon({
      getReadyPattern: () => /❯/,
      supportsQueuedInput: () => true,
    });
    try {
      expect(opts()).toEqual({ retryEnter: false });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("keeps the retry when the backend declines the capability explicitly", () => {
    const { opts, instanceDir } = makeDaemon({
      getReadyPattern: () => /❯/,
      supportsQueuedInput: () => false,
    });
    try {
      expect(opts()).toEqual({ retryEnter: true });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("keeps the retry in lightweight mode, where there is no backend at all", () => {
    const { opts, instanceDir } = makeDaemon(undefined);
    try {
      expect(opts()).toEqual({ retryEnter: true });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
