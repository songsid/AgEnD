/**
 * #1435 review: the startup dialog scan answers 2.1.295's cold-cache resume prompt only on a fresh, exact capture taken
 * under the pane write lock, and only while the pane is still this launch's — its tmux, spawn and launch fence. A
 * scan that waited for the lock while the screen changed, or while a respawn, pause or stop replaced the launch,
 * sends nothing. Real Daemon and ClaudeCodeBackend, the real pane write lock, a stub tmux serving fixture frames.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon } from "../src/daemon.js";

const DIALOG = readFileSync(new URL("./fixtures/claude-2.1.295-cold-resume-launch.pane.txt", import.meta.url), "utf8");
const READY = readFileSync(new URL("./fixtures/claude-2.1.294-ready-statusline.pane.txt", import.meta.url), "utf8");
/** The old resume menu with its cursor on the default: the startup table answers it with two keys, Down then Enter. */
const RESUME3 = readFileSync(new URL("./fixtures/claude-2.1.287-resume3.pane.txt", import.meta.url), "utf8");
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tmuxStub(frame: { pane: string }) {
  return {
    capturePane: vi.fn(async () => frame.pane),
    sendSpecialKey: vi.fn(async (_key: string) => true),
    sendKeys: vi.fn(async () => true),
  };
}

async function scan(between: (d: any, frame: { pane: string }) => void, opts: { pane?: string; onKey?: (d: any, key: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-1435-")); roots.push(root);
  const backend = new ClaudeCodeBackend(join(root, "inst"));
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  } as any, join(root, "inst"), false, backend as any, undefined, logger);
  const frame = { pane: opts.pane ?? DIALOG };
  const tmux = tmuxStub(frame);
  if (opts.onKey) tmux.sendSpecialKey.mockImplementation(async (key: string) => { opts.onKey!(daemon, key); return true; });
  daemon.tmux = tmux;
  vi.spyOn(daemon, "paneLiveness").mockResolvedValue("alive");
  // Hold the pane write lock, so the scan's answer has to wait for it.
  let release!: () => void;
  const held = daemon.paneWriteLock.run(() => new Promise<void>(r => { release = r; }));
  const done = daemon.dismissDialogsUntilReady(1_500, 20);
  await new Promise(r => setTimeout(r, 100));        // the scan has seen the dialog and is queued on the lock
  between(daemon, frame);
  const releasedAt = Date.now();
  release();
  await held;
  await done;
  return { tmux, daemon, settledMs: Date.now() - releasedAt };
}

describe("the startup scan's Escape for the cold-resume prompt", () => {
  it("control: the dialog still exact under the lock — one Escape", async () => {
    const { tmux } = await scan(() => {});
    expect(tmux.sendSpecialKey.mock.calls).toEqual([["Escape"]]);
  });

  it("the screen became an ordinary prompt while the scan waited: no key", async () => {
    const { tmux } = await scan((_d, frame) => { frame.pane = READY; });
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
  });

  it("a respawn replaced tmux and the spawn while the scan waited: nothing to the old or the new tmux", async () => {
    const replacement = tmuxStub({ pane: DIALOG });
    const { tmux } = await scan(d => { d.tmux = replacement; d.spawnGeneration += 1; });
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
  });

  it("a pause (the launch fence moved) while the scan waited: no key", async () => {
    const { tmux } = await scan(d => { d.launchFenceEpoch += 1; });
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
  });
});

describe("each owner check on its own", () => {
  it("a respawn between two keys (the resume menu's Down then Enter): the Enter is not sent, to either tmux", async () => {
    const replacement = tmuxStub({ pane: RESUME3 });
    const { tmux } = await scan(() => {}, { pane: RESUME3, onKey: (d, key) => {
      if (key === "Down") { d.tmux = replacement; d.spawnGeneration += 1; }
    } });
    expect(tmux.sendSpecialKey.mock.calls).toEqual([["Down"]]);
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
  });

  it("a superseded scan retires at once instead of scanning the replacement until its budget runs out", async () => {
    // the replacement shows the dialog too: a scan that did not retire would go on reading it as its own launch's
    const replacement = tmuxStub({ pane: DIALOG });
    const { settledMs } = await scan(d => { d.tmux = replacement; d.spawnGeneration += 1; });
    expect(settledMs).toBeLessThan(700);                 // the budget is 1.5 s
    expect(replacement.capturePane).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
  });
});
