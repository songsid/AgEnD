/**
 * #984: Codex session-selection screens that only a human may answer.
 *
 * Fixtures are real codex 0.157.0 panes (a production pane replayed into tmux,
 * and a throwaway-CODEX_HOME repro for the worktree picker); only transcript
 * rows above the live block were replaced with neutral text.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const LOCK_157 = pane("codex-0157-session-lock.pane.txt");
const LOCK_156 = pane("codex-0156-resume-locked.pane.txt");
const PICKER = pane("codex-0157-resume-cwd-picker.pane.txt");
const FORKED = pane("codex-0157-fork-created.pane.txt");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function backend(): CodexBackend {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-984-"));
  dirs.push(dir);
  const b = new CodexBackend(join(dir, "instance"));
  (b as any).isolatedCodexHome = dir;
  return b;
}

const matches = (dialog: { pattern: RegExp; isActive?: (p: string) => boolean }, p: string) =>
  dialog.isActive ? dialog.isActive(p) : dialog.pattern.test(p);
const activeDialogs = (list: Array<{ pattern: RegExp; isActive?: (p: string) => boolean; description: string }>, p: string) =>
  list.filter(d => matches(d, p)).map(d => d.description);

describe("Codex session lock / resume-directory holds (#984)", () => {
  const b = backend();

  it.each([
    ["0.157 lock with fork", LOCK_157, /open in another process/],
    ["0.156 lock without fork", LOCK_156, /open in another process/],
    ["0.157 worktree resume-directory picker", PICKER, /sibling git worktree/],
  ])("holds the %s in both startup and runtime scans, pressing nothing", (_label, p, description) => {
    for (const list of [b.getStartupDialogs(), b.getRuntimeDialogs()]) {
      const hit = list.find(d => matches(d, p));
      expect(hit?.description).toMatch(description);
      expect(hit).toMatchObject({ holdOnly: true, blocksDelivery: true, inputBlocked: true, keys: [] });
    }
    expect(b.getReadyPattern().test(p)).toBe(false);
    expect(b.isDeliveryInputReadyPane(p)).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane(p)).toBe(false);
  });

  it("does not hold on a transcript that merely quotes the screens above a live composer", () => {
    for (const quoted of [LOCK_157, PICKER]) {
      const p = `${quoted}\n\n› Ask Codex to do anything\n\n  Context 80% left`;
      expect(activeDialogs(b.getRuntimeDialogs(), p)).toEqual([]);
    }
    const prose = "• The pane said: 🔒  This conversation is open in another app\n  r retry   f fork   esc/ctrl+c/q exit\n\n› Ask Codex to do anything";
    expect(activeDialogs(b.getRuntimeDialogs(), prose)).toEqual([]);
  });

  it("requires the complete lock block: key footer last, lock row, then its Close row", () => {
    const rows = LOCK_157.trimEnd().split("\n");
    const footer = rows.at(-1)!;
    const lock = rows.find(row => row.includes("open in another app"))!;
    const close = rows.find(row => row.includes("Close it there"))!;
    const lockOnly = (p: string) => b.getRuntimeDialogs().filter(d => matches(d, p)).length > 0;
    expect(lockOnly([lock, close, "", footer].join("\n"))).toBe(true);
    expect(lockOnly([lock, close].join("\n"))).toBe(false);            // no key footer
    expect(lockOnly([lock, "", footer].join("\n"))).toBe(false);       // no Close row
    expect(lockOnly([lock, close, "  • retrying…", footer].join("\n"))).toBe(false);
  });

  it("requires the picker footer as the last row and no live composer inside the block", () => {
    const rows = PICKER.trimEnd().split("\n");
    const footer = rows.at(-1)!;
    const body = rows.slice(0, -1);
    const held = (p: string) => b.getRuntimeDialogs().some(d => matches(d, p));
    expect(held(PICKER)).toBe(true);
    expect(held(`${PICKER.trimEnd()}\n\n• I saw that picker above and chose nothing.`)).toBe(false);
    expect(held([...body, "› Ask Codex to do anything", footer].join("\n"))).toBe(false);
    expect(held([...body, "  Context 80% left", footer].join("\n"))).toBe(false);
  });

  it("keeps the post-fork screen out of the holds and inside the #978 unknown-layout idle proof (F2)", () => {
    // Right after a fork the footer carries only the warning badge, no Context
    // item, so no structural proof accepts it; the stable-composer escape
    // hatch shipped in #978 is what lets the daemon mark it idle.
    expect(activeDialogs(b.getRuntimeDialogs(), FORKED)).toEqual([]);
    expect(b.getReadyPattern().test(FORKED)).toBe(false);
    expect(b.getBusyPattern().test(FORKED)).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane(FORKED)).toBe(true);
  });
});

describe("a real Daemon on the Codex session-lock screen (#984)", () => {
  function daemonOn(p: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-codex-984-daemon-"));
    dirs.push(dir);
    const b = new CodexBackend(join(dir, "instance"));
    (b as any).isolatedCodexHome = dir;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("worker", {
      working_directory: dir, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, join(dir, "instance"), false, b, undefined, { child: () => logger } as any) as any;
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => p),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return true; }),
      sendKeys: vi.fn(async (key: string) => { keys.push(key); return true; }),
    };
    return { daemon, logger, keys };
  }

  it.each([["lock", LOCK_157], ["picker", PICKER]])(
    "startup holds the %s screen instead of assuming an unknown screen is ready",
    async (_label, p) => {
      const { daemon, logger, keys } = daemonOn(p);
      await daemon.dismissDialogsUntilReady(300, 50);
      expect(keys).toEqual([]);
      const warned = logger.warn.mock.calls.map(call => String(call.at(-1)));
      expect(warned.some(m => /dialog still on screen — .*deliveries stay blocked/.test(m))).toBe(true);
      expect(warned.some(m => /assuming ready/.test(m))).toBe(false);
    },
  );

  it("blocks delivery on the lock screen and reports it to the operator once, pressing nothing", async () => {
    const { daemon, keys } = daemonOn(LOCK_157);
    expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
    const parked: Array<{ description: string; holdOnly: boolean }> = [];
    daemon.on("dialog_parked", (event: { description: string; holdOnly: boolean }) => parked.push(event));
    const started = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(started);
      await daemon.probeBlockingDialog();
      clock.mockReturnValue(started + 61_000);
      await daemon.probeBlockingDialog();
      await daemon.probeBlockingDialog();
    } finally { clock.mockRestore(); }
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ holdOnly: true, description: expect.stringMatching(/open in another process/) });
    expect(keys).toEqual([]);
  });
});
