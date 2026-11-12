/**
 * AGEND-153 (the maintainer's decision on #3539): the dashboard's Update for Antigravity is the one named exception — it runs the registry's own `agy update` and the CLI goes to the newest
 * release the vendor serves, which AgEnD has NOT audited. Real: the registry's command through unattendedInstallCommand, the fleet-wide login window, the binary probe (a throwaway HOME with a
 * fake `agy` that prints a version) and a login shell. Faked: the tmux window (LoginSession) — its poll's verdicts are fed by hand.
 * - It is offered at ANY readable version (behind, at and above the audited 1.5.3), because the audited release does not decide where it goes; an unreadable version, or no copy at all, is refused.
 * - The command is the registry's, as written (no `{version}` to fill, never a release of ours); the page is told the version before and that there is no audited target.
 * - Every other rule of an update is unchanged: one window fleet-wide, cancel, the failure report; the other CLIs still refuse an update that is not behind the audited release.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { WebHostInstalls, type HostInstallReporter } from "../src/web-host-install.js";
import { binaryProbe } from "../src/binary-probe.js";
import { hostAvailabilityProbes, parseVersion } from "../src/backend-availability.js";

let root: string, home: string, profileBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-153-"));
  home = join(root, "home");
  profileBin = join(home, ".grok", "bin");
  mkdirSync(profileBin, { recursive: true });
  writeFileSync(join(profileBin, "agy"), "#!/bin/sh\necho 1.5.3\n");
  chmodSync(join(profileBin, "agy"), 0o755);
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


// A unique comment per write: the binary probe caches a reading by the file's size and times, and a rewrite of the same size in the same millisecond would read as the old one.
let writes = 0;
const writeAgy = (version: string) => { writeFileSync(join(profileBin, "agy"), `#!/bin/sh\n# ${++writes} ${Math.random()}\necho "${version}"\n`); chmodSync(join(profileBin, "agy"), 0o755); };
const onPath = () => { process.env.PATH = `${profileBin}:/usr/bin:/bin`; };


describe("startWebInstall — Antigravity's update to the latest (the named exception)", () => {
  it.each([["1.3.5", "behind the audited release"], ["1.5.3", "at the audited release"], ["1.5.9", "newer than anything audited"]])("%s (%s): the window runs `agy update`, and the page is told the version before and no audited target", async version => {
    writeAgy(version); onPath();
    const { fm, reporter } = fleet();
    const update = vi.fn<(from: string | null, target: string | null) => void>();
    expect(await fm.startWebInstall("antigravity", { ...reporter(), update }, undefined, "update")).toEqual({ started: true });
    expect(update).toHaveBeenCalledWith(version, null);
    expect(fakeSessions).toHaveLength(1);
    const { flow } = fakeSessions[0]!;
    expect(flow.backend).toBe("antigravity");
    expect(flow.command).toContain("agend-install");
    expect(flow.command).toContain("agy update");
    expect(flow.command).not.toMatch(/\{version\}|1\.5\.3|curl|install\.sh/);
    expect((fm as any).loginWindow.heldFor("antigravity")).toMatchObject({ kind: "install", backend: "antigravity" });
  });
  it("success: the version afterwards is the binary probe's own, read again; the window is released", async () => {
    writeAgy("1.5.3"); onPath();
    const { fm, reporter } = fleet();
    const r = reporter();
    await fm.startWebInstall("antigravity", r, undefined, "update");
    writeAgy("1.6.0");                                      // what `agy update` did
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, verified: true, version: "1.6.0" });
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("a failed `agy update` is reported with its detail and the window is released", async () => {
    writeAgy("1.5.3"); onPath();
    const { fm, reporter } = fleet();
    const r = reporter();
    await fm.startWebInstall("antigravity", r, undefined, "update");
    await fakeSessions[0]!.events.onDone({ ok: false, detail: "CLI exited with code 1 — no network" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: false, verified: false, version: null, detail: "CLI exited with code 1 — no network" });
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it.each([["no idea"], [""]])("a version that cannot be read (%j) is refused as version_unreadable: nothing opens, the window is free", async printed => {
    writeAgy(printed); onPath();
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("antigravity", reporter(), undefined, "update")).toEqual({ refused: "version_unreadable" });
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("not installed anywhere: refused as not_installed", async () => {
    rmSync(join(profileBin, "agy"));
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("antigravity", reporter(), undefined, "update")).toEqual({ refused: "not_installed" });
    expect(fakeSessions).toHaveLength(0);
  });
  it("one window: an update during an install or another update is refused as busy, never queued", async () => {
    writeAgy("1.5.3"); onPath();
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("antigravity", reporter(), undefined, "update")).toEqual({ started: true });
    expect(await fm.startWebInstall("antigravity", reporter(), undefined, "update")).toEqual({ refused: "busy" });
    expect(fakeSessions).toHaveLength(1);
  });
  it("the pinned-release CLIs are unchanged: Grok at the audited release is still refused as up_to_date", async () => {
    writeFileSync(join(profileBin, "grok"), '#!/bin/sh\necho "grok 1.0.77 (abc)"\n'); chmodSync(join(profileBin, "grok"), 0o755); onPath();
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter(), undefined, "update")).toEqual({ refused: "up_to_date" });
  });
});

describe("the run the page reads (WebHostInstalls) for the named exception", () => {
  const WHO = { handle: "0123456789abcdef", label: "Firefox on Linux" };
  function make() {
    const reporters: HostInstallReporter[] = [];
    const start = vi.fn(async (_b: string, r: HostInstallReporter, _execution?: unknown, mode?: string) => { if (mode === "update") r.update?.("1.5.3", null); reporters.push(r); return { started: true as const }; });
    return { installs: new WebHostInstalls({ isLocalAdmin: () => true, installable: () => true, updatable: () => true, start, cancel: async () => true }), reporters };
  }
  const ok = (version: string | null, verified = true) => ({ ok: true, detail: "clean exit", verified, version, signIn: false });
  it("is flagged `latest`, has no audited target, and `reached` stays null whatever version it ends at — there is no release of ours to have reached", async () => {
    for (const version of ["1.6.0", "1.5.3", null]) {
      const t = make();
      await t.installs.begin(WHO, "antigravity", undefined, "update");
      t.reporters[0]!.done(ok(version));
      expect(t.installs.view()).toMatchObject({ mode: "update", backend: "antigravity", latest: true, fromVersion: "1.5.3", targetVersion: null, phase: "ok", reached: null, version });
    }
  });
  it("a pinned-release update and an install are not flagged", async () => {
    const t = make();
    await t.installs.begin(WHO, "grok", undefined, "update");
    expect(t.installs.view()).toMatchObject({ mode: "update", latest: false });
    await t.installs.begin(WHO, "antigravity");
    expect(t.installs.view()).toMatchObject({ mode: "install", latest: false });
  });
});
