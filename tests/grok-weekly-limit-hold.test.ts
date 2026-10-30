import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";

// Extracted verbatim from a read-only `tmux capture-pane -p` of
// classic-廣場-0414-grok-persona on 2026-09-29. Unrelated chat scrollback was
// omitted; the modal and both footer rows are the actual captured pane bytes.
const WEEKLY_LIMIT = readFileSync(new URL("./fixtures/grok-weekly-limit-modal.pane.txt", import.meta.url), "utf8");
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(pane: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-grok-weekly-limit-"));
  dirs.push(dir);
  const backend = new GrokBackend(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("grok-weekly", {
    working_directory: "/tmp", backend: "grok",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const tmux = {
    capturePane: vi.fn(async () => pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true),
    sendKeys: vi.fn(async () => true),
    pasteText: vi.fn(async () => true),
    pasteBuffer: vi.fn(async () => true),
  };
  daemon.tmux = tmux;
  // Isolate the dialog gate from output-silence timing: this fixture's ready
  // pattern is intentionally a positive match, so only the modal hold may win.
  daemon.isPaneIdleForDelivery = vi.fn(() => true);
  return { daemon, backend, tmux, logger };
}

const active = (dialogs: Array<{ pattern: RegExp; isActive?: (pane: string) => boolean }>, pane: string) =>
  dialogs.filter(dialog => dialog.isActive ? dialog.isActive(pane) : dialog.pattern.test(pane));

describe("Grok Build weekly limit modal (#992)", () => {
  it("recognizes the captured modal: a no-key hold at startup; at runtime Shift+x, verified, never a paid option (#2872)", () => {
    const backend = new GrokBackend("/tmp/grok-weekly-limit-test");
    const startup = active(backend.getStartupDialogs(), WEEKLY_LIMIT).find(dialog => dialog.pattern.test(WEEKLY_LIMIT));
    expect(startup).toMatchObject({ description: expect.stringMatching(/Grok 週限/), keys: [], blocksDelivery: true, holdOnly: true, inputBlocked: true });
    expect((startup as any).dismissIncident).toBeUndefined();
    const runtime = active(backend.getRuntimeDialogs(), WEEKLY_LIMIT).find(dialog => dialog.pattern.test(WEEKLY_LIMIT));
    expect(runtime).toMatchObject({ description: expect.stringMatching(/Grok 週限/), keys: ["X"], blocksDelivery: true, inputBlocked: true, verifyAfterKeys: true,
      answeredByAgend: true, dismissIncident: { type: "quota", action: "pause" } });
    expect((runtime as any).holdOnly).toBeFalsy();
    // This is the regression pressure: the normal ready regex matches Grok Build
    // in the purchase option, so the blocking modal must take precedence.
    expect(backend.getReadyPattern().test(WEEKLY_LIMIT)).toBe(true);
  });

  it("does not mistake an idle prompt, the upgrade banner, or quoted modal text for the live modal", () => {
    const backend = new GrokBackend("/tmp/grok-weekly-limit-test");
    const idle = "╭────────────────────────────────────────╮\n│ ❯                                      │\n╰──────── Grok 4.7 (high) ───────────────╯";
    const upgradeBanner = "Help improve Grok\nOff by default. Opt in to share coding data.\n[Click here to Upgrade]\n\n❯\nGrok 4.7 (high)";
    const quoted = `${WEEKLY_LIMIT}\n❯ Ask Grok to do anything\nGrok 4.7 (high)`;
    for (const pane of [idle, upgradeBanner, quoted]) {
      expect(active(backend.getStartupDialogs(), pane)).toEqual([]);
      expect(active(backend.getRuntimeDialogs(), pane)).toEqual([]);
    }
  });

  it("keeps startup on the modal instead of accepting Grok Build text as ready", async () => {
    const { daemon, tmux, logger } = makeDaemon(WEEKLY_LIMIT);
    await expect(daemon.dismissDialogsUntilReady(100, 10)).resolves.toBe(true);
    const warnings = logger.warn.mock.calls.map(call => String(call.at(-1)));
    expect(warnings.some(message => /deliveries stay blocked/.test(message))).toBe(true);
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pasteText).not.toHaveBeenCalled();
  });

  it("blocks the ready pane and delivery; the runtime scanner presses Shift+x once and raises one quota pause (#2872)", async () => {
    vi.useFakeTimers();
    const { daemon, tmux } = makeDaemon(WEEKLY_LIMIT);
    const parked: unknown[] = [], errors: Array<{ type: string; action: string; message: string; skipUsageVerify?: boolean }> = [];
    daemon.on("dialog_parked", (event: unknown) => parked.push(event));
    daemon.on("pty_error", (event: any) => errors.push(event));

    await expect(daemon.paneReadinessForDelivery("@grok")).resolves.toBe("dialog");
    expect((await daemon.probeBlockingDialog()).state).toBe("dialog");

    let pane = WEEKLY_LIMIT;
    tmux.capturePane.mockImplementation(async () => pane);
    tmux.sendKeys.mockImplementation(async (key: string) => { if (key === "X") pane = "╭──────╮\n│ ❯    │\n╰──────╯\n  Shift+Tab:mode  │  Ctrl+x:shortcuts"; return true; });
    daemon.startErrorMonitor();
    try {
      await vi.advanceTimersByTimeAsync(70_000);
      // Typed (send-keys -l), never a paste: a paste ends with Enter, which submits the option under the cursor.
      expect(tmux.sendKeys.mock.calls.map((c: any[]) => c[0])).toEqual(["X"]);
      expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
      expect(parked).toEqual([]);
      expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "pause", skipUsageVerify: true, message: expect.stringMatching(/Grok/) })]);
      expect(tmux.pasteText).not.toHaveBeenCalled();
      expect(tmux.pasteBuffer).not.toHaveBeenCalled();
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });
});
