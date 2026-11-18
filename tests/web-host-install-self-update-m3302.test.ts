/**
 * M-3302: the dashboard never starts Claude Code's installer while Claude is downloading an update of its own. Claude's native
 * installer stages the new release in `<XDG cache>/claude/staging` (empty between updates) and moves it into place when done; a
 * file there from the last ten minutes means its own update is running, and the dashboard's install or update is refused with
 * `cli_self_updating` ("try again in a few minutes") before any window opens. An older leftover does not block, nor does it
 * apply to another CLI. Harness: tests/web-host-update-fleet-136.test.ts (the tmux window is faked; nothing is installed).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { checkBinaryInstalled, BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { CLAUDE_SELF_UPDATE_WINDOW_MS, claudeSelfUpdating, type HostInstallReporter } from "../src/web-host-install.js";
import { binaryProbe } from "../src/binary-probe.js";
import { hostAvailabilityProbes, parseVersion } from "../src/backend-availability.js";

let root: string, home: string, profileBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-3302-"));
  home = join(root, "home");
  profileBin = join(home, ".grok", "bin");
  mkdirSync(profileBin, { recursive: true });
  writeFileSync(join(profileBin, "grok"), "#!/bin/sh\necho grok 0.4.2\n");
  chmodSync(join(profileBin, "grok"), 0o755);
  writeFileSync(join(home, ".bash_profile"), `export PATH="$HOME/.grok/bin:$PATH"\n`);
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  fakeSessions.length = 0; startGate = undefined;
  binaryProbe.invalidate();                      // the PATH lookup is cached across tests (a throwaway HOME each time)
  // AGEND-144 (CI run 42721896278: six failures here, "up_to_date" instead of "started"): the real version probe runs `<cli> --version` inside `unshare -rn` (no network), which a
  // CI runner without unprivileged user namespaces cannot do — the version then reads as unknown and an update is refused. These tests are about the update's admission, not
  // about that probe, so it is replaced: the throwaway fake CLI's own text says its version (nothing is started), the same answer on every machine.
  vi.spyOn(hostAvailabilityProbes, "version").mockImplementation(async (_backend, path) => { try { return parseVersion(readFileSync(path, "utf8").split("\n").filter(l => l.startsWith("echo")).join("\n")); } catch { return null; } });
});
afterEach(() => {
  process.env.PATH = saved.PATH; process.env.HOME = saved.HOME;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fleet() {
  const fm = new FleetManager(join(root, "data"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const reporter = () => {
    const progress = vi.fn<(pane: string) => void>(), done = vi.fn<Parameters<HostInstallReporter["done"]>[0] extends infer R ? (result: R) => void : never>();
    return { progress, done } satisfies HostInstallReporter;
  };
  return { fm, reporter };
}




const stage = (ageMs: number) => {
  const dir = join(home, ".cache", "claude", "staging");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "claude-2.1.327.partial");
  writeFileSync(f, "x");
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(f, t, t);
};
const writeClaude = (version: string) => {
  const bin = join(home, ".local", "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n# ${Math.random()}\necho "${version} (Claude Code)"\n`); chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
};

describe("claudeSelfUpdating", () => {
  it("a fresh file in the staging folder: true; an old one, an empty folder, no folder: false", () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(claudeSelfUpdating(env)).toBe(false);
    mkdirSync(join(home, ".cache", "claude", "staging"), { recursive: true });
    expect(claudeSelfUpdating(env)).toBe(false);
    stage(CLAUDE_SELF_UPDATE_WINDOW_MS + 60_000);
    expect(claudeSelfUpdating(env)).toBe(false);
    stage(5_000);
    expect(claudeSelfUpdating(env)).toBe(true);
  });
  it("honours XDG_CACHE_HOME", () => {
    const xdg = join(root, "xdg"); mkdirSync(join(xdg, "claude", "staging"), { recursive: true });
    writeFileSync(join(xdg, "claude", "staging", "f"), "x");
    expect(claudeSelfUpdating({ HOME: home, XDG_CACHE_HOME: xdg } as NodeJS.ProcessEnv)).toBe(true);
    expect(claudeSelfUpdating({ HOME: home } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("startWebInstall while Claude updates itself", () => {
  it("install: refused with cli_self_updating, no window, the login window is free again", async () => {
    stage(5_000);
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("claude-code", reporter())).toEqual({ refused: "cli_self_updating" });
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("update: refused the same way, before the version probe", async () => {
    writeClaude("2.1.300"); stage(5_000);
    const { fm, reporter } = fleet();
    const probe = vi.spyOn((fm as any).backendAvailability, "refresh");
    expect(await fm.startWebInstall("claude-code", reporter(), undefined, "update")).toEqual({ refused: "cli_self_updating" });
    expect(fakeSessions).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("control: an old leftover in staging does not block — the install starts", async () => {
    stage(CLAUDE_SELF_UPDATE_WINDOW_MS + 60_000);
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("claude-code", reporter())).toEqual({ started: true });
    expect(fakeSessions).toHaveLength(1);
  });
  it("control: another CLI is not affected by Claude's staging folder", async () => {
    stage(5_000);
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter())).toEqual({ started: true });
  });
});
