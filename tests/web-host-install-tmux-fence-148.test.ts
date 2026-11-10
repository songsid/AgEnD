/**
 * AGEND-148 (Prism R3 on #3539, P2-2): the asker's authority is carried through every await of opening the installer window, up to the tmux command that starts it — not only
 * checked before `session.start()`. #3542 gave the install that fence (`session.start(() => execution.complete())`, asked at the tmux dispatch); the Update button takes the same path,
 * and this pins it where the reviewer reproduced the gap. Real here: FleetManager.startWebInstall (install and update mode), the real LoginSession and the real TmuxManager.createWindow
 * (its listing, its reuse / respawn path and its `new-window`). Faked: only the tmux process (`tmuxExecHelper.exec` records each command and answers) and the session listing, which a test can hold.
 *   - hold the listing → revoke the asker → release it: no `new-window` (and, on the reuse path, no `respawn-window`) is dispatched, the claim is given back, the start is refused;
 *   - the same sequence with the asker unchanged dispatches exactly one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { tmuxExecHelper } from "../src/tmux-exec-helper.js";
import { binaryProbe } from "../src/binary-probe.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import type { HostInstallReporter } from "../src/web-host-install.js";

let root: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
const fleets: FleetManager[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-148-tmux-"));
  process.env.HOME = join(root, "home"); process.env.PATH = "/usr/bin:/bin";
  binaryProbe.invalidate();
});
afterEach(async () => {
  for (const fm of fleets.splice(0)) await fm.cancelInstallSession().catch(() => {});
  process.env.PATH = saved.PATH; process.env.HOME = saved.HOME;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const reporter = (): HostInstallReporter => ({ progress: vi.fn(), done: vi.fn() });

function harness(existing: Array<{ id: string; name: string }> = []) {
  const fm = new FleetManager(join(root, "data")); fleets.push(fm);
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const commands: string[][] = [];
  vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined as never);
  vi.spyOn(tmuxExecHelper, "exec").mockImplementation((async (_file: string, args: string[]) => { commands.push(args); return { stdout: "@9\n", stderr: "" }; }) as never);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), listing = new Promise<void>(r => { entered = r; });
  let held = true;
  vi.spyOn(TmuxManager, "listWindowsStrict").mockImplementation(async () => { entered(); if (held) await gate; return existing; });
  const sent = (verb: string) => commands.filter(args => args.includes(verb)).length;
  return { fm, sent, listing, release: () => { held = false; release(); } };
}

describe.each([
  ["a new window (no window of that name yet)", [] as Array<{ id: string; name: string }>, "new-window"],
  ["the reuse / respawn path (a window of that name is left over)", [{ id: "@3", name: "agend-login-grok" }], "respawn-window"],
] as const)("revocation while tmux lists windows — %s", (_name, existing, verb) => {
  it(`the asker revoked after the listing began and before it returns: no ${verb} is sent, the start is refused, the window is free`, async () => {
    const h = harness([...existing]);
    let allowed = true;
    const execution = new SettingsExecution({ current: () => allowed, snapshot: () => ({}) });
    const started = h.fm.startWebInstall("grok", reporter(), execution, "install");
    await h.listing;                                  // createWindow is now waiting on the listing
    allowed = false;                                  // the session is revoked meanwhile
    h.release();
    expect(await started).toMatchObject({ refused: "failed", message: "settings_execution_stale" });
    expect(h.sent(verb)).toBe(0);
    expect((h.fm as any).loginWindow.isHeld).toBe(false);
    expect((h.fm as any).activeInstall).toBeNull();
  });
  it(`the control: the same sequence with the asker unchanged sends exactly one ${verb}`, async () => {
    const h = harness([...existing]);
    const execution = new SettingsExecution({ current: () => true, snapshot: () => ({}) });
    const started = h.fm.startWebInstall("grok", reporter(), execution, "install");
    await h.listing;
    h.release();
    expect(await started).toEqual({ started: true });
    expect(h.sent(verb)).toBe(1);
  });
});
