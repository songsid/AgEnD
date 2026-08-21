import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * Bug 1 — an expired Kiro session raised a "stuck, needs help" alert forever.
 *
 * The auth pattern fires and asks for a pause, but the pause was gated on the
 * pane reaching "idle". An auth-broken CLI cannot finish the turn it is holding,
 * so the pane never leaves "stuck": the pause never happened, pendingWork never
 * cleared, and the stuck detector re-fired on every 5s scan. The alert was also
 * useless — it offers Restart/Wait and asks General for help, when only the user
 * re-logging in fixes it.
 */
const NO_TOKEN_PANE = [
  "● Kiro is having trouble responding right now:",
  "   2: dispatch failure (other): No token",
  "   5: No token",
  "",
  "> ",
].join("\n");

function makeDaemon(name = "expired") {
  const instanceDir = mkdtempSync(join(tmpdir(), `agend-authstuck-${name}-`));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon(name, {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => /^> /m } as any, undefined,
    { child: () => logger } as any);
  return { daemon, instanceDir, logger };
}

/** Drive the stuck path the way the instance-state watcher does. */
function observeStuck(daemon: any, pane: string) {
  const hangs: unknown[] = [];
  daemon.hangDetector = { emit: (_e: string, d: unknown) => hangs.push(d) };
  daemon.pendingWork = { hasPendingWork: () => true, reset: () => {} };
  daemon.instanceStateReadyPattern = /^> /m;
  daemon.handleStuckTransition(pane, { unchangedForMs: 300_000, stateChangedAt: 0, state: "stuck" }, /^> /m);
  return hangs;
}

