import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextGuardian } from "../src/context-guardian.js";
import { createLogger } from "../src/logger.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const makeConfig = (overrides = {}) => ({
  grace_period_ms: 600_000,
  max_age_hours: 0,
  ...overrides,
});

describe("ContextGuardian (pure monitoring)", () => {
  const logger = createLogger("silent");
  let guardian: ContextGuardian;
  let tmpDir: string;
  let statusFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-guardian-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    statusFile = join(tmpDir, "statusline.json");
    guardian = new ContextGuardian(makeConfig(), logger, statusFile);
  });

  afterEach(() => {
    guardian.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits status_update when statusline is written", async () => {
    const spy = vi.fn();
    guardian.on("status_update", spy);
    guardian.startWatching();

    const { writeFileSync } = await import("node:fs");
    const write = () => writeFileSync(statusFile, JSON.stringify({
      session_id: "test",
      model: { id: "test", display_name: "test" },
      context_window: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        context_window_size: 200000,
        current_usage: 50000,
        used_percentage: 25,
        remaining_percentage: 75,
      },
      cost: { total_cost_usd: 0.5, total_duration_ms: 1000 },
    }));

    // watchFile stat-polls (2s interval) and only fires when the stat CHANGES
    // between polls. Writing once right after startWatching races the watcher's
    // baseline stat: if that baseline already sees the created file, there is no
    // change left to observe and the listener never fires — which made this test
    // fail ~2 runs in 3. Re-writing while waiting guarantees a stat change lands
    // after the baseline, whenever the baseline was taken.
    const deadline = Date.now() + 15_000;
    while (spy.mock.calls.length === 0 && Date.now() < deadline) {
      write();
      await new Promise(r => setTimeout(r, 250));
    }
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].used_percentage).toBe(25);
  }, 20_000);

  it("does not have state, requestRestart, or startTimer methods", () => {
    // Verify the simplified API — no state machine
    expect((guardian as any).state).toBeUndefined();
    expect((guardian as any).requestRestart).toBeUndefined();
    expect((guardian as any).startTimer).toBeUndefined();
  });
});
