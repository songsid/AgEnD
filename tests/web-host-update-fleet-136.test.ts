/**
 * AGEND-136 (upstream #3521): FleetManager.startWebInstall(…, "update") — the dashboard's Update is the install's window with the registry's `host.update` command, the
 * newest AUDITED release filled in. Real: the registry's command through unattendedInstallCommand, the fleet-wide login window, the binary probe (a throwaway HOME with a
 * fake `grok` that prints a version) and a login shell. Faked: the tmux window (LoginSession) — its poll's verdicts are fed by hand.
 * - Only an installed CLI that is BEHIND the audited release is updated; installed-and-current, newer, unreadable, not installed, and a CLI that updates itself are refused
 *   before any window opens.
 * - The command carries the audited release (never "latest"); the page is told the version before and the release it goes to; afterwards the binary probe's version.
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
import type { HostInstallReporter } from "../src/web-host-install.js";
import { binaryProbe } from "../src/binary-probe.js";
import { hostAvailabilityProbes, parseVersion } from "../src/backend-availability.js";

let root: string, home: string, profileBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-133-"));
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


// A unique comment per write: the binary probe caches a reading by the file's size and times, and a rewrite of the same size in the same millisecond would read as the old one.
let writes = 0;
const writeGrok = (version: string) => { writeFileSync(join(profileBin, "grok"), `#!/bin/sh\n# ${++writes} ${Math.random()}\necho "grok ${version} (abc123)"\n`); chmodSync(join(profileBin, "grok"), 0o755); };
const onPath = () => { process.env.PATH = `${profileBin}:/usr/bin:/bin`; };

describe("startWebInstall — update", () => {
  it("an installed CLI behind the audited release: the window runs the registry's update command with the audited release, and the page is told from → to", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    const update = vi.fn<(from: string | null, target: string | null) => void>();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ started: true });
    expect(update).toHaveBeenCalledWith("1.0.70", "1.0.77");
    expect(fakeSessions).toHaveLength(1);
    const { flow } = fakeSessions[0]!;
    expect(flow.backend).toBe("grok");
    expect(flow.command).toContain("agend-install");
    expect(flow.command).toContain("curl -fsSL https://x.ai/cli/install.sh | bash -s 1.0.77");
    expect(flow.command).not.toMatch(/latest/);
    expect((fm as any).loginWindow.current).toMatchObject({ kind: "install", backend: "grok" });
  });
  it("success: the version afterwards is the binary probe's own, read again; the window is released", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    const r = reporter();
    await fm.startWebInstall("grok", r, undefined, "update");
    writeGrok("1.0.77");                                   // what the installer did
    await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    expect(r.done).toHaveBeenCalledTimes(1);
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: true, verified: true, version: "1.0.77" });
    expect((fm as any).loginWindow.isHeld).toBe(false);
    expect((fm as any).activeInstall).toBeNull();
  });
  it("a failed installer is reported with its detail, the version is not claimed, and the window is released", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    const r = reporter();
    await fm.startWebInstall("grok", r, undefined, "update");
    await fakeSessions[0]!.events.onDone({ ok: false, detail: "CLI exited with code 22 — curl failed" });
    expect(r.done.mock.calls[0]![0]).toMatchObject({ ok: false, verified: false, version: null, detail: "CLI exited with code 22 — curl failed" });
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("cancel reaches the update's window like an install's", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    await fm.startWebInstall("grok", reporter(), undefined, "update");
    await fm.cancelInstallSession();
    expect(fakeSessions[0]!.cancelled).toEqual(["cancelled"]);
  });
  it.each([["1.0.77", "at the audited release"], ["1.0.99", "newer than anything audited"]])("%s (%s): refused as up_to_date, nothing opens, the window is free", async version => {
    writeGrok(version); onPath();
    const { fm, reporter } = fleet();
    const update = vi.fn();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ refused: "up_to_date" });
    expect(update).not.toHaveBeenCalled();
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  // AGEND-144 (Prism on #3539, P2-3): a retained version is not an update's authorization.
  it("a version that cannot be read now: refused as version_unreadable — even though the published row still holds the last good number for the same path", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    await fm.backendAvailability.refresh(["grok"], { force: true });
    expect(fm.backendAvailability.get("grok")?.version).toBe("1.0.70");             // what the page's snapshot says
    writeGrok("no version here");                                                    // the binary at the same path is replaced; its version cannot be read
    await fm.backendAvailability.refresh(["grok"], { force: true });
    expect(fm.backendAvailability.get("grok")?.version, "the picker's fail-open snapshot keeps the old number (unchanged behaviour)").toBe("1.0.70");
    const update = vi.fn();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ refused: "version_unreadable" });
    expect(update).not.toHaveBeenCalled();
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("the positive control: a fresh, successful reading of the executable that resolves now lets the update start, from that version", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    await fm.backendAvailability.refresh(["grok"], { force: true });
    writeGrok("1.0.72");                                                             // replaced in place, readable: the update goes from what is there NOW
    const update = vi.fn<(from: string | null, target: string | null) => void>();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ started: true });
    expect(update).toHaveBeenCalledWith("1.0.72", "1.0.77");
  });
  // AGEND-148 (Prism R3 on #3539, P2-3): the admission decides on the NEWEST observation. The old order read freshVersion, then awaited a forced refresh (a second probe, published) and
  // still decided with the earlier number — a Grok upgraded to 1.0.78 meanwhile was "updated" to the audited 1.0.77.
  it("a newer version observed while the update is prepared is not discarded: 1.0.70 first, 1.0.78 after the refresh — refused as up_to_date, nothing opens", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    const reads = vi.spyOn(hostAvailabilityProbes, "version");
    reads.mockReset();
    reads.mockImplementationOnce(async () => "1.0.70").mockImplementation(async () => "1.0.78");   // time-ordered observations of the one executable
    const update = vi.fn();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ refused: "up_to_date" });
    expect(update).not.toHaveBeenCalled();
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("the control: the later of the two reads decides in the other direction too (1.0.78 first, then 1.0.70) and the update starts from 1.0.70", async () => {
    writeGrok("1.0.78"); onPath();
    const { fm, reporter } = fleet();
    const reads = vi.spyOn(hostAvailabilityProbes, "version");
    reads.mockReset();
    reads.mockImplementationOnce(async () => "1.0.78").mockImplementation(async () => "1.0.70");
    const update = vi.fn<(from: string | null, target: string | null) => void>();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ started: true });
    expect(update).toHaveBeenCalledWith("1.0.70", "1.0.77");
  });
  it("freshVersion is not a published value: no executable, or no answer, is null; nothing is cached", async () => {
    const { fm } = fleet();
    rmSync(join(profileBin, "grok"));
    expect(await fm.backendAvailability.freshVersion("grok")).toBeNull();
    expect(await fm.backendAvailability.freshVersion("not-a-backend")).toBeNull();
  });
  it("a CLI that sits only in its installer's directory (~/.grok/bin, not on any PATH) is installed: the update starts, as the Accounts page said it could", async () => {
    writeGrok("1.0.70");                                    // in ~/.grok/bin …
    rmSync(join(home, ".bash_profile"));                    // … which no login shell adds to PATH here
    const { fm, reporter } = fleet();
    const update = vi.fn<(from: string | null, target: string | null) => void>();
    expect(await fm.startWebInstall("grok", { ...reporter(), update }, undefined, "update")).toEqual({ started: true });
    expect(update).toHaveBeenCalledWith("1.0.70", "1.0.77");
    expect(fakeSessions).toHaveLength(1);
  });
  it("a CLI that is not installed anywhere is refused as not_installed; one that updates itself with no exception, or that is not a CLI, as unsupported", async () => {
    rmSync(join(profileBin, "grok"));                       // not in the installer's directory, not on any PATH
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter(), undefined, "update")).toEqual({ refused: "not_installed" });
    expect(await fm.startWebInstall("antigravity", reporter(), undefined, "update")).toEqual({ refused: "not_installed" });     // AGEND-153: it has an update (the named exception); there is just no copy here
    for (const backend of ["muse", "rm -rf /", "gemini"]) expect(await fm.startWebInstall(backend, reporter(), undefined, "update"), backend).toEqual({ refused: "unsupported" });
    expect(fakeSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
  it("one window: an update during an install (or another update) is refused as busy, never queued", async () => {
    writeGrok("1.0.70"); onPath();
    const { fm, reporter } = fleet();
    expect(await fm.startWebInstall("grok", reporter(), undefined, "update")).toEqual({ started: true });
    expect(await fm.startWebInstall("grok", reporter(), undefined, "update")).toEqual({ refused: "busy" });
    expect(await fm.startWebInstall("codex", reporter())).toEqual({ refused: "busy" });
    expect(fakeSessions).toHaveLength(1);
  });
  it("an install is still an install: no update call, no from/to", async () => {
    const { fm, reporter } = fleet();
    const update = vi.fn();
    expect(await fm.startWebInstall("grok", { ...reporter(), update })).toEqual({ started: true });
    expect(update).not.toHaveBeenCalled();
    expect(fakeSessions[0]!.flow.command).toContain("https://x.ai/cli/install.sh | bash");
    expect(fakeSessions[0]!.flow.command).not.toContain("bash -s 1.0.77");
  });
});
