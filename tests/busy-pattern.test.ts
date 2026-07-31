import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const STUCK_MS = 10 * 60_000;

/**
 * Panes below are verbatim tails captured from two live AgEnD-managed
 * claude-code windows — one generating, one waiting. Both show `❯` and both show
 * the `ok` line that AgEnD's own statusline script prints, which is why neither
 * marker can tell the two apart.
 */
const WORKING_PANE = [
  "✽ Accomplishing… (10m 58s · ↓ 37.0k tokens)",
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  ok",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

const IDLE_PANE = [
  "✻ Worked for 6m 49s",
  "",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  ok",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("ClaudeCodeBackend ready/busy patterns", () => {
  const backend = new ClaudeCodeBackend(mkdtempSync(join(tmpdir(), "agend-cc-pat-")));

  it("no longer matches AgEnD's own statusline output as a ready marker", () => {
    // writeStatusLineScript emits `console.log('ok')`, so the old
    // `/❯|ok\s*$/m` alternative was matching a line this very backend writes.
    expect(backend.getReadyPattern().test("  ok")).toBe(false);
    expect(backend.getReadyPattern().test("❯ ")).toBe(true);
  });

  it("separates a generating pane from a waiting one", () => {
    const ready = backend.getReadyPattern();
    const busy = backend.getBusyPattern();

    // The ready marker alone cannot do it — that is the whole problem.
    expect(ready.test(WORKING_PANE)).toBe(true);
    expect(ready.test(IDLE_PANE)).toBe(true);

    expect(busy.test(WORKING_PANE)).toBe(true);
    expect(busy.test(IDLE_PANE)).toBe(false);
  });

  it("matches the spinner whatever glyph and verb it is showing", () => {
    const busy = backend.getBusyPattern();
    for (const line of [
      "✢ Accomplishing… (11m 26s · ↓ 38.0k tokens)",
      "✽ Thinking… (5s)",
      "· Cogitating… (1h 2m · ↑ 3.1k tokens)",
    ]) {
      expect(busy.test(line), line).toBe(true);
    }
  });

  it("rejects prose shaped like a spinner", () => {
    // A false positive on a *stable* pane would pin the instance in `working`
    // forever: no auto-pause, no cancel-button retirement, eventually a bogus
    // hang alert. These are the shapes most likely to show up in agent output.
    const busy = backend.getBusyPattern();
    for (const line of [
      "✻ Worked for 6m 49s",
      "- Something happened… (5s ago)",
      "  ⎿  Tip: Use /btw to ask a quick side question",
      "I waited… (30s) for the build",
      "> quoted… (2s)",
      "3. Label rename (July 27) — done",
    ]) {
      expect(busy.test(line), line).toBe(false);
    }
  });
});

describe("PaneStateMachine with a busy pattern", () => {
  const ready = /❯/;
  const busy = /SPINNING…/;

  it("reaches stuck on a frozen pane whose ready marker is always present", () => {
    // Without the veto this is unreachable: `❯` is on screen, so every stable
    // observation reports idle and the stuck edge — and therefore the hang
    // notification — can never fire.
    const machine = new PaneStateMachine(ready, STUCK_MS, 0, busy);

    expect(machine.observe("SPINNING… (3s)\n❯ ", 1).state).toBe("working");
    expect(machine.observe("SPINNING… (3s)\n❯ ", STUCK_MS).state).toBe("working");
    expect(machine.observe("SPINNING… (3s)\n❯ ", STUCK_MS + 1).state).toBe("stuck");
  });

  it("still reports idle once the spinner is gone", () => {
    const machine = new PaneStateMachine(ready, STUCK_MS, 0, busy);

    machine.observe("SPINNING… (3s)\n❯ ", 1);
    expect(machine.observe("Worked for 3s\n❯ ", 2).state).toBe("working"); // motion
    expect(machine.observe("Worked for 3s\n❯ ", 3).state).toBe("idle");
  });

  it("keeps the old behaviour for backends that supply no busy pattern", () => {
    const machine = new PaneStateMachine(ready, STUCK_MS, 0);

    expect(machine.observe("SPINNING… (3s)\n❯ ", 1).state).toBe("idle");
    expect(machine.observe("SPINNING… (3s)\n❯ ", STUCK_MS + 1).state).toBe("idle");
  });

  it("strips g/y flags from the busy pattern so results do not alternate", () => {
    const machine = new PaneStateMachine(ready, STUCK_MS, 0, /SPINNING…/g);

    // A stateful regex would flip between true and false on identical content,
    // making the state oscillate between working and idle every poll.
    machine.observe("SPINNING…\n❯ ", 1);
    expect(machine.observe("SPINNING…\n❯ ", 2).state).toBe("working");
    expect(machine.observe("SPINNING…\n❯ ", 3).state).toBe("working");
    expect(machine.observe("SPINNING…\n❯ ", 4).state).toBe("working");
  });
});

describe("error recovery gate honours the busy veto", () => {
  function makeDaemon(name: string) {
    const instanceDir = mkdtempSync(join(tmpdir(), `agend-busy-gate-${name}-`));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon(name, {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined,
      { child: () => logger } as any);
    return { daemon, instanceDir };
  }

  const PATTERN = { pattern: /API Error: Rate limit/i, type: "rate_limit", action: "notify", message: "rate limited" } as any;

  it("does not declare recovery while the pane is still generating", () => {
    const { daemon, instanceDir } = makeDaemon("gate");
    const recovered = vi.fn();
    daemon.on("pty_recovered", recovered);
    try {
      // Well past ERROR_COOLDOWN_MS from the zero epoch, or the first detection
      // is swallowed as a cooldown hit.
      const t0 = 10 * 60_000;
      const errPane = "API Error: Rate limit\n❯ ";
      (daemon as any).evaluateErrorPatterns(errPane, [PATTERN], /❯/, t0, /SPINNING…/);
      expect((daemon as any).errorWaitingForRecovery).toBe(true);

      // `❯` is on screen the entire time. Before the veto this tick reported
      // recovery while the rate-limit error was still displayed.
      (daemon as any).evaluateErrorPatterns("SPINNING… (2s)\nAPI Error: Rate limit\n❯ ", [PATTERN], /❯/, t0 + 5_000, /SPINNING…/);
      expect(recovered).not.toHaveBeenCalled();
      expect((daemon as any).errorWaitingForRecovery).toBe(true);

      (daemon as any).evaluateErrorPatterns("Worked for 2s\n❯ ", [PATTERN], /❯/, t0 + 10_000, /SPINNING…/);
      expect(recovered).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