describe("expired auth must not raise stuck alerts forever", () => {
  it("suppresses the stuck alert once an auth failure is known", () => {
    const { daemon, instanceDir } = makeDaemon();
    try {
      const patterns = new KiroBackend("/tmp").getErrorPatterns();

      // Before the auth error is seen, a genuinely stuck pane still alerts.
      expect(observeStuck(daemon, "working on it\n")).toHaveLength(1);

      // The auth pattern fires (this is what #491 made match).
      const errors: any[] = [];
      daemon.on("pty_error", (e: unknown) => errors.push(e));
      (daemon as any).evaluateErrorPatterns(NO_TOKEN_PANE, patterns, /^> /m, 10 * 60_000);
      expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });

      // From here the alert is noise: only a re-login helps, and the user was
      // already told that once by the auth notification.
      expect(observeStuck(daemon, NO_TOKEN_PANE)).toHaveLength(0);
      expect(observeStuck(daemon, NO_TOKEN_PANE)).toHaveLength(0);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("still alerts on an ordinary hang that has nothing to do with auth", () => {
    // The suppression must be scoped to auth, or it would mask real hangs.
    const { daemon, instanceDir } = makeDaemon("plain");
    try {
      expect(observeStuck(daemon, "Compiling...\n")).toHaveLength(1);
      expect(observeStuck(daemon, "Compiling...\n")).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("resumes alerting after an explicit wake clears the auth failure", () => {
    const { daemon, instanceDir } = makeDaemon("woken");
    try {
      const patterns = new KiroBackend("/tmp").getErrorPatterns();
      (daemon as any).evaluateErrorPatterns(NO_TOKEN_PANE, patterns, /^> /m, 10 * 60_000);
      expect(observeStuck(daemon, NO_TOKEN_PANE)).toHaveLength(0);

      // wake() is the "user re-logged in and sent a message" path.
      (daemon as any).authFailureUnresolved = false;
      expect(observeStuck(daemon, "still going\n")).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("lets the deferred auth pause fire from a stuck pane, not only an idle one", () => {
    const { daemon, instanceDir } = makeDaemon("pausing");
    try {
      const requests: unknown[] = [];
      daemon.on("auto_pause_requested", (d: unknown) => requests.push(d));
      daemon.requestPauseWhenIdle();

      // Waiting for "idle" here waited forever — that was the bug.
      (daemon as any).applyInstanceStateSnapshot({ state: "stuck", stateChangedAt: 0, unchangedForMs: 300_000 });

      expect(requests).toHaveLength(1);
      expect((daemon as any).pausePending).toBe(false);
      // And the one-shot authorisation for pausing a stuck pane is armed.
      expect((daemon as any).pauseAllowStuck).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("does not let an ordinary idle-timeout pause tear down a stuck pane", () => {
    // pauseAllowStuck is a one-shot for the auth case; a normal pause must still
    // refuse a non-idle pane.
    const { daemon, instanceDir } = makeDaemon("guard");
    try {
      expect((daemon as any).pauseAllowStuck).toBe(false);
      (daemon as any).instanceState = "stuck";
      (daemon as any).pauseRequested = true;
      void daemon.pause();
      expect((daemon as any).pauseWakeState).not.toBe("pausing");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

/**
 * Bug 2 — after a fleet restart Codex opened its "Update available!" picker,
 * which owns the input loop until answered, so every Codex instance hung.
 * `check_for_update_on_startup = false` is Codex's own config key, so the prompt
 * is prevented rather than dismissed after the fact.
 */
describe("codex startup update check", () => {
  let root: string, shared: string, inst: string;
  const realCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-upd-"));
    shared = join(root, "shared"); inst = join(root, "inst");
    mkdirSync(shared, { recursive: true }); mkdirSync(inst, { recursive: true });
    process.env.CODEX_HOME = shared;
  });
  afterEach(() => {
    if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
    rmSync(root, { recursive: true, force: true });
  });

  function writeAndRead(base: string): string {
    writeFileSync(join(shared, "config.toml"), base);
    new CodexBackend(inst).writeConfig({
      workingDirectory: root, instanceDir: inst, instanceName: "t", mcpServers: {},
    } as any);
    return readFileSync(join(inst, "codex-home", "config.toml"), "utf-8");
  }
  const keyLine = (s: string) => s.split("\n").findIndex(l => /check_for_update_on_startup/.test(l));
  const firstSection = (s: string) => s.split("\n").findIndex(l => /^\s*\[/.test(l));

  it("disables the startup update check", () => {
    const out = writeAndRead(`model = "gpt-5.6-sol"\n`);
    expect(out).toMatch(/check_for_update_on_startup\s*=\s*false/);
  });

  it("puts the key above the first section, where TOML needs a top-level key", () => {
    // Below a [section] header TOML would read it as that section's key, and the
    // setting would silently do nothing.
    const out = writeAndRead(`model = "gpt-5.6-sol"\n[projects."/x"]\ntrust_level = "trusted"\n`);
    expect(keyLine(out)).toBeGreaterThanOrEqual(0);
    expect(keyLine(out)).toBeLessThan(firstSection(out));
  });

  it("still lands above the first section when the config opens with one", () => {
    const out = writeAndRead(`[tui]\nstatus_line = ["context-remaining"]\n`);
    expect(keyLine(out)).toBeLessThan(firstSection(out));
  });

  it("keeps a user's own setting instead of duplicating the key", () => {
    // TOML rejects duplicate keys, so appending blindly would corrupt the file —
    // and overriding a deliberate choice would be wrong anyway.
    const out = writeAndRead(`check_for_update_on_startup = true\n[tui]\nx = 1\n`);
    expect(out.match(/check_for_update_on_startup/g)).toHaveLength(1);
    expect(out).toMatch(/check_for_update_on_startup\s*=\s*true/);
  });

  it("works from an empty global config", () => {
    expect(writeAndRead("")).toMatch(/check_for_update_on_startup\s*=\s*false/);
  });
});

describe("codex update picker is dismissed if it appears anyway", () => {
  // Text taken from the codex binary's own strings.
  const PICKER = [
    "Update available!",
    "Release notes: https://github.com/openai/codex/releases/latest",
    "Skip until next version",
    " Press Enter to select   esc close   ctrl + u upgrade ",
  ].join("\n");

  const dialogs = () => new CodexBackend("/tmp/x").getRuntimeDialogs();

  it("matches the real picker and answers with Escape", () => {
    const d = dialogs().find(d => d.pattern.test(PICKER));
    expect(d).toBeDefined();
    // Enter would select the highlighted row and ctrl+u would swap the binary
    // under a running fleet; Escape is what Codex itself documents as "close".
    expect(d!.keys).toEqual(["Escape"]);
  });

  it("does not fire on prose about a Codex release", () => {
    for (const prose of [
      "Update available! I'll upgrade codex later.",
      "See the release notes for the new version.",
    ]) {
      expect(dialogs().some(d => d.pattern.test(prose))).toBe(false);
    }
  });

  it("leaves the rate-limit dialog untouched", () => {
    const rl = "Approaching rate limits\nSwitch to gpt-5.4 for lower credit use";
    const d = dialogs().find(d => d.pattern.test(rl));
    expect(d?.keys).toEqual(["Down", "Down", "Enter"]);
  });
});
