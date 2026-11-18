/**
 * M-3307 (#4146): the switch from an npm-global Claude Code to Claude's native install, and the npm copy's removal — FleetManager.startWebInstall's `native` and `remove-npm` modes.
 * Real: the login shell that says where `claude` resolves, realpath, the install-kind check. Faked: the tmux window (LoginSession), whose installer is played by hand: the
 * scratch HOME gets an npm-global layout (`<prefix>/lib/node_modules/@anthropic-ai/claude-code`) and, when the "installer" runs, Claude's native one (`~/.local/share/claude/versions`).
 * Nothing is downloaded or installed; no real claude runs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSessions: Array<{ flow: any; events: any; cancelled: string[]; startGate?: Promise<void> }> = [];
let startGate: Promise<void> | undefined;
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    record: { flow: any; events: any; cancelled: string[] };
    constructor(public flow: any, _tmux: any, public events: any) { this.record = { flow, events, cancelled: [] }; fakeSessions.push(this.record); }
    async start() { if (startGate) await startGate; }
    async cancel(reason = "cancelled") { this.record.cancelled.push(reason); this.state = "done"; }
  }
  return { ...real, LoginSession: FakeLoginSession };
});
vi.mock("../src/tmux-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tmux-manager.js")>();
  class FakeTmux { constructor() {} static async ensureSession() {} }
  return { ...real, TmuxManager: Object.assign(FakeTmux, { ensureSession: async () => {} }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import type { HostInstallReporter } from "../src/web-host-install.js";
import { hostUpdatePlan } from "../src/web-host-install.js";
import { binaryProbe } from "../src/binary-probe.js";
import { hostAvailabilityProbes, parseVersion } from "../src/backend-availability.js";

let root: string, home: string, npmDir: string, npmBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
const script = (file: string, version: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `#!/bin/sh\n# ${Math.random()}\necho "${version} (Claude Code)"\n`); chmodSync(file, 0o755); };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-3307-"));
  home = join(root, "home");
  npmDir = join(root, "prefix", "lib", "node_modules", "@anthropic-ai", "claude-code");
  npmBin = join(root, "prefix", "bin");
  script(join(npmDir, "bin", "claude.exe"), "2.1.300");
  mkdirSync(npmBin, { recursive: true });
  symlinkSync(join(npmDir, "bin", "claude.exe"), join(npmBin, "claude"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  // The login shell's PATH: the native link first (where claude.ai/install.sh puts it), then the npm prefix.
  writeFileSync(join(home, ".bash_profile"), `export PATH="$HOME/.local/bin:${npmBin}:$PATH"\n`);
  process.env.HOME = home; delete process.env.XDG_DATA_HOME;
  process.env.PATH = `${npmBin}:/usr/bin:/bin`;
  fakeSessions.length = 0; startGate = undefined;
  binaryProbe.invalidate();
  vi.spyOn(hostAvailabilityProbes, "version").mockImplementation(async (_backend, path) => { try { return parseVersion(readFileSync(path, "utf8").split("\n").filter(l => l.startsWith("echo")).join("\n")); } catch { return null; } });
});
afterEach(() => {
  process.env.PATH = saved.PATH; process.env.HOME = saved.HOME;
  if (saved.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fleet() {
  const fm = new FleetManager(join(root, "data"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const reporter = () => ({ progress: vi.fn(), done: vi.fn<(r: Parameters<HostInstallReporter["done"]>[0]) => void>(), update: vi.fn() });
  return { fm, reporter };
}
/** What claude.ai/install.sh leaves: a version in the native folder and the ~/.local/bin/claude link to it. */
const installNative = (version = "2.1.325") => {
  const file = join(home, ".local", "share", "claude", "versions", version);
  script(file, version);
  symlinkSync(file, join(home, ".local", "bin", "claude"));
  return file;
};
const AUDITED = () => hostUpdatePlan("claude-code")!.target!;

describe("M-3307: switch to Claude's native install", () => {
  it("over an npm-global install: the audited install.sh runs; afterwards `claude` resolves to the native install, the npm copy is reported left", async () => {
    const { fm, reporter } = fleet();
    const r = reporter();
    expect(await fm.startWebInstall("claude-code", r, undefined, "native")).toEqual({ started: true });
    expect(fakeSessions).toHaveLength(1);
    expect(fakeSessions[0]!.flow.command).toContain(`claude.ai/install.sh | bash -s ${AUDITED()}`);
    const file = installNative(AUDITED());
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done).toHaveBeenCalledTimes(1);
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, claude: { kind: "native", path: file, npmLeftover: npmDir } });
  });

  it("refused when `claude` is not an npm install (already native): nothing runs", async () => {
    installNative();
    process.env.PATH = `${join(home, ".local", "bin")}:/usr/bin:/bin`;
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("claude-code", reporter(), undefined, "native")).toEqual({ refused: "not_npm" });
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });

  it("another CLI cannot be switched", async () => {
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("codex", reporter(), undefined, "native")).toEqual({ refused: "unsupported" });
  });
});

describe("M-3307: remove the npm copy (a separate step)", () => {
  it("before any switch: nothing known to remove", async () => {
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("claude-code", reporter(), undefined, "remove-npm")).toEqual({ refused: "no_npm_copy" });
    expect(fakeSessions).toHaveLength(0);
  });

  it("after the switch: npm's uninstall in that copy's own prefix; afterwards the copy is gone and `claude` is still the native one", async () => {
    const { fm, reporter } = fleet();
    await fm.startWebInstall("claude-code", reporter(), undefined, "native");
    const file = installNative(AUDITED());
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    const r = reporter();
    expect(await fm.startWebInstall("claude-code", r, undefined, "remove-npm")).toEqual({ started: true });
    // The window's wrapper quotes the command once more; its parts: npm aimed at the copy's prefix, uninstalling that package.
    const cmd = fakeSessions[1]!.flow.command as string;
    expect(cmd).toContain("npm --prefix ");
    expect(cmd).toContain(join(root, "prefix"));
    expect(cmd).not.toContain(join(root, "prefix", "lib"));
    expect(cmd).toContain("-g uninstall @anthropic-ai/claude-code");
    rmSync(join(root, "prefix", "lib", "node_modules", "@anthropic-ai"), { recursive: true, force: true });   // what npm did
    await fakeSessions[1]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, claude: { kind: "native", path: file, npmLeftover: null } });
  });

  it("the npm copy first on PATH and no native install: refused (removing it would leave no claude)", async () => {
    const { fm, reporter } = fleet();
    (fm as any).claudeNpmCopy = npmDir;
    expect(await fm.startWebInstall("claude-code", reporter(), undefined, "remove-npm")).toEqual({ refused: "still_npm" });
    expect(fakeSessions).toHaveLength(0);
  });

  it("the native install behind the npm copy on PATH (the switch's 'still npm' case): the removal is allowed", async () => {
    writeFileSync(join(home, ".bash_profile"), `export PATH="${npmBin}:$HOME/.local/bin:$PATH"\n`);
    const { fm, reporter } = fleet();
    await fm.startWebInstall("claude-code", reporter(), undefined, "native");
    installNative(AUDITED());
    const r1 = reporter();
    (fakeSessions[0]!.events as any).onDone({ ok: true, detail: "clean exit" });
    await new Promise(res => setTimeout(res, 50));
    expect(await fm.startWebInstall("claude-code", r1, undefined, "remove-npm")).toEqual({ started: true });
  });
});
